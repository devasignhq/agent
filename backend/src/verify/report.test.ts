// Offline: the Verification section, its splice, and the Verify check-run mapping.
//   DATABASE_URL= node --import tsx/esm --test src/verify/report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  bestRunForSha,
  buildVerificationView,
  formatTestsComment,
  formatVerificationSection,
  REPLY_LINE,
  shouldPostTestsComment,
  spliceVerificationSection,
  testScore,
  TESTS_COMMENT_TITLE,
  VERIFICATION_END,
  VERIFICATION_START,
  verifyCheckRunPayload,
} from "./report.js";
import type { Criterion, Repository, VerifyArtifact, VerifyRun } from "../types.js";

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const criteria: Criterion[] = [
  { id: "1", text: "Refunds line shows when refunds > 0", met: null, evidence: null, kind: "ui" },
  { id: "2", text: "Total is formatted as currency", met: null, evidence: null, kind: "code" },
  { id: "3", text: "Looks nice", met: null, evidence: null, kind: "unverifiable" },
];
const repo = { id: "repo", installationId: "i", verify: { onboarding: { state: "pr_open", prNumber: 12 } } } as unknown as Repository;
const review = { id: "rev" };
const baseRun = (over: Partial<VerifyRun>): VerifyRun =>
  ({ id: "run1", reviewId: "rev", repoId: "repo", sha: "abc", status: "awaiting_runner", verdicts: [], timings: { forkedAt: 1 }, tokenUsage: {}, artifactBytes: 0, criteriaRevision: 1, planTier: "free", attempt: 1, prNumber: 1, installationId: "i", schemaVersion: 1, triggeredBy: { kind: "pr_event" }, createdAt: 0, updatedAt: 0, ...over }) as VerifyRun;

