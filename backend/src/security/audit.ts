// The security audit job: runs after every merge to the default branch (and on
// manual / nightly triggers), scans the security-relevant slice of the repo
// with the audit agent, and reconciles the results into the securityFindings
// collection. Inventory-first and cache-driven: the repo index supplies both
// the file inventory and the per-blob securityFlags gate, and a file whose
// securityScannedSha already matches its blob sha costs nothing.
import { securityScanBlocked } from "../billing/plans.js";
import { db } from "../db.js";
import { currentUsage, withUsage } from "../llm.js";
import { track } from "../statsig.js";
import { fetchBlob } from "../review/indexer.js";
import type { SecurityAuditJobPayload } from "../queue.js";
import type { Installation, RepoIndexEntry, Repository, SecurityScanRun, SecuritySeverity, User } from "../types.js";
import { AUDIT_MODEL, scanFile } from "./agent.js";
import { classifySurface } from "./fingerprint.js";
import { effectiveSecurityPolicy, isActiveState } from "./policy.js";
import { reconcileFile, type ReconcileCtx } from "./reconcile.js";
import { publishGateForRepo } from "./gate.js";

const CONCURRENCY = 4;
const MAX_FILES_PER_RUN = 500;
const LOG_CAP = 300;

// Append one terminal-log line to the run row. Each append is a db.update, so
// the SSE fan-out (live.ts) streams the log to any open gate view.
function logLine(runId: string, line: string): void {
  const row = db.find("securityScans", (r) => r.id === runId);
  if (!row) return;
  const log = [...row.log, { at: Date.now(), line }];
  db.update("securityScans", (r) => r.id === runId, {
    log: log.length > LOG_CAP ? log.slice(log.length - LOG_CAP) : log,
  });
}

function patchRun(runId: string, patch: Partial<SecurityScanRun>): void {
  db.update("securityScans", (r) => r.id === runId, patch);
}

function analyticsUser(userId: string | undefined): User | string | null {
  if (!userId) return null;
  return db.find("users", (u) => u.id === userId) ?? userId;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      try {
        await fn(item);
      } catch (err) {
        console.warn("[security] worker error:", err);
      }
    }
  });
  await Promise.all(workers);
}

