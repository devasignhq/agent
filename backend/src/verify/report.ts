// The verification surfaces: the "### Verification" section of the review
// comment (marker-delimited so it can be spliced later) and the
// "DevAsign · Verify" check run. Same data feeds GET /v1/runs/{id}.
import { db } from "../db.js";
import { config } from "../config.js";
import { gh, updatePRComment } from "../github/app.js";
import type { Criterion, PRReview, Repository, VerifyArtifact, VerifyPlan, VerifyRun } from "../types.js";
import type { RunnerResult } from "./contract.js";
import { hasRunnerEvidence, updateRun } from "./runs.js";

export const VERIFICATION_START = "<!-- devasign:verification -->";
export const VERIFICATION_END = "<!-- /devasign:verification -->";
export const REPLY_LINE = "Reply to this comment or mention @devasign to adjust the criteria or re-run.";
export const VERIFY_CHECK_NAME = "DevAsign · Verify";

export type VerificationRowVerdict = "pass" | "fail" | "unverifiable" | "pending";

export type VerificationRow = {
  id: string;
  text: string;
  kind: "code" | "ui" | "unverifiable";
  verdict: VerificationRowVerdict;
  reason: string;
  testName?: string;
  level?: string;
  origin?: "existing" | "generated";
  recording?: { artifactId: string; expired: boolean } | null;
  attempts?: number;
  flaky?: boolean;
  retired?: boolean;
  evidence: Array<{ artifactId: string; kind: VerifyArtifact["kind"]; expired: boolean }>;
  deepLink: string;
};

export type VerificationState =
  | "pending"
  | "planning"
  | "setup_pending"
  | "completed"
  | "skipped"
  | "disabled"
  | "failed"
  | "timed_out"
  | "lost";

export type VerificationView = {
  state: VerificationState;
  runId: string | null;
  reviewId: string;
  runUrl: string;
  nudge?: string;
  error?: string | null;
  rows: VerificationRow[];
  counts: { pass: number; fail: number; unverifiable: number; pending: number };
  tests: { generated: number; existing: number };
};

