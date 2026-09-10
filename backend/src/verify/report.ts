// The verification surfaces: the "## Tests by DevAsign" conversation comment,
// the "DevAsign · Verify" check run, and the marker-delimited "### Verification"
// section the comment is built around. Same data feeds GET /v1/runs/{id}.
//
// The section used to be spliced into the REVIEW comment; it now lives in its own
// comment, so the two surfaces can land at different times (the verifier finishes
// well after the review). spliceVerificationSection and its markers are kept: they
// delimit the rows inside the new comment, and they are also what strips the
// legacy block out of review comments written before this change.
import { db } from "../db.js";
import { config } from "../config.js";
import { getPRComment, gh, postPRCommentReturningId, updatePRComment } from "../github/app.js";
import { getPRReviewBody, updatePRReview } from "../github/review-comments.js";
import { formatCardHeader, spliceCardHeader } from "../review/comment.js";
import { codeFence } from "../review/render.js";
import type { Criterion, PRReview, Repository, VerifyArtifact, VerifyPlan, VerifyRun } from "../types.js";
import type { RunnerResult } from "./contract.js";
import { hasRunnerEvidence, updateRun } from "./runs.js";

export const VERIFICATION_START = "<!-- devasign:verification -->";
export const VERIFICATION_END = "<!-- /devasign:verification -->";
export const REPLY_LINE = "Reply to this comment or mention @devasign to adjust the criteria or re-run.";
export const VERIFY_CHECK_NAME = "DevAsign · Verify";
// GitHub caps a requested_action identifier at 20 chars: "adopt:" + this many
// chars of the run id. The webhook requires the same length before it looks up.
export const ADOPT_PREFIX_LEN = 14;

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
  fixUrl?: string;
  evidence: Array<{ artifactId: string; kind: VerifyArtifact["kind"]; expired: boolean }>;
  deepLink: string;
};

export type VerificationState =
  | "pending"
  | "planning"
  | "fork"
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
  tests: { generated: number; existing: number; prAuthored: number };
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
  else if (run.status === "skipped") state = run.skipReason === "verify_disabled" ? "disabled" : run.skipReason === "fork_pr" ? "fork" : "skipped";
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
    const planned = plan?.unverifiable.find((u) => u.criterionId === c.id);
    let verdict: VerificationRowVerdict = "pending";
    let reason = "";
    if (v) {
      verdict = v.verdict;
      reason = v.reason;
    } else if (state === "completed" || state === "failed" || state === "lost" || state === "timed_out") {
      verdict = "unverifiable";
      reason =
        state === "completed"
          ? planned?.reason ?? "no test ran for this criterion"
          : run?.error || (state === "timed_out" ? "the runner did not report results" : "the run did not finish");
    } else if (state === "skipped" || state === "disabled" || state === "fork") {
      verdict = "unverifiable";
      reason = state === "disabled" ? "verification is turned off for this repo" : state === "fork" ? "not run on fork pull requests" : "not verifiable in CI";
    } else if (planned) {
      verdict = "unverifiable";
      reason = planned.reason;
    }
    const fixUrl = verdict === "unverifiable" ? v?.fixUrl ?? planned?.fixUrl : undefined;
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
      ...(fixUrl ? { fixUrl } : {}),
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
      prAuthored: plan?.prAuthoredTests?.length ?? 0,
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
    case "fork":
      return "Verification does not run on pull requests from forks — GitHub issues no OIDC token to a fork's workflow, so the runner cannot authenticate.";
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
  const lines: string[] = [VERIFICATION_START, "### Verification", stateLine(view)];
  // A test that ships inside the change cannot be evidence for it; say so rather
  // than let the count of verified criteria imply more independence than there is.
  if (view.tests.prAuthored)
    lines.push(
      `This PR adds or changes ${view.tests.prAuthored} test file${view.tests.prAuthored === 1 ? "" : "s"} of its own; ${view.tests.prAuthored === 1 ? "it was" : "they were"} not used as evidence.`
    );
  lines.push("");
  for (const r of view.rows) {
    const parts = [`**${r.id}.** ${r.text} — **${verdictWord(r.verdict)}**`];
    if (r.reason) parts.push(r.reason);
    if (r.fixUrl) parts.push(`[configure app start](${r.fixUrl})`);
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
  } else if (view.state === "disabled" || view.state === "skipped" || view.state === "fork") {
    conclusion = "neutral";
    title = view.state === "disabled" ? "Verification disabled" : view.state === "fork" ? "Not run on fork PRs" : "Nothing to verify";
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
      if (r.fixUrl) bits.push(`[configure app start](${r.fixUrl})`);
      bits.push(r.recording ? `[watch recording](${r.deepLink})` : `[details](${r.deepLink})`);
      return `- ${bits.join(" · ")}`;
    }),
    "",
    REPLY_LINE,
  ].join("\n");
  const actions = opts.adoptRunId ? [{ label: "Adopt tests", description: "Open a PR adding the generated tests", identifier: `adopt:${opts.adoptRunId.slice(0, ADOPT_PREFIX_LEN)}` }] : [];
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

