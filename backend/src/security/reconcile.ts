// Reconciliation between what the audit agent detected in a file and the
// findings already stored for that file. This is where fingerprints earn their
// keep: a re-detection updates the existing row in place (keeping issue links,
// assignee, accepted-risk verdicts), a disappearance resolves it, and only a
// genuinely new fingerprint mints a row. Pure core — the audit job applies the
// returned insert/update lists to the db.
import { v4 as uuid } from "uuid";
import type { SecurityFinding, SecurityFindingEvent, SecurityVerification } from "../types.js";
import { fingerprintFinding } from "./fingerprint.js";
import { isActiveState } from "./policy.js";
import type { AgentFinding } from "./agent.js";
import { describeVerdict } from "./verify.js";

// A detection the audit annotated with its verifier verdict and, when a
// maintainer ruling authorises auto-suppressing it, that ruling
// (security/precedent.ts). Carried alongside the finding so the matching rules
// stay in one pure module.
export type DetectedFinding = AgentFinding & {
  verification: SecurityVerification;
  scannerConfidence?: SecurityFinding["scannerConfidence"];
  suppressedBy?: {
    precedentId: string;
    action: "false_positive" | "accepted";
    note: string;
  };
};

export type ReconcileCtx = {
  repoId: string;
  path: string;
  sha: string;   // blob sha the scan ran against
  now: number;
  model: string;
  origin: { pr?: number | null; sha?: string | null; author?: string | null };
};

export type ReconcileResult = {
  insert: SecurityFinding[];
  update: Array<{ id: string; patch: Partial<SecurityFinding> }>;
  remove: string[];   // unverified rows no longer detected — never real, nothing references them
  introduced: number; // confirmed rows inserted (excluding auto-suppressed ones)
  heldBack: number;   // detections that ended this pass in state "unverified"
  demoted: number;    // previously active rows the verifier moved to "unverified"
  resolved: number;   // active rows no longer detected
  // Precedent ids that muted a fresh detection this pass, so the caller can
  // bump their suppressedCount — the health metric behind the rulings ledger.
  appliedPrecedentIds: string[];
};

const ACTIVITY_CAP = 50;

function pushEvent(
  activity: SecurityFindingEvent[] | undefined,
  ev: SecurityFindingEvent
): SecurityFindingEvent[] {
  const list = [...(activity ?? []), ev];
  return list.length > ACTIVITY_CAP ? list.slice(list.length - ACTIVITY_CAP) : list;
}

const HUMAN_VERDICT: SecurityFinding["state"][] = ["accepted", "false_positive"];