export function runDeepLink(reviewId: string, runId: string | null, criterionId?: string): string {
  const base = `${config.webOrigin.replace(/\/+$/, "")}/reviews/${reviewId}`;
  const q = new URLSearchParams();
  if (runId) q.set("run", runId);
  if (criterionId) q.set("criterion", criterionId);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

function isVerifiable(c: Criterion): boolean {
  return (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy;
}

export function buildVerificationView(args: {
  run: VerifyRun | null;
  review: Pick<PRReview, "id">;
  repo: Repository;
  criteria: Criterion[];
  plan?: VerifyPlan | null;
  results?: RunnerResult[] | null;
  artifacts?: VerifyArtifact[];
}): VerificationView {
  const { run, review, repo } = args;
  const runId = run?.id ?? null;
  const plan = args.plan ?? (run?.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null);
  const results =
    args.results ?? (run?.resultsId ? db.find("verifyResults", (r) => r.id === run.resultsId)?.payload.results ?? null : null);
  const artifacts = args.artifacts ?? (run ? db.filter("verifyArtifacts", (a) => a.runId === run.id) : []);
  const now = Date.now();

  let state: VerificationState;
  let nudge: string | undefined;
  if (!run) state = "pending";
  else if (run.status === "skipped") state = run.skipReason === "verify_disabled" ? "disabled" : "skipped";
  else if (run.status === "planning") state = "planning";
  else if (run.status === "completed") state = "completed";
  else if (run.status === "failed") state = "failed";
  else if (run.status === "lost") state = "lost";
  else if ((run.status === "awaiting_runner" || run.status === "timed_out" || run.status === "setup_pending") && !hasRunnerEvidence(repo)) {
    state = "setup_pending";
    const prNumber = repo.verify?.onboarding.prNumber;
    nudge = prNumber
      ? `Verification isn't running yet — merge #${prNumber} to enable.`
      : "Verification isn't running yet — add the DevAsign verify workflow to this repo to enable.";
  } else if (run.status === "timed_out") state = "timed_out";
  else state = "pending";

  const verdictById = new Map((run?.verdicts ?? []).map((v) => [v.criterionId, v]));
  const testsByCriterion = new Map<string, VerifyPlan["tests"]>();
  for (const t of plan?.tests ?? []) for (const cid of t.criterionIds) testsByCriterion.set(cid, [...(testsByCriterion.get(cid) ?? []), t]);
  const resultsByCriterion = new Map<string, RunnerResult[]>();
  for (const r of results ?? []) for (const cid of r.criterionIds) resultsByCriterion.set(cid, [...(resultsByCriterion.get(cid) ?? []), r]);
  const artifactById = new Map(artifacts.map((a) => [a.id, a]));

  const rows: VerificationRow[] = [];
  for (const c of args.criteria) {
    if (!isVerifiable(c)) continue;
    const v = verdictById.get(c.id);
    const tests = testsByCriterion.get(c.id) ?? [];
    const crs = resultsByCriterion.get(c.id) ?? [];
    const evidenceIds = new Set<string>();
    for (const ref of v?.evidenceRefs ?? []) if (ref.artifactId) evidenceIds.add(ref.artifactId);
    for (const a of artifacts) if (a.criterionIds.includes(c.id) || crs.some((r) => r.artifactIds.includes(a.id) || r.testId === a.testId)) evidenceIds.add(a.id);
    const evidence = [...evidenceIds]
      .map((id) => artifactById.get(id))
      .filter((a): a is VerifyArtifact => !!a)
      .map((a) => ({ artifactId: a.id, kind: a.kind, expired: a.state === "expired" || a.expiresAt <= now }));
    const video = evidence.find((e) => e.kind === "video");
    let verdict: VerificationRowVerdict = "pending";
    let reason = "";
    if (v) {
      verdict = v.verdict;
      reason = v.reason;
    } else if (state === "completed" || state === "failed" || state === "lost" || state === "timed_out") {
      verdict = "unverifiable";
      reason =
        state === "completed"
          ? "no test ran for this criterion"
          : run?.error || (state === "timed_out" ? "the runner did not report results" : "the run did not finish");
    } else if (state === "skipped" || state === "disabled") {
      verdict = "unverifiable";
      reason = state === "disabled" ? "verification is turned off for this repo" : "not verifiable in CI";
    } else {
      const planned = plan?.unverifiable.find((u) => u.criterionId === c.id);
      if (planned) {
        verdict = "unverifiable";
        reason = planned.reason;
      }
    }
    const primary = tests[0];
    rows.push({
      id: c.id,
      text: c.text,
      kind: c.kind ?? "code",
      verdict,
      reason,
      testName: primary?.path,
      level: primary?.level,
      origin: primary?.origin,
      recording: video ? { artifactId: video.artifactId, expired: video.expired } : null,
      attempts: crs.reduce((m, r) => Math.max(m, r.attempts.length), 0) || undefined,
      flaky: v?.flaky,
      retired: v?.retired,
      evidence,
      deepLink: runDeepLink(review.id, runId, c.id),
    });
  }
  const counts = { pass: 0, fail: 0, unverifiable: 0, pending: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  return {
    state,
    runId,
    reviewId: review.id,
    runUrl: runDeepLink(review.id, runId),
    nudge,
    error: run?.error ?? null,
    rows,
    counts,
    tests: {
      generated: plan?.tests.filter((t) => t.origin === "generated").length ?? 0,
      existing: plan?.tests.filter((t) => t.origin === "existing").length ?? 0,
    },
  };
}

function stateLine(view: VerificationView): string {
  switch (view.state) {
    case "setup_pending":
      return view.nudge || "Verification isn't running yet.";
    case "planning":
      return "Planning verification tests — this section updates when results land.";
    case "pending":
      return `Verification tests are running in your CI (${view.tests.generated} generated, ${view.tests.existing} existing) — this section updates when results land.`;
    case "completed":
      return `${view.counts.pass} passed, ${view.counts.fail} failed, ${view.counts.unverifiable} unverifiable. Each verdict below links to its evidence.`;
    case "skipped":
      return "No criteria on this PR can be verified by a test.";
    case "disabled":
      return "Verification is turned off in this repo's workflow.";
    case "timed_out":
      return "The runner did not report results in time — every criterion is unverifiable for this push.";
    case "lost":
    case "failed":
      return `Verification could not complete${view.error ? ` (${view.error})` : ""} — criteria are unverifiable for this push, not failed.`;
  }
}

function verdictWord(v: VerificationRowVerdict): string {
  return v === "pass" ? "pass" : v === "fail" ? "FAIL" : v === "unverifiable" ? "unverifiable" : "pending";
}

export function formatVerificationSection(view: VerificationView): string {
  const lines: string[] = [VERIFICATION_START, "### Verification", stateLine(view), ""];
  for (const r of view.rows) {
    const parts = [`**${r.id}.** ${r.text} — **${verdictWord(r.verdict)}**`];
    if (r.reason) parts.push(r.reason);
    if (r.testName) parts.push(`${r.level ?? "test"}${r.origin === "existing" ? " (existing)" : ""} \`${r.testName}\``);
    if (r.recording) parts.push(r.recording.expired ? `[recording expired](${r.deepLink})` : `[▶ Watch recording](${r.deepLink})`);
    if (r.flaky && r.attempts) parts.push(`[all ${r.attempts} attempts](${r.deepLink})`);
    if (!r.recording && r.verdict !== "pending") parts.push(`[details](${r.deepLink})`);
    lines.push(`- ${parts.join(" · ")}`);
  }
  if (view.rows.length) lines.push("");
  lines.push(REPLY_LINE, VERIFICATION_END);
  return lines.join("\n");
}

export function spliceVerificationSection(body: string, section: string): string {
  const start = body.indexOf(VERIFICATION_START);
  const end = body.indexOf(VERIFICATION_END);
  if (start >= 0 && end > start) {
    return body.slice(0, start) + section + body.slice(end + VERIFICATION_END.length);
  }
  return `${body.replace(/\s+$/, "")}\n\n${section}`;
}

export function verifyCheckRunPayload(view: VerificationView, headSha: string, opts: { doctor?: { code: string; message: string } | null; adoptRunId?: string | null } = {}) {
  let conclusion: "success" | "failure" | "neutral";
  let title: string;
  if (opts.doctor) {
    conclusion = "neutral";
    title = "Setup needs attention";
  } else if (view.state === "completed") {
    if (view.counts.fail > 0) {
      conclusion = "failure";
      title = `${view.counts.fail} of ${view.rows.length} criteria failed verification`;
    } else if (view.counts.unverifiable > 0) {
      conclusion = "neutral";
      title = `${view.counts.pass} passed, ${view.counts.unverifiable} unverifiable`;
    } else {
      conclusion = "success";
      title = `All ${view.rows.length} criteria verified`;
    }
  } else if (view.state === "setup_pending") {
    conclusion = "neutral";
    title = "Setup pending";
  } else if (view.state === "pending" || view.state === "planning") {
    conclusion = "neutral";
    title = "Verification pending";
  } else if (view.state === "disabled" || view.state === "skipped") {
    conclusion = "neutral";
    title = view.state === "disabled" ? "Verification disabled" : "Nothing to verify";
  } else {
    conclusion = "neutral";
    title = view.state === "timed_out" ? "Verification timed out" : "Verification did not complete";
  }
  const text = [
    stateLine(view),
    "",
    ...view.rows.map((r) => {
      const bits = [`${verdictWord(r.verdict)} — ${r.id}. ${r.text}`];
      if (r.testName) bits.push(`test: ${r.testName}`);
      if (r.reason) bits.push(r.reason);
      bits.push(r.recording ? `[watch recording](${r.deepLink})` : `[details](${r.deepLink})`);
      return `- ${bits.join(" · ")}`;
    }),
    "",
    REPLY_LINE,
  ].join("\n");
  // GitHub caps identifier at 20 chars: "adopt:" + 14 chars of the run id.
  const actions = opts.adoptRunId ? [{ label: "Adopt tests", description: "Open a PR adding the generated tests", identifier: `adopt:${opts.adoptRunId.slice(0, 14)}` }] : [];
  return {
    name: VERIFY_CHECK_NAME,
    head_sha: headSha,
    status: "completed" as const,
    conclusion,
    output: { title, summary: opts.doctor ? `${opts.doctor.message} — criteria are unverifiable, not failed.` : stateLine(view), text: text.slice(0, 60_000) },
    ...(actions.length ? { actions } : {}),
  };
}

export async function postVerifyCheckRun(
  install: { installationId: number },
  repo: { owner: string; name: string },
  review: Pick<PRReview, "headSha">,
  view: VerificationView
): Promise<{ id: number; url?: string } | null> {
  try {
    const run = view.runId ? db.find("verifyRuns", (r) => r.id === view.runId) : null;
    const plan = run?.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
    const adoptable = run?.status === "completed" && (plan?.tests ?? []).some((t) => t.origin === "generated" && t.content);
    const res = await gh<{ id?: number; html_url?: string }>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/check-runs`,
      {
        method: "POST",
        body: JSON.stringify(verifyCheckRunPayload(view, review.headSha, { doctor: run?.doctor ?? null, adoptRunId: adoptable ? run!.id : null })),
        headers: { "Content-Type": "application/json" },
      }
    );
    const out = typeof res?.id === "number" ? { id: res.id, url: res.html_url } : null;
    if (out && view.runId) {
      const run = db.find("verifyRuns", (r) => r.id === view.runId);
      if (run) updateRun(run.id, { report: { ...(run.report || {}), checkRunId: out.id, checkRunUrl: out.url }, timings: { ...run.timings, reportedAt: Date.now() } });
    }
    return out;
  } catch (err) {
    console.warn("[verify] failed to post check run:", err);
    return null;
  }
}

/** Late update: re-post the check run and splice the section into the existing comment. */
export async function rerenderReport(runId: string): Promise<void> {
  const run = db.find("verifyRuns", (r) => r.id === runId);
  if (!run) return;
  const review = db.find("prReviews", (r) => r.id === run.reviewId);
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  if (!review || !repo) return;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return;
  const view = buildVerificationView({ run, review, repo, criteria: review.criteria });
  await postVerifyCheckRun(install, repo, review, view);
  const commentId = review.progressCommentId;
  if (commentId == null || review.progressCommentSha !== run.sha) return;
  try {
    const current = await gh<{ body?: string }>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`
    );
    if (!current || typeof current.body !== "string") return;
    const next = spliceVerificationSection(current.body, formatVerificationSection(view));
    if (next === current.body) return;
    const ok = await updatePRComment(install.installationId, repo.owner, repo.name, commentId, next);
    if (ok) updateRun(run.id, { report: { ...(run.report || {}), commentId } });
  } catch (err) {
    console.warn("[verify] failed to update the review comment:", err);
  }
}