/** The run whose state should be shown for a commit: the newest judged one, else the caller's. */
export function bestRunForSha(run: VerifyRun): VerifyRun {
  const judged = db
    .filter("verifyRuns", (r) => r.reviewId === run.reviewId && r.sha === run.sha && r.verdicts.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
  return judged[0] ?? run;
}

/** Late update: re-post the check run and the "Tests by DevAsign" comment. */
export async function rerenderReport(runId: string): Promise<void> {
  const settled = db.find("verifyRuns", (r) => r.id === runId);
  if (!settled) return;
  const review = db.find("prReviews", (r) => r.id === settled.reviewId);
  const repo = db.find("repositories", (r) => r.id === settled.repoId);
  if (!review || !repo) return;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return;
  // A run that never produced verdicts (re-run attempt, reaped timeout) must not
  // paint over an earlier run of the same commit that did. Judged evidence wins.
  const run = bestRunForSha(settled);
  const view = buildVerificationView({ run, review, repo, criteria: review.criteria });
  // Always the run's own commit: review.headSha may already point at a newer push.
  await postVerifyCheckRun(install, repo, { headSha: run.sha }, view);
  // Verification lives in its own comment now, so it no longer has to wait for
  // the review comment to exist, and a stale-sha review comment no longer
  // suppresses it. It is still keyed to the run's own sha.
  await upsertVerifyComment({
    install,
    repo,
    review,
    sha: run.sha,
    runId: run.id,
    view,
  });
  // The card's score and chips depend on these results, and the card usually
  // posted before they existed.
  await refreshCardHead({ install, repo, reviewId: review.id, sha: run.sha, view });
  // Reviews written before this change carry the old spliced block; strip it so
  // the PR doesn't show verification twice.
  if (review.progressCommentId != null) {
    await stripLegacyVerificationSection(install.installationId, repo, review.progressCommentId);
  }
}

const cardRefreshesInFlight = new Map<string, Promise<void>>();

// Re-render the marker-delimited head of the summary card with the finished
// verification. Targets the review that carries the card for this sha, or the
// conversation comment when the run fell back to it. Best-effort.
export async function refreshCardHead(args: {
  install: { installationId: number };
  repo: Repository;
  reviewId: string;
  sha: string;
  view: VerificationView;
}): Promise<void> {
  if (args.view.state !== "completed") return;
  const key = `${args.reviewId}:${args.sha}:card`;
  const inFlight = cardRefreshesInFlight.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    const { install, repo, sha, view } = args;
    const review = db.find("prReviews", (r) => r.id === args.reviewId);
    const head = review?.cardHead;
    if (!review || !head || head.sha !== sha) return;
    const target =
      review.summaryReviewId != null && review.summaryReviewSha === sha
        ? { kind: "review" as const, id: review.summaryReviewId }
        : review.progressCommentId != null && review.progressCommentSha === sha
        ? { kind: "comment" as const, id: review.progressCommentId }
        : null;
    if (!target) return;
    const body =
      target.kind === "review"
        ? await getPRReviewBody(install.installationId, repo.owner, repo.name, review.prNumber, target.id)
        : await getPRComment(install.installationId, repo.owner, repo.name, target.id);
    if (typeof body !== "string") return;
    const next = spliceCardHeader(body, formatCardHeader(head, view));
    if (next === null || next === body || next.length > 65_000) return;
    if (target.kind === "review") {
      await updatePRReview(install.installationId, repo.owner, repo.name, review.prNumber, target.id, next);
    } else {
      await updatePRComment(install.installationId, repo.owner, repo.name, target.id, next);
    }
  })();
  cardRefreshesInFlight.set(key, task);
  try {
    await task;
  } catch (err) {
    console.warn("[verify] failed to refresh the card head:", err);
  } finally {
    cardRefreshesInFlight.delete(key);
  }
}