export async function runSecurityAudit(payload: SecurityAuditJobPayload): Promise<void> {
  const repo = db.find("repositories", (r) => r.id === payload.repoId);
  const run = db.find("securityScans", (r) => r.id === payload.scanRunId);
  if (!repo || !run) {
    console.warn(`[security] audit skipped — missing ${!repo ? "repo" : "scan run"}`);
    if (run) patchRun(run.id, { status: "errored", error: "repo_not_found", finishedAt: Date.now() });
    return;
  }
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) {
    // Dev / unattached repo: no token to fetch blobs with. Complete as a no-op
    // so the run doesn't wedge in "queued".
    patchRun(run.id, { status: "completed", startedAt: Date.now(), finishedAt: Date.now() });
    logLine(run.id, "skipped — no installation token (dev mode)");
    return;
  }

  // Plan gate. Every enqueue path (manual, merge webhook, nightly sweep) funnels
  // through here, so this is the one place that has to hold — the callers gate
  // too, but only to avoid creating no-op run rows. Complete as a no-op rather
  // than error out so the row can never wedge in "queued".
  if (securityScanBlocked(install.userId)) {
    patchRun(run.id, { status: "completed", startedAt: Date.now(), finishedAt: Date.now() });
    logLine(run.id, "skipped — security audits are a Pro/Max feature");
    return;
  }

  const policy = effectiveSecurityPolicy(repo);
  const t0 = Date.now();
  patchRun(run.id, { status: "running", startedAt: t0 });
  logLine(
    run.id,
    `$ devasign security-audit ${repo.owner}/${repo.name} --trigger ${payload.trigger}` +
      (payload.pr ? ` --merge #${payload.pr.number}` : "")
  );

  try {
    await withUsage(async () => {
      // Whether any completed run exists decides full-vs-differential when the
      // caller didn't force full: the first audit sweeps everything owed.
      const hasPrior = !!db.find(
        "securityScans",
        (r) => r.repoId === repo.id && r.id !== run.id && r.status === "completed"
      );
      const full = payload.full || !hasPrior;

      const allEntries = db.filter("repoIndex", (e) => e.repoId === repo.id);
      const livePaths = new Set(allEntries.map((e) => e.path));

      // The repo index IS the file inventory: it supplies both the candidate
      // list and (below) the "does this file still exist" answer. With no
      // entries there is nothing to scan AND no way to tell a deleted file from
      // an unbuilt index — so a full run would resolve every finding on the
      // repo. Bail before either can happen; the index build that precedes an
      // audit (webhook enqueues index → audit, FIFO in the same bucket) will
      // have populated it by the time a real run reads it.
      if (allEntries.length === 0) {
        logLine(run.id, "skipped — repo index not built yet (nothing to scan)");
        patchRun(run.id, {
          status: "completed",
          finishedAt: Date.now(),
          stillOpen: db.filter(
            "securityFindings",
            (f) => f.repoId === repo.id && isActiveState(f.state)
          ).length,
        });
        return;
      }

      // Differential scope: only paths the merge touched.
      let scopePaths: Set<string> | null = null;
      if (!full && payload.changedPaths) {
        scopePaths = new Set([
          ...payload.changedPaths.added,
          ...payload.changedPaths.modified,
          ...payload.changedPaths.renamed.map((r) => r.to),
        ]);
      }

      // Inventory gate: a file is a candidate when its engine is enabled AND it
      // either carries securityFlags (the summariser marked it sensitive) or
      // sits on a surface whose risk is structural (deps manifests, infra).
      const candidates: RepoIndexEntry[] = [];
      let cacheHits = 0;
      for (const e of allEntries) {
        if (scopePaths && !scopePaths.has(e.path)) continue;
        const surface = classifySurface(e.path);
        if (!policy.engines[surface]) continue;
        const flagged = (e.securityFlags?.length ?? 0) > 0;
        if (!flagged && surface !== "deps" && surface !== "infra") continue;
        if (e.securityScannedSha === e.sha) {
          cacheHits++;
          continue;
        }
        candidates.push(e);
      }

      const capped = candidates.slice(0, MAX_FILES_PER_RUN);
      if (candidates.length > capped.length) {
        logLine(run.id, `! file cap: scanning ${capped.length} of ${candidates.length} owed files`);
      }
      logLine(
        run.id,
        `scope ${full ? "full" : "differential"} · ${allEntries.length} indexed · ` +
          `${capped.length} to scan · ${cacheHits} cache hits`
      );

      const origin = payload.pr
        ? { pr: payload.pr.number, sha: payload.pr.mergeSha, author: payload.pr.author }
        : { pr: null, sha: null, author: null };

      let filesScanned = 0;
      let introduced = 0;
      // Per-severity split of the run's new findings, for the dashboard chart.
      const introducedBySeverity: Partial<Record<SecuritySeverity, number>> = {};
      let resolved = 0;

      await runPool(capped, CONCURRENCY, async (entry) => {
        let content: string;
        try {
          content = await fetchBlob(repo, install, entry.path, entry.sha);
        } catch (err) {
          logLine(run.id, `! fetch failed ${entry.path}`);
          return;
        }
        if (!content) return;
        const detected = await scanFile({
          path: entry.path,
          content,
          repoContext:
            `flags: ${entry.securityFlags?.join(", ") || "(none)"} · ${entry.summary}`.slice(0, 500),
          engines: policy.engines,
        });
        if (detected === null) {
          // Scan failed — leave securityScannedSha alone so the file stays owed.
          logLine(run.id, `! scan failed ${entry.path}`);
          return;
        }
        // The secrets engine gates finding-level output (a secret can hide in
        // any file, so it can't be a file-level gate).
        const kept = policy.engines.secrets ? detected : detected.filter((d) => d.surface !== "secrets");
        const ctx: ReconcileCtx = {
          repoId: repo.id,
          path: entry.path,
          sha: entry.sha,
          now: Date.now(),
          model: AUDIT_MODEL,
          origin,
        };
        const existing = db.filter(
          "securityFindings",
          (f) => f.repoId === repo.id && f.path === entry.path
        );
        const result = reconcileFile({ existing, detected: kept, ctx });
        for (const row of result.insert) db.insert("securityFindings", row);
        for (const u of result.update) db.update("securityFindings", (f) => f.id === u.id, u.patch);
        db.update("repoIndex", (e) => e.id === entry.id, { securityScannedSha: entry.sha });
        filesScanned++;
        introduced += result.introduced;
        for (const row of result.insert) {
          introducedBySeverity[row.severity] = (introducedBySeverity[row.severity] ?? 0) + 1;
        }
        resolved += result.resolved;
        for (const row of result.insert) {
          logLine(run.id, `✗ ${row.severity.toUpperCase().padEnd(8)} ${row.path}${row.line ? `:${row.line}` : ""} — ${row.title}`);
        }
        if (result.resolved > 0) {
          logLine(run.id, `✓ ${result.resolved} finding(s) resolved in ${entry.path}`);
        }
      });

      // Findings in files that no longer exist. Differential runs resolve only
      // explicitly-removed paths; full runs resolve anything whose file left
      // the index (the tree walk already dropped those rows).
      const removedPaths = new Set<string>(
        full ? [] : (payload.changedPaths?.removed ?? [])
      );
      const now = Date.now();
      for (const f of db.filter("securityFindings", (x) => x.repoId === repo.id)) {
        if (!isActiveState(f.state)) continue;
        const gone = full ? !livePaths.has(f.path) : removedPaths.has(f.path);
        if (!gone) continue;
        db.update("securityFindings", (x) => x.id === f.id, {
          state: "resolved",
          resolvedAt: now,
          activity: [
            ...(f.activity ?? []),
            { at: now, kind: "resolved" as const, detail: "File removed from the default branch", actor: "audit-agent" },
          ].slice(-50),
        });
        resolved++;
        logLine(run.id, `✓ resolved (file removed): ${f.path} — ${f.title}`);
      }

      // Housekeeping across the repo's findings: demote the PREVIOUS run's
      // "new" rows (this run's inserts have lastSeenAt >= t0), wake expired
      // snoozes.
      for (const f of db.filter("securityFindings", (x) => x.repoId === repo.id)) {
        if (f.state === "new" && f.lastSeenAt < t0) {
          db.update("securityFindings", (x) => x.id === f.id, { state: "open" });
        } else if (f.state === "snoozed" && f.snoozeUntil != null && f.snoozeUntil <= now) {
          db.update("securityFindings", (x) => x.id === f.id, {
            state: "open",
            snoozeUntil: null,
            activity: [
              ...(f.activity ?? []),
              { at: now, kind: "state_change" as const, detail: "Snooze expired", actor: "audit-agent" },
            ].slice(-50),
          });
        }
      }

      const stillOpen = db.filter(
        "securityFindings",
        (f) => f.repoId === repo.id && isActiveState(f.state)
      ).length;
      const usage = currentUsage();
      const costUsd = usage ? Number(usage.costUsd.toFixed(4)) : 0;

      logLine(
        run.id,
        `done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${introduced} new · ${resolved} resolved · ${stillOpen} open`
      );
      patchRun(run.id, {
        status: "completed",
        finishedAt: Date.now(),
        filesScanned,
        cacheHits,
        introduced,
        introducedBySeverity,
        resolved,
        stillOpen,
        costUsd,
      });

      const auditUser = analyticsUser(install.userId);
      if (auditUser) {
        track(auditUser, "security audit ran", {
          repo: `${repo.owner}/${repo.name}`,
          trigger: payload.trigger,
          full,
          files_scanned: filesScanned,
          cache_hits: cacheHits,
          introduced,
          resolved,
          still_open: stillOpen,
          duration_ms: Date.now() - t0,
          est_cost_usd: costUsd,
          model: AUDIT_MODEL,
        });
      }
    });

    // Republish the merge gate now that the finding set changed. Best-effort —
    // the audit itself already completed.
    try {
      const freshRepo = db.find("repositories", (r) => r.id === repo.id);
      if (freshRepo) await publishGateForRepo(freshRepo);
    } catch (err) {
      console.warn("[security] gate republish failed:", err);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[security] audit ${repo.owner}/${repo.name} failed:`, err);
    patchRun(run.id, { status: "errored", error: msg, finishedAt: Date.now() });
    logLine(run.id, `✗ audit errored: ${msg.slice(0, 200)}`);
  }
}
