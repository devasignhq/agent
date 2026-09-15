// Offline: the Verification section, its splice, and the Verify check-run mapping.
//   DATABASE_URL= node --import tsx/esm --test src/verify/report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { generateKeyPairSync } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  bestRunForSha,
  buildVerificationView,
  formatTestsComment,
  formatVerificationSection,
  REPLY_LINE,
  refreshCardHead,
  shouldPostTestsComment,
  spliceVerificationSection,
  TESTS_COMMENT_TITLE,
  VERIFICATION_END,
  VERIFICATION_START,
  verifyCheckRunPayload,
} from "./report.js";
import type { Criterion, CriterionVerdict, Repository, VerifyArtifact, VerifyRun } from "../types.js";
import { formatSummaryCard } from "../review/comment.js";

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

test("a flaky Playwright file links to its results, a re-run test to its attempts", () => {
  const plan = { id: "p", schemaVersion: 1, runId: "run1", repoId: "repo", criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: [
    { id: "t1", path: ".devasign/tests/e2e/refunds.spec.ts", content: null, criterionIds: ["1"], level: "e2e", levelReason: "", origin: "generated", runner: "playwright", testSignature: "s", strategyVersion: 1, targetFiles: [] },
    { id: "t2", path: "src/total.test.ts", content: null, criterionIds: ["2"], level: "unit", levelReason: "", origin: "existing", runner: "vitest", testSignature: "s2", strategyVersion: 1, targetFiles: [] },
  ] } as any;
  const att = (n: number, status: string) => ({ n, status, durationMs: 1, artifactIds: [] });
  const results = [
    // Two test() blocks: one passed, the other failed and passed on its retry.
    { id: "r1", testId: "t1", criterionIds: ["1"], test: ".devasign/tests/e2e/refunds.spec.ts", runner: "playwright", level: "e2e", origin: "generated", status: "flaky", attempts: [att(1, "pass"), att(2, "fail"), att(3, "pass")], durationMs: 3, artifactIds: [] },
    { id: "r2", testId: "t2", criterionIds: ["2"], test: "src/total.test.ts", runner: "vitest", level: "unit", origin: "existing", status: "flaky", attempts: [att(1, "fail"), att(2, "pass")], durationMs: 2, artifactIds: [] },
  ] as any;
  const flake = (criterionId: string) => ({ criterionId, verdict: "unverifiable" as const, reason: "flaky test — quarantined", evidenceRefs: [], flaky: true });
  const view = buildVerificationView({ run: baseRun({ status: "completed", verdicts: [flake("1"), flake("2")] }), review, repo, criteria, plan, results, artifacts: [] });
  const section = formatVerificationSection(view);
  assert.match(section, /\[all 3 results\]\(/, "a spec file's entries are its test() blocks, not one test's retries");
  assert.match(section, /\[all 2 attempts\]\(/);
  assert.match(formatTestsComment(view, "acme/w"), /Flaky — \[all 3 results\]\(/);
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
  const body = formatTestsComment(view, "acme/widgets");
  assert.match(body, /No app start was configured\.\n\n\[fix setup\]\(https:\/\/app\/workflow\?repo=repo\) · \[details\]\(/);
  assert.equal(body.split("[fix setup]").length, 2, "only the row that carries a fix link renders one");
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

test("the tests comment is its own card: title, chips and a short summary — no score, no reply nag", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.equal(body.split("\n")[0], TESTS_COMMENT_TITLE);
  assert.match(body, /✅ `Passed \(1\)`/);
  assert.match(body, /❌ `Failed \(1\)`/);
  assert.doesNotMatch(body, /Test score/, "the score lives on the review card now");
  assert.match(body, /1 of 2 criteria verified by tests, 1 failed\. Each verdict below links to its evidence\./);
  // The chip reads "Failed (1)", so the phrase "1 failed" belongs to the summary
  // alone — stateLine used to repeat it directly underneath.
  assert.equal(body.match(/1 failed/g)!.length, 1);
  assert.doesNotMatch(body, new RegExp(REPLY_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("each criterion's result is a collapsed section with its verdict, reason and test", () => {
  const body = formatTestsComment(completedView(), "acme/widgets");
  assert.match(body, /<summary>2 — Total is formatted as currency \(FAIL\)<\/summary>/);
  assert.match(body, /\*\*Verdict:\*\* FAIL/);
  assert.match(body, /total renders as a bare number/);
  assert.match(body, /\*\*Test:\*\* `\.devasign\/tests\/two\.test\.ts`/);
  assert.match(body, /<summary>1 — Refunds line shows when refunds > 0 \(pass\)<\/summary>/);
  assert.doesNotMatch(body, /<summary>(✅|❌|⚠️|⏳)/, "no verdict emoji on a test");
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

test("refreshCardHead edits the review body only for the card's own sha and a finished run", async () => {
  const head = { open: [], fixedCount: 0, score: 100, specless: false, criteriaTotal: 2, criteriaMet: 2, summary: "Fine.", sha: "abc1234" };
  const repoRow = db.insert("repositories", { id: uuid(), installationId: uuid(), owner: "acme", name: "widgets" } as any);
  db.insert("installations", { id: repoRow.installationId, installationId: 777 } as any);
  const row = db.insert("prReviews", {
    id: uuid(), repoId: repoRow.id, prNumber: 1, headSha: "abc1234", status: "changes_requested", criteria: [],
    summaryReviewId: 99, summaryReviewSha: "abc1234", cardHead: head, createdAt: 0, updatedAt: 0,
  } as any);
  const posted = formatSummaryCard({ ...head });
  // Every GitHub call mints an installation token, which signs an App JWT first.
  config.github.appId = "123456";
  config.github.privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
    if (u.includes("/access_tokens")) return { ok: true, status: 200, text: async () => JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), json: async () => ({}) } as any;
    if (/\/reviews\/99$/.test(u) && method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ body: posted }) } as any;
    return { ok: true, status: 200, text: async () => "{}" } as any;
  }) as any;
  const install = { installationId: 777 };
  const view = (state: string, fail: number) =>
    ({ state, counts: { pass: 2 - fail, fail, unverifiable: 0, pending: 0 }, rows: [] }) as any;
  try {
    await refreshCardHead({ install, repo: repoRow as any, reviewId: row.id, sha: "zzz9999", view: view("completed", 1) });
    await refreshCardHead({ install, repo: repoRow as any, reviewId: row.id, sha: "abc1234", view: view("pending", 0) });
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "another sha or an unfinished run never touches the card");
    await refreshCardHead({ install, repo: repoRow as any, reviewId: row.id, sha: "abc1234", view: view("completed", 1) });
    const put = calls.find((c) => c.method === "PUT" && /\/pulls\/1\/reviews\/99$/.test(c.url));
    assert.ok(put, "the card's own sha with a finished run edits the review body");
    assert.match(String(put!.body.body), /Merge score: 90\/100/);
    assert.match(String(put!.body.body), /Tests failing \(1\)/);
    assert.equal(String(put!.body.body).split("<!-- devasign:card-head -->").length, 2);
    assert.doesNotMatch(String(put!.body.body), /without a browser/);
    const fixUrl = "https://app.test/workflow?repo=r&setup=browser";
    const browserless = { count: 2, criterionIds: ["1", "2"], reason: "not_configured", fixUrl };
    await refreshCardHead({ install, repo: repoRow as any, reviewId: row.id, sha: "abc1234", view: { ...view("completed", 0), browserless } });
    const last = calls.filter((c) => c.method === "PUT").at(-1);
    assert.ok(String(last!.body.body).includes(`· 2 UI criteria checked without a browser ([set up](${fixUrl}))`), "the view's browserless count reaches the card");
  } finally {
    globalThis.fetch = original;
  }
});

test("a doctor diagnosis carries its fix into the check-run summary", () => {
  const view = buildVerificationView({ run: baseRun({}), review, repo, criteria, plan: null, results: null, artifacts: [] });
  const doctor = { code: "missing_dependencies", message: "dependencies are not installed on this runner for backend/ (dotenv)", suggestedFix: { kind: "workflow_patch" as const, instructions: "Add an install step before the DevAsign verify step: `npm ci --prefix backend`." } };
  const check = verifyCheckRunPayload(view, "abc", { doctor });
  assert.equal(check.conclusion, "neutral");
  assert.equal(check.output.title, "Setup needs attention");
  assert.equal(check.output.summary, "dependencies are not installed on this runner for backend/ \\(dotenv\\) — criteria are unverifiable, not failed. Fix: Add an install step before the DevAsign verify step: \\`npm ci --prefix backend\\`.");
  assert.equal(verifyCheckRunPayload(view, "abc", { doctor: { code: "x", message: "m" } }).output.summary, "m — criteria are unverifiable, not failed.");
});

test("a doctor message renders inert: no link, no mention, no fence — in the summary, the comment and the check-run text", () => {
  const hostile = "[x](https://evil) @org/team ```";
  const run = baseRun({
    status: "completed",
    verdicts: [{ criterionId: "1", verdict: "unverifiable", reason: `setup needs attention: ${hostile}`, evidenceRefs: [] }],
  });
  const view = buildVerificationView({ run, review, repo, criteria, plan: null, results: [], artifacts: [] });
  const check = verifyCheckRunPayload(view, "abc", { doctor: { code: "unknown", message: hostile, suggestedFix: { instructions: hostile } } });
  const inert = (s: string, where: string) => {
    assert.doesNotMatch(s, /(?<!\\)\]\(https:\/\/evil/, `${where}: no live link`);
    assert.doesNotMatch(s, /@org\/team/, `${where}: no team mention`);
    assert.doesNotMatch(s, /``/, `${where}: no fence`);
    assert.ok(s.includes("\\[x\\]\\(https:\u200b//evil\\)"), `${where}: the text is still readable, and no bare URL autolinks`);
  };
  inert(check.output.summary, "summary");
  assert.equal(check.output.summary.split("\\[x\\]").length, 3, "message and instructions both escaped");
  inert(check.output.text, "check-run text");
  inert(formatTestsComment(view, "acme/widgets"), "comment");
  // The escape is ours: a benign reason keeps its words.
  assert.match(formatTestsComment(completedView(), "acme/widgets"), /\n\ntotal renders as a bare number\n/);
});

// ─── UI criteria checked without a browser ──────────────────────────────────

const FIX = "https://app.test/workflow?repo=repo&setup=browser";
const uiCriteria: Criterion[] = [
  { id: "1", text: "Refunds line shows", met: null, evidence: null, kind: "ui" },
  { id: "2", text: "Empty state renders", met: null, evidence: null, kind: "ui" },
  { id: "3", text: "Menu closes on escape", met: null, evidence: null, kind: "ui" },
  { id: "4", text: "Checkout button disables", met: null, evidence: null, kind: "ui" },
  { id: "5", text: "Total is formatted as currency", met: null, evidence: null, kind: "code" },
];
const browserPlan = (browser: Record<string, unknown> | null, over: Record<string, unknown> = {}) =>
  ({
    id: "p", schemaVersion: 1, runId: "run1", repoId: "repo", criteriaRevision: 1, commands: [], tests: [], unverifiable: [], createdAt: 0,
    ...(browser ? { browser: { policy: "auto", allowed: false, bootConfigured: false, reason: "no_boot", fixUrl: FIX, ...browser } } : {}),
    ...over,
  }) as any;
const verdict = (criterionId: string, v: CriterionVerdict["verdict"], browser?: CriterionVerdict["browser"]): CriterionVerdict => ({
  criterionId, verdict: v, reason: v === "unverifiable" ? "no test ran for this criterion" : "the test passed", evidenceRefs: [], ...(browser ? { browser } : {}),
});
const judgedView = (verdicts: VerifyRun["verdicts"], plan: any, run: Partial<VerifyRun> = {}) =>
  buildVerificationView({ run: baseRun({ status: "completed", timings: { forkedAt: 1, resolvedAt: 2 }, verdicts, ...run }), review, repo, criteria: uiCriteria, plan, results: [], artifacts: [] });

test("UI criteria decided without a browser get a note in the comment, the check-run summary and text; the conclusion is unchanged", () => {
  // Criterion 4 stayed unverifiable, so it was not checked at all; 5 is not a UI criterion.
  const verdicts = [verdict("1", "pass"), verdict("2", "fail"), verdict("3", "pass"), verdict("4", "unverifiable"), verdict("5", "pass")];
  const note = `3 UI criteria were checked without a browser — [set up browser tests](${FIX})`;
  const view = judgedView(verdicts, browserPlan({}, { prAuthoredTests: ["src/menu.test.tsx"] }));
  assert.deepEqual(view.browserless, { count: 3, criterionIds: ["1", "2", "3"], reason: "not_configured", fixUrl: FIX });
  const without = judgedView(verdicts, browserPlan(null, { prAuthoredTests: ["src/menu.test.tsx"] }));
  assert.equal(without.browserless, undefined);

  const body = formatTestsComment(view, "acme/widgets");
  const lines = body.split("\n");
  const own = lines.findIndex((l) => l.startsWith("This PR adds or changes 1 test file of its own"));
  assert.ok(own > 0);
  assert.deepEqual(lines.slice(own + 1, own + 3), ["", note], "the note follows the PR-authored tests note");
  assert.ok(body.indexOf(note) < body.indexOf(VERIFICATION_START));
  assert.equal(body.split(note).length, 2, "said once");

  const check = verifyCheckRunPayload(view, "abc");
  const plain = verifyCheckRunPayload(without, "abc");
  assert.equal(check.conclusion, "failure");
  assert.equal(check.conclusion, plain.conclusion);
  assert.equal(check.output.title, plain.output.title);
  assert.equal(check.output.summary, `${plain.output.summary}\n\n${note}`);
  assert.deepEqual(check.output.text.split("\n").slice(0, 4), [plain.output.text.split("\n")[0], "", note, ""]);

  const allPass = judgedView(verdicts.map((v) => ({ ...v, verdict: v.verdict === "fail" ? "pass" : v.verdict })), browserPlan({}));
  assert.equal(verifyCheckRunPayload(allPass, "abc").conclusion, "neutral", "still neutral for the unverifiable criterion, not failure");
  const doctor = { code: "boot_failed", message: "the app did not start" };
  const withDoctor = verifyCheckRunPayload(view, "abc", { doctor });
  assert.equal(withDoctor.conclusion, verifyCheckRunPayload(without, "abc", { doctor }).conclusion);
  assert.equal(withDoctor.output.summary, `the app did not start — criteria are unverifiable, not failed.\n\n${note}`);
});

test("one UI criterion reads singular; browser tests that could not run say the app did not start", () => {
  const one = judgedView([verdict("1", "pass"), verdict("5", "pass")], browserPlan({}));
  assert.match(formatTestsComment(one, "acme/widgets"), new RegExp(`\\n1 UI criterion was checked without a browser — \\[set up browser tests\\]\\(${FIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\n`));
  assert.doesNotMatch(formatTestsComment(one, "acme/widgets"), /criteria were/);

  const allowed = browserPlan({ allowed: true, bootConfigured: true, reason: "ok" });
  const didNotStart = judgedView([verdict("1", "pass", "fallback"), verdict("2", "fail", "fallback"), verdict("3", "pass", "ran"), verdict("4", "pass")], allowed);
  assert.equal(didNotStart.browserless?.reason, "did_not_start");
  const note = `2 UI criteria were checked without a browser because the app did not start in CI — [see setup](${FIX})`;
  assert.ok(formatTestsComment(didNotStart, "acme/widgets").includes(`\n${note}\n`));
  assert.ok(verifyCheckRunPayload(didNotStart, "abc").output.summary.endsWith(`\n\n${note}`));
  assert.ok(verifyCheckRunPayload(didNotStart, "abc").output.text.includes(`\n\n${note}\n\n`));
  assert.doesNotMatch(formatTestsComment(didNotStart, "acme/widgets"), /set up browser tests/);
});

test("under e2e: always a fallback the judge refused is still noted; criteria withheld for want of boot config and flaky browser runs are not", () => {
  const strict = browserPlan({ policy: "always", allowed: true, bootConfigured: true, reason: "ok" });
  const refused: CriterionVerdict = { ...verdict("1", "unverifiable", "fallback"), reason: "the app did not start for browser tests", fixUrl: FIX };
  const view = judgedView([refused, verdict("2", "pass", "ran"), verdict("5", "pass")], strict);
  assert.deepEqual(view.browserless, { count: 1, criterionIds: ["1"], reason: "did_not_start", fixUrl: FIX });
  assert.ok(formatTestsComment(view, "acme/widgets").includes(`\n1 UI criterion was checked without a browser because the app did not start in CI — [see setup](${FIX})\n`));

  assert.equal(judgedView([{ ...verdict("1", "unverifiable", "ran"), flaky: true }, verdict("5", "pass")], strict).browserless, undefined);
  const withheld = judgedView([verdict("1", "unverifiable"), verdict("2", "unverifiable"), verdict("5", "pass")], browserPlan({ policy: "always" }));
  assert.equal(withheld.browserless, undefined);
});

test("no note under e2e: never, on a plan older than the policy, for a component-level pass with browsers allowed, or before the run completes", () => {
  const verdicts = [verdict("1", "pass"), verdict("2", "pass"), verdict("5", "pass")];
  const cases: Array<[string, ReturnType<typeof judgedView>]> = [
    ["never", judgedView(verdicts, browserPlan({ policy: "never", reason: "never" }))],
    ["old plan", judgedView(verdicts, browserPlan(null))],
    ["component level with browsers allowed", judgedView(verdicts, browserPlan({ allowed: true, bootConfigured: true, reason: "ok" }))],
    ["still running", buildVerificationView({ run: baseRun({ status: "running", verdicts }), review, repo, criteria: uiCriteria, plan: browserPlan({}), results: [], artifacts: [] })],
  ];
  for (const [label, view] of cases) {
    assert.equal(view.browserless, undefined, label);
    const check = verifyCheckRunPayload(view, "abc");
    for (const s of [formatTestsComment(view, "acme/widgets"), check.output.summary, check.output.text]) {
      assert.doesNotMatch(s, /without a browser/, label);
    }
  }
});

test("browser tests withheld from an outdated runner say to update it, singular and plural; the kill switch says DevAsign paused them", () => {
  const allowed = browserPlan({ allowed: true, bootConfigured: true, reason: "ok" });
  const npm = "https://www.npmjs.com/package/@devasign/verify";
  const outdated = { runnerMeta: { e2eWithheld: "runner_outdated" as const } };
  const verdicts = [verdict("1", "pass", "fallback"), verdict("2", "fail", "fallback"), verdict("3", "unverifiable"), verdict("5", "pass")];
  const two = judgedView(verdicts, allowed, outdated);
  assert.deepEqual(two.browserless, { count: 2, criterionIds: ["1", "2"], reason: "runner_outdated", fixUrl: FIX });
  const note = `2 UI criteria were checked without a browser because the runner in CI is too old for verify.servers or verify.login — [update @devasign/verify](${npm})`;
  const body = formatTestsComment(two, "acme/widgets");
  assert.ok(body.includes(`\n${note}\n`));
  assert.doesNotMatch(body, /did not start|set up browser tests/);
  const check = verifyCheckRunPayload(two, "abc");
  assert.ok(check.output.summary.endsWith(`\n\n${note}`));
  assert.ok(check.output.text.includes(`\n\n${note}\n\n`));
  assert.equal(check.conclusion, verifyCheckRunPayload(judgedView(verdicts, allowed), "abc").conclusion, "the note never changes the conclusion");

  const one = judgedView([verdict("1", "pass", "fallback"), verdict("5", "pass")], allowed, outdated);
  assert.ok(formatTestsComment(one, "acme/widgets").includes(`\n1 UI criterion was checked without a browser because the runner in CI is too old for verify.servers or verify.login — [update @devasign/verify](${npm})\n`));

  const off = judgedView([verdict("1", "pass", "fallback"), verdict("2", "unverifiable"), verdict("5", "pass")], allowed, { runnerMeta: { e2eWithheld: "managed_boot_off" } });
  assert.deepEqual(off.browserless, { count: 1, criterionIds: ["1"], reason: "paused", fixUrl: "" });
  const paused = "1 UI criterion was checked without a browser because DevAsign has paused browser tests that boot verify.servers or verify.login";
  const offBody = formatTestsComment(off, "acme/widgets");
  assert.ok(offBody.includes(`\n${paused}\n`), offBody);
  assert.doesNotMatch(offBody, /too old|did not start|see setup|set up browser tests/, "the kill switch never blames the repo's setup");
  const offCheck = verifyCheckRunPayload(off, "abc");
  assert.ok(offCheck.output.summary.endsWith(`\n\n${paused}`));
  assert.ok(offCheck.output.text.includes(`\n\n${paused}\n\n`));
  const unconfigured = judgedView([verdict("1", "pass"), verdict("5", "pass")], browserPlan({}), outdated);
  assert.equal(unconfigured.browserless?.reason, "not_configured", "no boot config is still the thing to fix");
});