// ─── The "Tests by DevAsign" comment ───────────────────────────────────────

export const TESTS_COMMENT_TITLE = "## Tests by DevAsign";

function testChips(view: VerificationView): string {
  const chips: string[] = [];
  if (view.counts.pass) chips.push(`✅ \`Passed (${view.counts.pass})\``);
  if (view.counts.fail) chips.push(`❌ \`Failed (${view.counts.fail})\``);
  if (view.counts.unverifiable) chips.push(`⚠️ \`Unverifiable (${view.counts.unverifiable})\``);
  if (view.counts.pending) chips.push(`⏳ \`Pending (${view.counts.pending})\``);
  if (!chips.length) chips.push("⚠️ `Nothing to verify`");
  return chips.join(" · ");
}

// One paste that tells an agent what to fix. Only the failures — an unverifiable
// criterion has no test to make pass, so asking for one would be noise.
function buildTestFixPrompt(view: VerificationView, repoFullName: string): string | null {
  const failed = view.rows.filter((r) => r.verdict === "fail");
  if (!failed.length) return null;
  const lines = [
    `You are helping fix failing verification tests in ${repoFullName}. Each item below is an ` +
      `acceptance criterion whose test ran and failed. Make the described behaviour hold, then ` +
      `make the named test pass. Don't change the test to match the code — the test encodes the ` +
      `requirement. Don't introduce changes beyond what's listed.`,
    "",
    "## Failing criteria",
    "",
  ];
  failed.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.text} (${r.id})`);
    if (r.testName) lines.push(`Test: \`${r.testName}\`${r.level ? ` (${r.level})` : ""}`);
    if (r.reason) lines.push(`Why it failed: ${r.reason}`);
    lines.push("");
  });
  lines.push("## Your task");
  lines.push(
    `Fix the ${failed.length} failing criteri${failed.length === 1 ? "on" : "a"} above, then run the ` +
      `named tests to confirm they pass.`
  );
  return lines.join("\n");
}