test("setup pending: no runner evidence → nudge with the onboarding PR, neutral check run, criteria listed pending", () => {
  const view = buildVerificationView({ run: baseRun({}), review, repo, criteria, plan: null, results: null, artifacts: [] });
  assert.equal(view.state, "setup_pending");
  assert.equal(view.nudge, "Verification isn't running yet — merge #12 to enable.");
  assert.equal(view.rows.length, 2, "unverifiable-kind criteria are not rows");
  const section = formatVerificationSection(view);
  assert.ok(section.startsWith(VERIFICATION_START));
  assert.ok(section.endsWith(VERIFICATION_END));
  assert.match(section, /### Verification\nVerification isn't running yet — merge #12 to enable\./);
  assert.match(section, /\*\*1\.\*\* Refunds line shows when refunds > 0 — \*\*pending\*\*/);
  assert.ok(section.includes(REPLY_LINE));
  assert.doesNotMatch(section, EMOJI);
  const check = verifyCheckRunPayload(view, "abc");
  assert.equal(check.conclusion, "neutral");
  assert.equal(check.output.title, "Setup pending");
  assert.equal(check.name, "DevAsign · Verify");
});

test("completed: recording link only on rows with a video, expired wording, fail → failure conclusion", () => {
  const artifacts: VerifyArtifact[] = [
    { id: "vid", schemaVersion: 1, runId: "run1", repoId: "repo", testId: "t1", criterionIds: ["1"], kind: "video", path: "a.webm", storageKey: "k", bytes: 1, contentType: "video/webm", state: "uploaded", expiresAt: Date.now() + 1e6, createdAt: 0 },
    { id: "log", schemaVersion: 1, runId: "run1", repoId: "repo", testId: "t2", criterionIds: ["2"], kind: "log", path: "b.txt", storageKey: "k2", bytes: 1, contentType: "text/plain", state: "uploaded", expiresAt: Date.now() + 1e6, createdAt: 0 },
  ];
  const run = baseRun({
    status: "completed",
    timings: { forkedAt: 1, resolvedAt: 2 },
    verdicts: [
      { criterionId: "1", verdict: "fail", reason: "refunds line missing", evidenceRefs: [{ artifactId: "vid" }] },
      { criterionId: "2", verdict: "pass", reason: "the test passed", evidenceRefs: [{ artifactId: "log" }] },
    ],
  });
  const plan = { id: "p", schemaVersion: 1, runId: "run1", repoId: "repo", criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: [
    { id: "t1", path: ".devasign/tests/e2e/refunds.spec.ts", content: null, criterionIds: ["1"], level: "e2e", levelReason: "", origin: "generated", runner: "playwright", testSignature: "s", strategyVersion: 1, targetFiles: [] },
    { id: "t2", path: "src/total.test.ts", content: null, criterionIds: ["2"], level: "unit", levelReason: "", origin: "existing", runner: "vitest", testSignature: "s2", strategyVersion: 1, targetFiles: [] },
  ] } as any;
  const view = buildVerificationView({ run, review, repo, criteria, plan, results: [], artifacts });
  assert.equal(view.state, "completed");
  assert.deepEqual(view.counts, { pass: 1, fail: 1, unverifiable: 0, pending: 0 });
  assert.ok(!formatVerificationSection(view).includes("of its own"), "no note when the PR shipped no tests");
  // A PR that ships its own tests says so, so the pass count is not read as independent.
  const withOwn = buildVerificationView({ run, review, repo, criteria, plan: { ...plan, prAuthoredTests: ["src/menu.test.tsx", "src/anchor.test.ts"] }, results: [], artifacts });
  assert.match(formatVerificationSection(withOwn), /This PR adds or changes 2 test files of its own; they were not used as evidence\./);
  const section = formatVerificationSection(view);
  const origin = config.webOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(section, new RegExp(`\\*\\*1\\.\\*\\* .* — \\*\\*FAIL\\*\\* · refunds line missing · e2e \`\\.devasign/tests/e2e/refunds\\.spec\\.ts\` · \\[▶ Watch recording\\]\\(${origin}/reviews/rev\\?run=run1&criterion=1\\)`));
  assert.match(section, /\*\*2\.\*\* .* — \*\*pass\*\* · the test passed · unit \(existing\) `src\/total\.test\.ts` · \[details\]\(/);
  assert.ok(!/\*\*2\.\*\*.*Watch recording/.test(section), "no recording link without a video");
  const check = verifyCheckRunPayload(view, "abc");
  assert.equal(check.conclusion, "failure");
  assert.equal(check.output.title, "1 of 2 criteria failed verification");
  assert.match(check.output.text, /FAIL — 1\./);

  const expired = buildVerificationView({ run, review, repo, criteria, plan, results: [], artifacts: artifacts.map((a) => ({ ...a, state: "expired" as const })) });
  assert.match(formatVerificationSection(expired), /\[recording expired\]\(/);
  const allPass = buildVerificationView({ run: { ...run, verdicts: run.verdicts.map((v) => ({ ...v, verdict: "pass" as const })) }, review, repo, criteria, plan, results: [], artifacts });
  assert.equal(verifyCheckRunPayload(allPass, "abc").conclusion, "success");
  const someUnverifiable = buildVerificationView({ run: { ...run, verdicts: [run.verdicts[1], { criterionId: "1", verdict: "unverifiable", reason: "flaky test — quarantined", evidenceRefs: [], flaky: true }] }, review, repo, criteria, plan, results: [], artifacts });
  assert.equal(verifyCheckRunPayload(someUnverifiable, "abc").conclusion, "neutral");
});

test("pending with runner evidence, disabled, and failed states", () => {
  const evidenced = { ...repo, verify: { onboarding: { state: "verified" }, detected: { languages: [], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } } } as unknown as Repository;
  const pending = buildVerificationView({ run: baseRun({ status: "running" }), review, repo: evidenced, criteria, plan: null, results: null, artifacts: [] });
  assert.equal(pending.state, "pending");
  assert.equal(verifyCheckRunPayload(pending, "abc").output.title, "Verification pending");
  const disabled = buildVerificationView({ run: baseRun({ status: "skipped", skipReason: "verify_disabled" }), review, repo, criteria, plan: null, results: null, artifacts: [] });
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.rows[0].verdict, "unverifiable");
  const failed = buildVerificationView({ run: baseRun({ status: "failed", error: "planner: boom" }), review, repo, criteria, plan: null, results: null, artifacts: [] });
  assert.equal(failed.state, "failed");
  assert.equal(failed.rows[0].reason, "planner: boom");
  assert.equal(verifyCheckRunPayload(failed, "abc").conclusion, "neutral");
});

test("spliceVerificationSection replaces the marker block in place or appends", () => {
  const body = `## DevAsign review\n\n### End goal\nx\n\n${VERIFICATION_START}\n### Verification\nold\n${VERIFICATION_END}\n\n---\nfooter`;
  const next = spliceVerificationSection(body, `${VERIFICATION_START}\n### Verification\nnew\n${VERIFICATION_END}`);
  assert.ok(next.includes("### Verification\nnew"));
  assert.ok(!next.includes("old"));
  assert.ok(next.endsWith("---\nfooter"));
  const appended = spliceVerificationSection("## DevAsign review\nbody\n", `${VERIFICATION_START}\nS\n${VERIFICATION_END}`);
  assert.equal(appended, `## DevAsign review\nbody\n\n${VERIFICATION_START}\nS\n${VERIFICATION_END}`);
});

test("hasRunnerEvidence is read from resolved runs on the repo", () => {
  const repoId = uuid();
  const r = { id: repoId, installationId: "i", verify: { onboarding: { state: "none" } } } as unknown as Repository;
  db.insert("verifyRuns", baseRun({ id: uuid(), repoId, timings: { forkedAt: 1, resolvedAt: 5 } }));
  try {
    const view = buildVerificationView({ run: baseRun({ repoId }), review, repo: r, criteria, plan: null, results: null, artifacts: [] });
    assert.equal(view.state, "pending");
  } finally {
    db.remove("verifyRuns", (x) => x.repoId === repoId);
  }
});

// Nothing cancels a superseded run, so a re-run attempt (or a feedback run whose
// repository_dispatch failed) is reaped as timed_out and used to be rendered over
// the judged verdicts of the run that actually produced evidence.
test("a run with no verdicts never displaces a judged run for the same commit", () => {
  const reviewId = uuid();
  const judged = { ...baseRun({}), id: uuid(), reviewId, sha: "abc", status: "completed", createdAt: 100, verdicts: [{ criterionId: "1", verdict: "pass", reason: "the test passed", evidenceRefs: [] }] } as VerifyRun;
  const reaped = { ...baseRun({}), id: uuid(), reviewId, sha: "abc", status: "timed_out", createdAt: 200, verdicts: [] } as VerifyRun;
  const otherSha = { ...baseRun({}), id: uuid(), reviewId, sha: "def", status: "completed", createdAt: 300, verdicts: [{ criterionId: "1", verdict: "fail", reason: "x", evidenceRefs: [] }] } as VerifyRun;
  for (const r of [judged, reaped, otherSha]) db.insert("verifyRuns", r);
  try {
    assert.equal(bestRunForSha(reaped).id, judged.id, "the judged run wins");
    assert.equal(bestRunForSha(judged).id, judged.id);
    assert.equal(bestRunForSha(otherSha).id, otherSha.id, "a different commit is never borrowed from");
    // With no judged run for the commit, the caller's own run is used.
    const only = { ...baseRun({}), id: uuid(), reviewId, sha: "zzz", status: "timed_out", createdAt: 400, verdicts: [] } as VerifyRun;
    db.insert("verifyRuns", only);
    assert.equal(bestRunForSha(only).id, only.id);
  } finally {
    db.remove("verifyRuns", (r) => r.reviewId === reviewId);
  }
});

test("completed: an unverifiable row keeps the planner's reason and renders its fix link in the comment and check run", () => {
  const plan = { id: "p", schemaVersion: 1, runId: "run1", repoId: "repo", criteriaRevision: 1, commands: [], tests: [], createdAt: 0, unverifiable: [
    { criterionId: "1", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=repo" },
    { criterionId: "2", reason: "the test plan was cut off before this criterion was covered" },
  ] } as any;
  // No verdict rows at all: the terminal branch used to say "no test ran for this criterion".
  const bare = buildVerificationView({ run: baseRun({ status: "completed", timings: { forkedAt: 1, resolvedAt: 2 } }), review, repo, criteria, plan, results: [], artifacts: [] });
  assert.equal(bare.rows[0].reason, "no app start / login configured");
  assert.equal(bare.rows[0].fixUrl, "https://app/workflow?repo=repo");
  assert.equal(bare.rows[1].reason, "the test plan was cut off before this criterion was covered");
  assert.equal(bare.rows[1].fixUrl, undefined);
  // With judged verdicts, the verdict's own link wins and reaches both renderings.
  const run = baseRun({
    status: "completed",
    timings: { forkedAt: 1, resolvedAt: 2 },
    verdicts: [
      { criterionId: "1", verdict: "unverifiable", reason: "No app start was configured.", evidenceRefs: [], fixUrl: "https://app/workflow?repo=repo" },
      { criterionId: "2", verdict: "pass", reason: "the test passed", evidenceRefs: [] },
    ],
  });
  const view = buildVerificationView({ run, review, repo, criteria, plan, results: [], artifacts: [] });
  const section = formatVerificationSection(view);
  assert.match(section, /\*\*1\.\*\* Refunds line shows when refunds > 0 — \*\*unverifiable\*\* · No app start was configured\. · \[configure app start\]\(https:\/\/app\/workflow\?repo=repo\)/);
  assert.doesNotMatch(section, /\*\*2\.\*\*[^\n]*configure app start/);
  const check = verifyCheckRunPayload(view, "abc");
  assert.match(check.output.text, /unverifiable — 1\. Refunds line[^\n]*\[configure app start\]\(https:\/\/app\/workflow\?repo=repo\)/);
  assert.equal(check.conclusion, "neutral");
});

// ─── the "Tests by DevAsign" comment ───────────────────────────────────────

const completedView = () =>
  buildVerificationView({
    run: baseRun({
      status: "completed",
      verdicts: [
        { criterionId: "1", verdict: "pass", reason: "the refunds line renders", evidenceRefs: [] },
        { criterionId: "2", verdict: "fail", reason: "total renders as a bare number", evidenceRefs: [] },
      ],
    }),
    review,
    repo: { ...repo, verify: { onboarding: { state: "merged" } } } as unknown as Repository,
    criteria,
    plan: {
      id: "p",
      tests: [
        { id: "t1", path: "src/a.test.ts", criterionIds: ["1"], origin: "existing", level: "unit", runner: "node" },
        { id: "t2", path: ".devasign/tests/two.test.ts", criterionIds: ["2"], origin: "generated", level: "unit", runner: "node" },
      ],
      unverifiable: [],
    } as any,
    results: null,
    artifacts: [],
  });

test("the tests comment is its own card: title, chips, a scored header and a short summary", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.equal(body.split("\n")[0], TESTS_COMMENT_TITLE);
  assert.match(body, /✅ `Passed \(1\)`/);
  assert.match(body, /❌ `Failed \(1\)`/);
  assert.match(body, /### (✅|🟡|🔴) Test score: \d{1,3}\/100/);
  assert.match(body, /1 of 2 criteria verified by tests, 1 failed\. Each verdict below links to its evidence\./);
  // The chip reads "Failed (1)", so the phrase "1 failed" belongs to the summary
  // alone — stateLine used to repeat it directly underneath.
  assert.equal(body.match(/1 failed/g)!.length, 1);
  assert.match(body, new RegExp(REPLY_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("each criterion's result is a collapsed section with its verdict, reason and test", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.match(body, /<summary>❌ 2 — Total is formatted as currency<\/summary>/);
  assert.match(body, /\*\*Verdict:\*\* FAIL/);
  assert.match(body, /total renders as a bare number/);
  assert.match(body, /\*\*Test:\*\* `\.devasign\/tests\/two\.test\.ts`/);
  assert.match(body, /<summary>✅ 1 — Refunds line shows when refunds > 0<\/summary>/);
  assert.match(body, /\*\*Test:\*\* `src\/a\.test\.ts` \(existing\)/);
});

test("the fix prompt covers the failures only, and is absent when everything passed", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.match(body, /<summary>Prompt to fix all failing tests<\/summary>/);
  assert.match(body, /Total is formatted as currency \(2\)/);
  assert.match(body, /Don't change the test to match the code/);
  assert.doesNotMatch(body, /Refunds line shows when refunds > 0 \(1\)/, "passing criteria are not asked to be fixed");

  const allPass = buildVerificationView({
    run: baseRun({
      status: "completed",
      verdicts: [
        { criterionId: "1", verdict: "pass", reason: "ok", evidenceRefs: [] },
        { criterionId: "2", verdict: "pass", reason: "ok", evidenceRefs: [] },
      ],
    }),
    review,
    repo: { ...repo, verify: { onboarding: { state: "merged" } } } as unknown as Repository,
    criteria,
    plan: null,
    results: null,
    artifacts: [],
  });
  assert.doesNotMatch(formatTestsComment(allPass, "acme/widgets"), /Prompt to fix all failing tests/);
});

test("the rows stay marker-delimited so the block can be spliced later", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.ok(body.includes(VERIFICATION_START) && body.includes(VERIFICATION_END));
  assert.equal(body.split(VERIFICATION_START).length, 2);
});

test("testScore penalises failures hardest and clamps at 0", () => {
  assert.equal(testScore({ pass: 5, fail: 0, unverifiable: 0, pending: 0 }), 100);
  assert.equal(testScore({ pass: 3, fail: 1, unverifiable: 0, pending: 0 }), 80);
  assert.equal(testScore({ pass: 3, fail: 0, unverifiable: 2, pending: 0 }), 90);
  assert.equal(testScore({ pass: 0, fail: 9, unverifiable: 0, pending: 0 }), 0);
});

test("a comment is posted only once verification has finished, never as a setup nag", () => {
  const finished = ["completed", "failed", "timed_out", "lost"];
  const quiet = ["pending", "planning", "fork", "setup_pending", "skipped", "disabled"];
  for (const state of finished) {
    assert.equal(shouldPostTestsComment({ state } as any), true, state);
  }
  for (const state of quiet) {
    assert.equal(shouldPostTestsComment({ state } as any), false, state);
  }
});

test("spliceVerificationSection with an empty section strips a legacy block from a review comment", () => {
  const legacy = `## DevAsign review\n\nbody text\n\n${VERIFICATION_START}\n### Verification\nrows\n${VERIFICATION_END}`;
  const stripped = spliceVerificationSection(legacy, "").trim();
  assert.doesNotMatch(stripped, /devasign:verification/);
  assert.match(stripped, /body text/);
});
