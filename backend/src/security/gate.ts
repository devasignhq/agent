// Merge-gate publishing: the "devasign/security" check-run posted on open PR
// head SHAs. The check fails while the gate computed from the repo's findings
// (policy.ts computeGate) fails, so a maintainer who marks it Required gets
// real merge blocking. Two publish paths keep shas fresh:
//   - publishGateForRepo: after every completed audit, blocking-set state
//     change, or policy save — republished across ALL open PRs.
//   - publishGateForPR: from the review pipeline as a PR's own review lands, so
//     a PR that introduces a critical fails on its own head immediately.
// Both paths are Pro/Max — the check-run is part of the security feature, so a
// Free repo never gets one. Gating inside the two publishers (rather than at
// each call site) means every caller is covered by construction.
import { securityScanBlocked } from "../billing/plans.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { gh } from "../github/app.js";
import type { Installation, PRReview, Repository } from "../types.js";
import { computeGate, effectiveSecurityPolicy, type GateResult } from "./policy.js";

export const GATE_CHECK_NAME = "devasign/security";

type OpenPR = { number: number; head: { sha: string } };

// Latest review row per open PR number — the R2 inputs.
function latestReviewsFor(repoId: string, prNumbers: number[]): PRReview[] {
  const wanted = new Set(prNumbers);
  const latest = new Map<number, PRReview>();
  for (const r of db.filter("prReviews", (r) => r.repoId === repoId)) {
    if (!wanted.has(r.prNumber)) continue;
    const cur = latest.get(r.prNumber);
    if (!cur || r.updatedAt > cur.updatedAt) latest.set(r.prNumber, r);
  }
  return [...latest.values()];
}

export function computeGateForRepo(repo: Repository, openReviews: PRReview[]): GateResult {
  return computeGate({
    findings: db.filter("securityFindings", (f) => f.repoId === repo.id),
    openReviews,
    policy: effectiveSecurityPolicy(repo),
  });
}

function gateOutput(repo: Repository, gate: GateResult): { title: string; summary: string } {
  if (gate.verdict === "pass") {
    return {
      title: "Security gate passed",
      summary:
        "All required security gate rules pass.\n\n" +
        `Details: ${config.webOrigin}/security/gate`,
    };
  }
  const blocking = db
    .filter("securityFindings", (f) => gate.blockingFindingIds.includes(f.id))
    .slice(0, 10);
  const lines = blocking.map(
    (f) =>
      `- **${f.severity}** ${f.title} (\`${f.path}${f.line ? `:${f.line}` : ""}\`) — ${(f.confidence || "needs_human").replace("_", " ")}`
  );
  const failedRules = gate.rules.filter((r) => r.required && !r.pass);
  return {
    title: "Security gate blocked",
    summary:
      failedRules.map((r) => `✗ ${r.label} — ${r.count} found`).join("\n") +
      (lines.length ? `\n\n${lines.join("\n")}` : "") +
      `\n\nReview and resolve on the Security page: ${config.webOrigin}/security/gate`,
  };
}

async function postCheckRun(
  install: Installation,
  repo: Repository,
  headSha: string,
  gate: GateResult
): Promise<void> {
  await gh(install.installationId, `/repos/${repo.owner}/${repo.name}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: GATE_CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion: gate.verdict === "pass" ? "success" : "failure",
      output: gateOutput(repo, gate),
    }),
    headers: { "Content-Type": "application/json" },
  });
}

// Republish the gate across every open PR. Best-effort throughout: a GitHub
// hiccup on one sha must not sink the audit run that called us.
export async function publishGateForRepo(repo: Repository): Promise<void> {
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return; // dev / unattached repo — nothing to publish to
  if (securityScanBlocked(install.userId)) return;
  const policy = effectiveSecurityPolicy(repo);
  if (!policy.triggers.onPrPush) return;
  let open: OpenPR[] = [];
  try {
    open = await gh<OpenPR[]>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=100`
    );
  } catch (err) {
    console.warn(`[security] gate: listing open PRs for ${repo.owner}/${repo.name} failed:`, err);
    return;
  }
  const gate = computeGateForRepo(repo, latestReviewsFor(repo.id, open.map((p) => p.number)));
  for (const pr of open) {
    try {
      await postCheckRun(install, repo, pr.head.sha, gate);
    } catch (err) {
      console.warn(`[security] gate: check-run on #${pr.number} failed:`, err);
    }
  }
}

// Publish the gate on one PR's head — called from the review pipeline right
// after a review lands, with the review row already carrying its
// securityFindings snapshot.
export async function publishGateForPR(args: {
  repo: Repository;
  install: Installation;
  review: PRReview;
}): Promise<void> {
  const { repo, install, review } = args;
  if (securityScanBlocked(install.userId)) return;
  const policy = effectiveSecurityPolicy(repo);
  if (!policy.triggers.onPrPush) return;
  const gate = computeGate({
    findings: db.filter("securityFindings", (f) => f.repoId === repo.id),
    openReviews: [review],
    policy,
  });
  try {
    await postCheckRun(install, repo, review.headSha, gate);
  } catch (err) {
    console.warn(`[security] gate: check-run on PR #${review.prNumber} failed:`, err);
  }
}