// Same shape as the review's summary card: title, chips, a short summary,
// per-item detail, one copyable prompt. Per-test detail is a <details> block
// rather than its own thread because a generated test file usually isn't part
// of the PR's diff, so there is nothing to anchor a review comment to. The
// score lives on the review card, which folds these results into the merge score.
export function formatTestsComment(view: VerificationView, repoFullName: string): string {
  const lines: string[] = [TESTS_COMMENT_TITLE, "", testChips(view), ""];
  if (view.state === "completed") {
    // One line of arithmetic, not two: stateLine's own count sentence would say
    // the same thing again directly underneath.
    const tail = [
      view.counts.fail ? `${view.counts.fail} failed` : "",
      view.counts.unverifiable ? `${view.counts.unverifiable} unverifiable` : "",
    ].filter(Boolean);
    lines.push(
      `${view.counts.pass} of ${view.rows.length} criteri${view.rows.length === 1 ? "on" : "a"} verified by tests` +
        (tail.length ? `, ${tail.join(", ")}.` : ".") +
        " Each verdict below links to its evidence."
    );
  } else {
    lines.push(stateLine(view));
  }
  if (view.tests.prAuthored) {
    lines.push(
      `This PR adds or changes ${view.tests.prAuthored} test file${view.tests.prAuthored === 1 ? "" : "s"} of its own; ` +
        `${view.tests.prAuthored === 1 ? "it was" : "they were"} not used as evidence.`
    );
  }

  lines.push("", VERIFICATION_START);
  for (const r of view.rows) {
    lines.push("", "<details>", `<summary>${r.id} — ${r.text} (${verdictWord(r.verdict)})</summary>`, "");
    lines.push(`**Verdict:** ${verdictWord(r.verdict)}`);
    if (r.reason) lines.push("", r.reason);
    if (r.testName) {
      lines.push("", `**Test:** \`${r.testName}\`${r.origin === "existing" ? " (existing)" : ""}${r.level ? ` · ${r.level}` : ""}`);
    }
    if (r.flaky && r.attempts) lines.push("", `Flaky — [all ${r.attempts} attempts](${r.deepLink})`);
    const evidence = r.recording
      ? r.recording.expired
        ? `[recording expired](${r.deepLink})`
        : `[▶ Watch recording](${r.deepLink})`
      : `[details](${r.deepLink})`;
    lines.push("", evidence, "", "</details>");
  }
  lines.push(VERIFICATION_END);

  const prompt = buildTestFixPrompt(view, repoFullName);
  if (prompt) {
    const fence = codeFence(prompt);
    lines.push(
      "",
      "<details>",
      "<summary>Prompt to fix all failing tests</summary>",
      "",
      fence,
      prompt,
      fence,
      "",
      "</details>"
    );
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Only once verification has actually finished — that is when there is something
// to report. Everything else is carried by the "DevAsign · Verify" check run
// instead: "pending"/"planning" would announce that nothing has happened yet, and
// skipped/disabled/fork/setup_pending would put the same nag comment on every
// pull request of a repo that has not enabled the runner.
export function shouldPostTestsComment(view: VerificationView): boolean {
  return (
    view.state === "completed" ||
    view.state === "failed" ||
    view.state === "timed_out" ||
    view.state === "lost"
  );
}

// Serialises upserts per (review, sha). Verification can settle from several
// places at once — the review pipeline's join and runVerifyPlan's settle can land
// in the same tick — and without this each would see "no comment yet" and post
// one, leaving two "Tests by DevAsign" comments on the PR.
const upsertsInFlight = new Map<string, Promise<number | null>>();

/**
 * Post (or edit) the PR's "Tests by DevAsign" comment. One comment per head sha,
 * mirroring the review comment's contract, so a late judge result edits rather
 * than appends. Best-effort: returns the comment id, or null.
 */
export async function upsertVerifyComment(args: {
  install: { installationId: number };
  repo: Repository;
  review: Pick<PRReview, "id" | "prNumber" | "verifyCommentId" | "verifyCommentSha">;
  /** The RUN's sha — never review.headSha, which may already point at a newer push. */
  sha: string;
  runId: string | null;
  view: VerificationView;
}): Promise<number | null> {
  if (!shouldPostTestsComment(args.view)) return null;
  const key = `${args.review.id}:${args.sha}`;
  const inFlight = upsertsInFlight.get(key);
  if (inFlight) return inFlight;
  const task = (async (): Promise<number | null> => {
    const { install, repo, review, sha } = args;
    const body = formatTestsComment(args.view, `${repo.owner}/${repo.name}`);
    const reusable =
      review.verifyCommentId != null && review.verifyCommentSha === sha ? review.verifyCommentId : null;
    let id: number | null = null;
    if (reusable !== null) {
      const ok = await updatePRComment(install.installationId, repo.owner, repo.name, reusable, body);
      if (ok) id = reusable;
    }
    if (id === null) {
      id = await postPRCommentReturningId(
        install.installationId,
        repo.owner,
        repo.name,
        review.prNumber,
        body
      );
      if (id !== null) {
        db.update("prReviews", (r) => r.id === review.id, {
          verifyCommentId: id,
          verifyCommentSha: sha,
        });
      }
    }
    if (id !== null && args.runId) {
      const run = db.find("verifyRuns", (r) => r.id === args.runId);
      if (run) updateRun(run.id, { report: { ...(run.report || {}), commentId: id } });
    }
    return id;
  })();
  upsertsInFlight.set(key, task);
  try {
    return await task;
  } finally {
    upsertsInFlight.delete(key);
  }
}

// One-shot migration: PRs reviewed before verification moved out of the review
// comment still carry a spliced "### Verification" block. Left alone it would show
// alongside the new comment, so strip it the first time we touch that comment.
async function stripLegacyVerificationSection(
  installationId: number,
  repo: Repository,
  commentId: number
): Promise<void> {
  try {
    const current = await getPRComment(installationId, repo.owner, repo.name, commentId);
    if (current === null || !current.includes(VERIFICATION_START)) return;
    const next = spliceVerificationSection(current, "").trim();
    await updatePRComment(installationId, repo.owner, repo.name, commentId, next);
  } catch (err) {
    console.warn("[verify] failed to strip the legacy verification section:", err);
  }
}