export function reconcileFile(args: {
  existing: SecurityFinding[];  // stored findings for this repoId+path
  detected: DetectedFinding[];  // agent output for this file at ctx.sha
  ctx: ReconcileCtx;
}): ReconcileResult {
  const { existing, detected, ctx } = args;
  const insert: SecurityFinding[] = [];
  const update: ReconcileResult["update"] = [];
  const remove: string[] = [];
  let introduced = 0;
  let heldBack = 0;
  let demoted = 0;
  let resolved = 0;
  const appliedPrecedentIds: string[] = [];

  const byFingerprint = new Map(existing.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();

  for (const d of detected) {
    const fingerprint = fingerprintFinding({
      repoId: ctx.repoId,
      path: ctx.path,
      class: d.class,
      slug: d.slug || d.title,
      symbol: d.symbol,
    });
    // Two model findings can collapse to one fingerprint (same symbol+class);
    // keep the first — they are the same underlying issue.
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const v = d.verification;
    const confirmed = v.status === "confirmed";
    const verdictEvent: SecurityFindingEvent = {
      at: ctx.now,
      kind: "verified",
      detail: confirmed ? `Verified — ${describeVerdict(v).replace(/^verified — /, "")}` : `Held back — ${describeVerdict(v).replace(/^(held back|refuted) — /, "")}`,
      actor: "audit-agent",
    };
    const prior = byFingerprint.get(fingerprint);
    if (!prior) {
      // A maintainer already ruled on this exact issue in this repo, so the row
      // is born suppressed: it goes straight to the rulings ledger instead of
      // the active list, and — because neither state is in GATING_STATES — it
      // can never flip a merge gate. The row still exists, so the suppression
      // is visible and one revoke can bring it back.
      const sup = d.suppressedBy;
      const state: SecurityFinding["state"] = sup ? sup.action : confirmed ? "new" : "unverified";
      insert.push({
        id: uuid(),
        fingerprint,
        repoId: ctx.repoId,
        path: ctx.path,
        ...(d.line != null ? { line: d.line } : {}),
        ...(d.symbol ? { symbol: d.symbol } : {}),
        class: d.class,
        ...(d.cwe ? { cwe: d.cwe } : {}),
        surface: d.surface,
        severity: d.severity,
        confidence: d.confidence,
        ...(d.scannerConfidence ? { scannerConfidence: d.scannerConfidence } : {}),
        verification: v,
        title: d.title,
        concern: d.concern,
        ...(d.evidence ? { evidence: d.evidence } : {}),
        ...(d.dataflow ? { dataflow: d.dataflow } : {}),
        ...(d.exploitNarrative ? { exploitNarrative: d.exploitNarrative } : {}),
        ...(d.blastRadius ? { blastRadius: d.blastRadius } : {}),
        ...(d.invariant ? { invariant: d.invariant } : {}),
        ...(d.remediation ? { remediation: d.remediation } : {}),
        ...(d.regressionTest ? { regressionTest: d.regressionTest } : {}),
        state,
        ...(sup
          ? { suppressedByPrecedentId: sup.precedentId, stateReason: sup.note }
          : state === "unverified"
          ? { stateReason: describeVerdict(v) }
          : {}),
        introducedByPr: ctx.origin.pr ?? null,
        introducedSha: ctx.origin.sha ?? null,
        introducedByAuthor: ctx.origin.author ?? null,
        firstDetectedAt: ctx.now,
        lastSeenAt: ctx.now,
        detectedSha: ctx.sha,
        model: ctx.model,
        activity: [
          {
            at: ctx.now,
            kind: "detected",
            detail: ctx.origin.pr
              ? `Detected by security audit after merge of PR #${ctx.origin.pr}`
              : "Detected by security audit",
            actor: "audit-agent",
          },
          verdictEvent,
          ...(sup
            ? [
                {
                  at: ctx.now,
                  kind: "state_change" as const,
                  detail: `Auto-suppressed by your earlier ruling — ${sup.note}`,
                  actor: "audit-agent",
                },
              ]
            : []),
        ],
      });
      if (sup) appliedPrecedentIds.push(sup.precedentId);
      else if (confirmed) introduced++;
      else heldBack++;
      continue;
    }

    // Re-detection of a known finding.
    const base: Partial<SecurityFinding> = {
      lastSeenAt: ctx.now,
      detectedSha: ctx.sha,
      verification: v,
      ...(d.scannerConfidence ? { scannerConfidence: d.scannerConfidence } : {}),
    };
    if (HUMAN_VERDICT.includes(prior.state)) {
      // Suppressed by a human verdict — refresh the sighting, never resurface.
      update.push({ id: prior.id, patch: base });
      continue;
    }

    if (!confirmed) {
      if (prior.state === "resolved") {
        // Not confirmed → nothing to reopen; keep the sighting fresh.
        update.push({ id: prior.id, patch: base });
        continue;
      }
      if (prior.issueNumber != null || prior.bountyId != null) {
        // A human already acted on it; record the disagreement, keep the state.
        update.push({ id: prior.id, patch: { ...base, activity: pushEvent(prior.activity, verdictEvent) } });
        continue;
      }
      const wasActive = prior.state !== "unverified";
      update.push({
        id: prior.id,
        patch: {
          ...base,
          severity: d.severity,
          confidence: d.confidence,
          state: "unverified",
          stateReason: describeVerdict(v),
          snoozeUntil: null,
          activity: pushEvent(prior.activity, verdictEvent),
        },
      });
      heldBack++;
      if (wasActive) demoted++;
      continue;
    }

    // Re-derived assessment wins: severity/confidence reflect the latest scan.
    const assessed: Partial<SecurityFinding> = {
      ...base,
      ...(d.line != null ? { line: d.line } : {}),
      severity: d.severity,
      confidence: d.confidence,
      model: ctx.model,
    };

    if (prior.state === "unverified") {
      update.push({
        id: prior.id,
        patch: { ...assessed, state: "new", stateReason: null, activity: pushEvent(prior.activity, verdictEvent) },
      });
      introduced++;
      continue;
    }

    if (prior.state === "resolved") {
      update.push({
        id: prior.id,
        patch: {
          ...assessed,
          state: "open",
          resolvedAt: null,
          activity: pushEvent(prior.activity, {
            at: ctx.now,
            kind: "reopened",
            detail: "Re-detected after being resolved",
            actor: "audit-agent",
          }),
        },
      });
      continue;
    }

    // Active state (new/open/issue_created/bounty/fix_ready/snoozed): keep the
    // triage state, note a severity change when one happened.
    const sevChanged = prior.severity !== d.severity;
    update.push({
      id: prior.id,
      patch: {
        ...assessed,
        ...(sevChanged
          ? {
              activity: pushEvent(prior.activity, {
                at: ctx.now,
                kind: "redetected",
                detail: `Severity re-assessed: ${prior.severity} → ${d.severity}`,
                actor: "audit-agent",
              }),
            }
          : {}),
      },
    });
  }

  // Anything active in THIS file that this scan did not re-detect is resolved.
  // Scoped to the scanned file so a differential run never resolves findings in
  // files it didn't look at. Unverified rows simply go away.
  for (const f of existing) {
    if (seen.has(f.fingerprint)) continue;
    if (f.state === "unverified") {
      remove.push(f.id);
      continue;
    }
    if (!isActiveState(f.state)) continue;
    update.push({
      id: f.id,
      patch: {
        state: "resolved",
        resolvedAt: ctx.now,
        activity: pushEvent(f.activity, {
          at: ctx.now,
          kind: "resolved",
          detail: ctx.origin.pr
            ? `No longer detected after merge of PR #${ctx.origin.pr}`
            : "No longer detected",
          actor: "audit-agent",
        }),
      },
    });
    resolved++;
  }

  return { insert, update, remove, introduced, heldBack, demoted, resolved, appliedPrecedentIds };
}
