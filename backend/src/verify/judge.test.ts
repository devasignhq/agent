// Offline: verdicts are computed from what ran; the model may only downgrade.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/judge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { BOOT_PAUSED_REASON, buildJudgeUserPrompt, computeVerdicts, FLAKY_REASON, mergeModelVerdicts, NO_BROWSER_REASON, RUNNER_OUTDATED_REASON, runVerifyJudge } from "./judge.js";
import { createVerifyRun, snapshotCriteriaRevision, updateRun } from "./runs.js";
import type { Criterion, CriterionVerdict, RepoVerifyState, VerifyArtifact, VerifyPlan, VerifyRun } from "../types.js";
import type { DoctorDiagnosis, RunnerAttempt, RunnerResult } from "./contract.js";

const crit = (id: string, kind: Criterion["kind"] = "code"): Criterion => ({ id, text: `criterion ${id}`, met: null, evidence: null, kind });
const art = (id: string, kind: VerifyArtifact["kind"], testId: string): VerifyArtifact =>
  ({ id, schemaVersion: 1, runId: "r", repoId: "p", testId, criterionIds: [], kind, path: `${id}.${kind}`, storageKey: id, bytes: 1, contentType: "x", state: "uploaded", expiresAt: Date.now() + 1e6, createdAt: 0 });
const result = (over: Partial<RunnerResult> & { testId: string; criterionIds: string[]; status: RunnerResult["status"] }): RunnerResult => ({
  id: uuid(), test: over.testId, runner: "node-test", level: "unit", origin: "generated", attempts: [], durationMs: 1, artifactIds: [], ...over,
});
const attempt = (n: number, status: RunnerAttempt["status"], error?: string): RunnerAttempt => ({ n, status, durationMs: 1, error, artifactIds: [] });

test("no result → unverifiable (planner reason wins); error → unverifiable; doctor → unverifiable", () => {
  const plan = { unverifiable: [{ criterionId: "2", reason: "no app start / login configured" }] } as unknown as VerifyPlan;
  const out = computeVerdicts({
    criteria: [crit("1"), crit("2"), crit("3")],
    results: [result({ testId: "t3", criterionIds: ["3"], status: "error", error: "Cannot find module './x'", attempts: [{ n: 1, status: "error", durationMs: 5, artifactIds: ["log3"] }] })],
    plan,
    doctor: null,
    artifacts: [art("log3", "log", "t3")],
  });
  assert.deepEqual(out.map((v) => [v.criterionId, v.verdict]), [["1", "unverifiable"], ["2", "unverifiable"], ["3", "unverifiable"]]);
  assert.equal(out[0].reason, "no test ran for this criterion");
  assert.equal(out[1].reason, "no app start / login configured");
  assert.match(out[2].reason, /could not run: Cannot find module/);
  assert.ok(out[2].evidenceRefs.some((r) => r.artifactId === "log3"));
  const doc = computeVerdicts({ criteria: [crit("1")], results: [], plan: null, doctor: { stage: "start", code: "no_start_command", message: "no start command" }, artifacts: [] });
  assert.equal(doc[0].verdict, "unverifiable");
  assert.match(doc[0].reason, /setup needs attention/);
});

test("flaky → unverifiable with every attempt's evidence, never fail; fail on every attempt → fail; pass → pass", () => {
  const artifacts = [art("v1", "video", "t1"), art("v2", "video", "t1"), art("tf", "test_file", "t1"), art("l2", "log", "t2"), art("s2", "screenshot", "t2")];
  const out = computeVerdicts({
    criteria: [crit("1", "ui"), crit("2"), crit("3")],
    results: [
      result({ testId: "t1", criterionIds: ["1"], status: "flaky", attempts: [{ n: 1, status: "fail", durationMs: 1, artifactIds: ["v1"] }, { n: 2, status: "pass", durationMs: 1, artifactIds: ["v2"] }] }),
      result({ testId: "t2", criterionIds: ["2"], status: "fail", error: "expected 'refunds' to be visible\n  at x", attempts: [{ n: 1, status: "fail", durationMs: 1, artifactIds: ["l2"] }, { n: 2, status: "fail", durationMs: 1, artifactIds: ["s2"] }, { n: 3, status: "fail", durationMs: 1, artifactIds: [] }] }),
      result({ testId: "t3", criterionIds: ["3"], status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 1, artifactIds: [] }] }),
    ],
    plan: null,
    doctor: null,
    artifacts,
  });
  assert.equal(out[0].verdict, "unverifiable");
  assert.equal(out[0].reason, FLAKY_REASON);
  assert.equal(out[0].flaky, true);
  const ids = out[0].evidenceRefs.map((r) => r.artifactId).filter(Boolean);
  assert.ok(ids.includes("v1") && ids.includes("v2"), "both attempts' recordings are evidence");
  assert.equal(out[1].verdict, "fail");
  assert.match(out[1].reason, /all 3 attempts: expected 'refunds' to be visible/);
  assert.ok(out[1].evidenceRefs.some((r) => r.artifactId === "l2") && out[1].evidenceRefs.some((r) => r.artifactId === "s2"));
  assert.equal(out[2].verdict, "pass");
});

test("mergeModelVerdicts: downgrade to unverifiable allowed; upgrades and flips ignored; flaky reason kept", () => {
  const code = computeVerdicts({
    criteria: [crit("1"), crit("2"), crit("3"), crit("4", "ui")],
    results: [
      result({ testId: "a", criterionIds: ["1"], status: "pass" }),
      result({ testId: "b", criterionIds: ["2"], status: "fail", error: "boom" }),
      result({ testId: "d", criterionIds: ["4"], status: "flaky", attempts: [{ n: 1, status: "fail", durationMs: 1, artifactIds: [] }, { n: 2, status: "pass", durationMs: 1, artifactIds: [] }] }),
    ],
    plan: null,
    doctor: null,
    artifacts: [art("x", "log", "b")],
  });
  const merged = mergeModelVerdicts(
    code,
    [
      { criterionId: "1", verdict: "unverifiable", reason: "the test asserted a different field", evidenceArtifactIds: [] },
      { criterionId: "2", verdict: "pass", reason: "looks fine actually", evidenceArtifactIds: ["x", "ghost"] },
      { criterionId: "3", verdict: "fail", reason: "must be broken", evidenceArtifactIds: [] },
      { criterionId: "4", verdict: "fail", reason: "flaky means broken", evidenceArtifactIds: [] },
    ],
    [art("x", "log", "b")]
  );
  assert.equal(merged[0].verdict, "unverifiable");
  assert.equal(merged[0].reason, "the test asserted a different field");
  assert.equal(merged[1].verdict, "fail", "fail → pass is not allowed");
  assert.equal(merged[1].reason, "looks fine actually");
  assert.deepEqual(merged[1].evidenceRefs.filter((r) => r.artifactId).map((r) => r.artifactId), ["x"], "unknown artifact ids are dropped");
  assert.equal(merged[2].verdict, "unverifiable", "unverifiable → fail is not allowed");
  assert.equal(merged[3].verdict, "unverifiable");
  assert.equal(merged[3].reason, FLAKY_REASON, "flaky reason is preserved");
});

test("runVerifyJudge completes the run, records flake history, logs, and keeps mechanical verdicts if the model call fails", async () => {
  // The late report update is best-effort; keep it off the network.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })) as any;
  const installId = uuid();
  db.insert("installations", { id: installId, userId: "", accountId: 1, accountLogin: "acme", installationId: 1, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "w", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  const review = db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 3, prTitle: "t", headSha: "abc", baseSha: "d", status: "reviewing", verdict: null, criteria: [crit("1"), crit("2")], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
  snapshotCriteriaRevision(review.id, review.criteria, null);
  const run = createVerifyRun({ review, repo, status: "judging", triggeredBy: { kind: "pr_event" } });
  const plan = db.insert("verifyPlans", {
    id: uuid(), schemaVersion: 1, runId: run.id, repoId: repo.id, criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0,
    tests: [
      { id: "t1", path: ".devasign/tests/a.test.ts", content: "x", criterionIds: ["1"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "sig1", strategyVersion: 1, targetFiles: [] },
      { id: "t2", path: ".devasign/tests/b.test.ts", content: "x", criterionIds: ["2"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "sig2", strategyVersion: 1, targetFiles: [] },
    ],
  });
  const results = db.insert("verifyResults", {
    id: uuid(), schemaVersion: 1, runId: run.id, createdAt: 0,
    payload: {
      runId: run.id, sha: "abc", planId: plan.id, cliVersion: "0.1", existingTestsTouchingDiff: [], timings: { startedAt: 0, finishedAt: 1 },
      results: [
        result({ testId: "t1", criterionIds: ["1"], status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 1, artifactIds: [] }] }),
        result({ testId: "t2", criterionIds: ["2"], status: "flaky", attempts: [{ n: 1, status: "fail", durationMs: 1, artifactIds: [] }, { n: 2, status: "pass", durationMs: 1, artifactIds: [] }] }),
      ],
    },
  });
  updateRun(run.id, { planId: plan.id, resultsId: results.id });
  try {
    const out = await runVerifyJudge(run.id, { llm: async () => { throw new Error("model down"); } });
    assert.equal(out?.status, "completed");
    assert.deepEqual(out?.verdicts.map((v) => [v.criterionId, v.verdict]), [["1", "pass"], ["2", "unverifiable"]]);
    assert.equal(out?.verdicts[1].flaky, true);
    const flaky = db.find("testFlakeHistory", (r) => r.repoId === repo.id && r.testSignature === "sig2");
    assert.equal(flaky?.flakeCount, 1);
    assert.ok(flaky?.quarantinedAt);
    const stable = db.find("testFlakeHistory", (r) => r.repoId === repo.id && r.testSignature === "sig1");
    assert.equal(stable?.flakeCount, 0);
    assert.ok(db.find("reviewLogs", (l) => l.reviewId === review.id && l.kind === "verify" && /Verification complete: 1 passed, 0 failed, 1 unverifiable/.test(l.action)));
  } finally {
    globalThis.fetch = originalFetch;
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("verifyPlans", (p) => p.id === plan.id);
    db.remove("verifyResults", (r) => r.id === results.id);
    db.remove("testFlakeHistory", (r) => r.repoId === repo.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
  }
});

// The CLI's doctor covers only the tests it could not run (usually the e2e
// subset); unit/integration results collected before it are real evidence.
test("a doctor diagnosis only clouds the criteria whose own tests could not run", () => {
  const criteria = [
    { id: "1", text: "checkout works end to end", met: null, evidence: null, kind: "ui" },
    { id: "2", text: "total is formatted as currency", met: null, evidence: null },
    { id: "3", text: "refunds line hidden at zero", met: null, evidence: null },
    { id: "4", text: "no test was planned", met: null, evidence: null },
  ] as any;
  const result = (id: string, criterionId: string, status: string) =>
    ({ id, testId: `t-${id}`, criterionIds: [criterionId], test: "x", runner: "node-test", level: "unit", origin: "generated", status, attempts: [{ n: 1, status: status === "pass" ? "pass" : "fail", durationMs: 1, artifactIds: [] }], durationMs: 1, artifactIds: [] }) as any;
  const doctor = { stage: "start", code: "no_start_command", message: "no app start / login configured" } as any;
  const out = computeVerdicts({
    criteria,
    results: [result("r1", "1", "error"), result("r2", "2", "fail"), result("r3", "3", "pass")],
    plan: null,
    doctor,
    artifacts: [],
  });
  const by = new Map(out.map((v) => [v.criterionId, v]));
  assert.equal(by.get("1")?.verdict, "unverifiable", "the e2e criterion the doctor explains");
  assert.match(by.get("1")!.reason, /setup needs attention/);
  assert.equal(by.get("2")?.verdict, "fail", "a unit test that ran and failed is still a failure");
  assert.equal(by.get("3")?.verdict, "pass", "a unit test that ran and passed is still a pass");
  assert.equal(by.get("4")?.verdict, "unverifiable");
  assert.match(by.get("4")!.reason, /setup needs attention/);
});

test("a browser test that ran decides its criterion; the tests below it count only when it could not run", () => {
  const e2e = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, runner: "playwright", level: "e2e" });
  const unit = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, ...(status === "fail" ? { error: "expected 1 to be 2" } : {}) });
  const out = computeVerdicts({
    criteria: ["1", "2", "3", "4", "5"].map((id) => crit(id, "ui")),
    results: [
      e2e("b1", "1", "pass"), unit("u1", "1", "fail"),
      e2e("b2", "2", "fail"), unit("u2", "2", "pass"),
      e2e("b3", "3", "error"), unit("u3", "3", "pass"),
      e2e("b4", "4", "error"), unit("u4", "4", "fail"),
      e2e("b5", "5", "error"), unit("u5", "5", "error"),
    ],
    plan: null,
    doctor: null,
    artifacts: [],
  });
  assert.deepEqual(out.map((v) => [v.criterionId, v.verdict]), [["1", "pass"], ["2", "fail"], ["3", "pass"], ["4", "fail"], ["5", "unverifiable"]]);
  assert.ok(out[0].evidenceRefs.every((r) => r.testId === "b1"), "the fallback the browser overruled is not cited");
  assert.deepEqual(out.map((v) => v.browser), ["ran", "ran", "fallback", "fallback", undefined], "an unverifiable the fallback could not decide is not stamped");
  const noBoot = computeVerdicts({
    criteria: [crit("1", "ui")],
    results: [e2e("b1", "1", "error"), unit("u1", "1", "pass")],
    plan: null,
    doctor: { stage: "start", code: "no_start_command", message: "no start command" },
    artifacts: [],
  });
  assert.equal(noBoot[0].verdict, "pass", "an app that would not boot costs nothing when the fallback ran");
  assert.equal(noBoot[0].browser, "fallback");
});

test("only UI criteria with browser results are stamped; doctor and no-coverage verdicts never are", () => {
  const e2e = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, runner: "playwright", level: "e2e" });
  const out = computeVerdicts({
    criteria: [crit("component", "ui"), crit("code"), crit("doctored", "ui"), crit("nothing", "ui")],
    results: [
      result({ testId: "c1", criterionIds: ["component"], status: "pass", level: "component" }),
      e2e("b2", "code", "pass"),
      e2e("b3", "doctored", "error"),
    ],
    plan: null,
    doctor: { stage: "start", code: "app_not_ready", message: "app did not come up" },
    artifacts: [],
  });
  assert.deepEqual(out.map((v) => [v.criterionId, v.verdict, v.browser]), [
    ["component", "pass", undefined],
    ["code", "pass", undefined],
    ["doctored", "unverifiable", undefined],
    ["nothing", "unverifiable", undefined],
  ]);
});

test("e2e: always turns every verdict the browser could not decide into unverifiable with a fix link, pass or fail", () => {
  const browser = (policy: "auto" | "always") => ({ unverifiable: [], browser: { policy, allowed: true, bootConfigured: true, reason: "ok", fixUrl: "https://app/workflow?repo=r&setup=browser" } }) as unknown as VerifyPlan;
  const e2e = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, runner: "playwright", level: "e2e" });
  const unit = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, ...(status === "fail" ? { error: "expected 1 to be 2" } : {}) });
  const args = {
    criteria: [crit("1", "ui"), crit("2", "ui"), crit("3", "ui"), crit("4"), crit("5", "ui"), crit("6", "ui"), crit("7")],
    results: [
      e2e("b1", "1", "error"), unit("u1", "1", "pass"),
      e2e("b2", "2", "skipped"), unit("u2", "2", "fail"),
      e2e("b3", "3", "pass"),
      unit("u4", "4", "pass"),
      e2e("b5", "5", "error"),
      e2e("b6", "6", "error"), result({ testId: "u6", criterionIds: ["6"], status: "flaky", attempts: [attempt(1, "fail"), attempt(2, "pass")] }),
      unit("u7", "7", "fail"),
    ],
    doctor: null,
    artifacts: [art("f1", "test_file", "u1")],
  };
  const fixUrl = "https://app/workflow?repo=r&setup=browser";
  const strict = computeVerdicts({ ...args, plan: browser("always") });
  assert.deepEqual(strict.map((v) => [v.criterionId, v.verdict, v.browser, v.fixUrl]), [
    ["1", "unverifiable", "fallback", fixUrl],
    ["2", "unverifiable", "fallback", fixUrl],
    ["3", "pass", "ran", undefined],
    ["4", "pass", undefined, undefined],
    ["5", "unverifiable", undefined, fixUrl],
    ["6", "unverifiable", undefined, fixUrl],
    ["7", "fail", undefined, undefined],
  ]);
  for (const i of [0, 1, 4, 5]) assert.equal(strict[i].reason, "the app did not start for browser tests", `criterion ${strict[i].criterionId}`);
  assert.ok(strict[0].evidenceRefs.some((r) => r.artifactId === "f1"), "the fallback's evidence stays cited");
  assert.equal(strict[5].flaky, undefined, "the browser, not the flaky test below it, is why it went unverified");
  assert.match(strict[6].reason, /assertion failed/, "a non-UI criterion is never refused");

  const doctored = computeVerdicts({ ...args, plan: browser("always"), doctor: { stage: "start", code: "app_not_ready", message: "app did not come up", logArtifactId: "log" } });
  assert.deepEqual([doctored[4].verdict, doctored[4].reason, doctored[4].fixUrl], ["unverifiable", "the app did not start for browser tests", fixUrl]);
  assert.deepEqual(doctored[4].evidenceRefs, [{ artifactId: "log" }]);

  const auto = computeVerdicts({ ...args, plan: browser("auto") });
  assert.deepEqual(auto.map((v) => [v.criterionId, v.verdict, v.browser]), [["1", "pass", "fallback"], ["2", "fail", "fallback"], ["3", "pass", "ran"], ["4", "pass", undefined], ["5", "unverifiable", undefined], ["6", "unverifiable", undefined], ["7", "fail", undefined]]);
  assert.ok(auto.every((v) => v.fixUrl === undefined));
  assert.match(auto[4].reason, /^test could not run/);
  assert.equal(auto[5].reason, FLAKY_REASON);

  const merged = mergeModelVerdicts(
    [...strict, auto[0]],
    [
      { criterionId: "1", verdict: "unverifiable", reason: "The browser never loaded.", evidenceArtifactIds: [] },
      { criterionId: "3", verdict: "unverifiable", reason: "The screenshot shows a different page.", evidenceArtifactIds: [] },
      { criterionId: "5", verdict: "unverifiable", reason: "The page timed out.", evidenceArtifactIds: [] },
      { criterionId: "7", verdict: "fail", reason: "The total is wrong.", evidenceArtifactIds: [] },
    ],
    []
  );
  assert.equal(merged[0].reason, "the app did not start for browser tests", "the strict reason is fixed wording");
  assert.equal(merged[0].browser, "fallback");
  assert.equal(merged[0].fixUrl, "https://app/workflow?repo=r&setup=browser");
  assert.equal(merged[2].verdict, "unverifiable");
  assert.equal(merged[2].browser, "ran", "a model downgrade keeps the stamp");
  assert.equal(merged[4].reason, "the app did not start for browser tests", "fixed wording on an unstamped row too");
  assert.equal(merged[6].reason, "The total is wrong.");
  assert.equal(merged[7].reason, "The browser never loaded.");
  assert.equal(merged[7].browser, "fallback");
});

test("browser tests withheld from the runner: covered UI criteria fall back, e2e: always refuses them, and one nothing checked links to setup", () => {
  const fixUrl = "https://app/workflow?repo=r&setup=browser";
  const plan = (policy: "auto" | "always") => ({
    unverifiable: [],
    tests: [
      { id: "b1", level: "e2e", runner: "playwright", criterionIds: ["1", "2", "3"] },
      { id: "b4", level: "e2e", runner: "playwright", criterionIds: ["4"] },
      { id: "u5", level: "unit", criterionIds: ["5"] },
      { id: "b6", level: "e2e", runner: "playwright", criterionIds: ["6"] },
      { id: "c7", level: "component", runner: "playwright", criterionIds: ["7"] },
    ],
    browser: { policy, allowed: true, bootConfigured: true, reason: "ok", fixUrl },
  }) as unknown as VerifyPlan;
  const unit = (testId: string, id: string, status: RunnerResult["status"]) => result({ testId, criterionIds: [id], status, ...(status === "fail" ? { error: "expected 1 to be 2" } : {}) });
  const args = {
    criteria: [crit("1", "ui"), crit("2", "ui"), crit("3", "ui"), crit("4"), crit("5", "ui"), crit("6", "ui"), crit("7", "ui")],
    results: [unit("u1", "1", "pass"), unit("u2", "2", "fail"), unit("u5", "5", "pass"), result({ testId: "b6", criterionIds: ["6"], status: "pass", runner: "playwright", level: "e2e" })],
    doctor: null,
    artifacts: [art("f1", "test_file", "u1")],
  };
  const row = (v: CriterionVerdict) => [v.criterionId, v.verdict, v.browser, v.fixUrl];

  const auto = computeVerdicts({ ...args, plan: plan("auto"), withheld: "runner_outdated" });
  assert.deepEqual(auto.map(row), [
    ["1", "pass", "fallback", undefined],
    ["2", "fail", "fallback", undefined],
    ["3", "unverifiable", undefined, fixUrl],
    ["4", "unverifiable", undefined, undefined],
    ["5", "pass", undefined, undefined],
    ["6", "pass", "ran", undefined],
    ["7", "unverifiable", undefined, fixUrl],
  ]);
  assert.equal(auto[6].reason, RUNNER_OUTDATED_REASON, "a withheld Playwright test below e2e level was held back too");
  assert.equal(auto[0].reason, "the test passed", "the lower test's verdict stands");
  assert.equal(auto[2].reason, RUNNER_OUTDATED_REASON);
  assert.equal(auto[3].reason, "no test ran for this criterion", "a non-UI criterion is untouched");

  const strict = computeVerdicts({ ...args, plan: plan("always"), withheld: "runner_outdated" });
  assert.deepEqual(strict.map(row), [
    ["1", "unverifiable", "fallback", fixUrl],
    ["2", "unverifiable", "fallback", fixUrl],
    ["3", "unverifiable", undefined, fixUrl],
    ["4", "unverifiable", undefined, undefined],
    ["5", "pass", undefined, undefined],
    ["6", "pass", "ran", undefined],
    ["7", "unverifiable", undefined, fixUrl],
  ]);
  for (const i of [0, 1, 2, 6]) assert.equal(strict[i].reason, RUNNER_OUTDATED_REASON, `criterion ${strict[i].criterionId}`);
  assert.ok(strict[0].evidenceRefs.some((r) => r.artifactId === "f1"), "the fallback's evidence stays cited");

  const off = computeVerdicts({ ...args, plan: plan("always"), withheld: "managed_boot_off" });
  assert.deepEqual(off.map(row), [
    ["1", "unverifiable", "fallback", undefined],
    ["2", "unverifiable", "fallback", undefined],
    ["3", "unverifiable", undefined, undefined],
    ["4", "unverifiable", undefined, undefined],
    ["5", "pass", undefined, undefined],
    ["6", "pass", "ran", undefined],
    ["7", "unverifiable", undefined, undefined],
  ], "a pause is DevAsign's switch: no setup link");
  for (const i of [0, 1, 2, 6]) assert.equal(off[i].reason, BOOT_PAUSED_REASON, `criterion ${off[i].criterionId}`);
  const offAuto = computeVerdicts({ ...args, plan: plan("auto"), withheld: "managed_boot_off" });
  assert.deepEqual([offAuto[0].verdict, offAuto[0].browser, offAuto[2].reason, offAuto[2].fixUrl], ["pass", "fallback", BOOT_PAUSED_REASON, undefined]);
  assert.ok(!off.some((v) => v.reason === NO_BROWSER_REASON), "never reads as an app that did not start");
  assert.equal(mergeModelVerdicts(off, [{ criterionId: "1", verdict: "unverifiable", reason: "Browser missing.", evidenceArtifactIds: [] }], [])[0].reason, BOOT_PAUSED_REASON);

  const notWithheld = computeVerdicts({ ...args, plan: plan("always") });
  assert.deepEqual(notWithheld.map(row), [
    ["1", "pass", undefined, undefined],
    ["2", "fail", undefined, undefined],
    ["3", "unverifiable", undefined, undefined],
    ["4", "unverifiable", undefined, undefined],
    ["5", "pass", undefined, undefined],
    ["6", "pass", "ran", undefined],
    ["7", "unverifiable", undefined, undefined],
  ], "a planned browser test with no result is not a withheld one");
  assert.equal(notWithheld[2].reason, "no test ran for this criterion");
  assert.deepEqual(computeVerdicts({ ...args, plan: plan("always"), withheld: null }), notWithheld);

  const merged = mergeModelVerdicts(strict, [
    { criterionId: "1", verdict: "unverifiable", reason: "The runner is old.", evidenceArtifactIds: [] },
    { criterionId: "3", verdict: "unverifiable", reason: "Nothing ran.", evidenceArtifactIds: [] },
  ], []);
  assert.deepEqual([merged[0].reason, merged[2].reason], [RUNNER_OUTDATED_REASON, RUNNER_OUTDATED_REASON], "fixed wording the model may not rewrite");
  assert.equal(merged[2].fixUrl, fixUrl);
});

test("a planned fix link rides on the no-result verdict and survives the model's reason rewrite", () => {
  const plan = { unverifiable: [{ criterionId: "1", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=r" }] } as unknown as VerifyPlan;
  const code = computeVerdicts({ criteria: [crit("1", "ui")], results: [], plan, doctor: null, artifacts: [] });
  assert.equal(code[0].fixUrl, "https://app/workflow?repo=r");
  const merged = mergeModelVerdicts(code, [{ criterionId: "1", verdict: "unverifiable", reason: "No app start was configured, so the pill was never exercised.", evidenceArtifactIds: [] }], []);
  assert.equal(merged[0].reason, "No app start was configured, so the pill was never exercised.");
  assert.equal(merged[0].fixUrl, "https://app/workflow?repo=r");
});

test("the reason quotes the attempt behind the result's status, not the last test to run", () => {
  const pw = { runner: "playwright", level: "e2e" } as const;
  const timeout = "Test timeout of 30000ms exceeded.";
  const out = computeVerdicts({
    criteria: [crit("1", "ui"), crit("2", "ui")],
    results: [
      // bishopBethel/fundsflow#23 as the CLI sent it.
      result({ ...pw, testId: "t1", criterionIds: ["1"], status: "error", attempts: [attempt(1, "error", timeout), attempt(2, "pass", "")] }),
      result({ ...pw, testId: "t2", criterionIds: ["2"], status: "fail", error: timeout, attempts: [attempt(1, "fail", "expect(bar).toHaveCSS() failed"), attempt(2, "fail", "expect(bar).toHaveCSS() failed"), attempt(3, "error", timeout)] }),
    ],
    plan: null,
    doctor: null,
    artifacts: [],
  });
  assert.equal(out[0].reason, `test could not run: ${timeout}`);
  assert.equal(out[1].reason, "assertion failed on the test run: expect(bar).toHaveCSS() failed");
});

test("the judge's evidence never presents a Playwright file's test() blocks as retries", () => {
  const timeout = "Test timeout of 30000ms exceeded.";
  const criteria = [crit("1", "ui"), crit("2")];
  const results = [
    result({ runner: "playwright", level: "e2e", test: ".devasign/tests/e2e/canvas-edge-color-bar.spec.ts", testId: "t1", criterionIds: ["1"], status: "error", attempts: [attempt(1, "error", timeout), attempt(2, "pass", "")] }),
    result({ test: ".devasign/tests/total.test.ts", testId: "t2", criterionIds: ["2"], status: "fail", attempts: [attempt(1, "fail", "AssertionError: expected 2 to equal 3"), attempt(2, "fail", "AssertionError: expected 2 to equal 3")] }),
  ];
  const code = computeVerdicts({ criteria, results, plan: null, doctor: null, artifacts: [] });
  const prompt = buildJudgeUserPrompt({ criteria, code, results, artifacts: [], logs: new Map(), doctor: null });
  assert.match(prompt, /2 result\(s\) across its test\(\) blocks and their retries/);
  assert.match(prompt, /result 1: error in 1ms — Test timeout of 30000ms exceeded\./);
  assert.match(prompt, /result 2: pass/);
  assert.doesNotMatch(prompt, /attempt 1: error/, "a sibling test's pass must never read as a retry");
  // Other runners re-run the whole file, so their entries really are retries.
  assert.match(prompt, /, 2 attempt\(s\)/);
  assert.match(prompt, /attempt 2: fail/);
});

test("only re-runs of one test are reported as failing on every attempt", () => {
  const msg = "AssertionError: expected 2 to equal 3";
  const out = computeVerdicts({
    criteria: [crit("1"), crit("2"), crit("3", "ui")],
    results: [
      result({ testId: "t1", criterionIds: ["1"], status: "fail", error: msg, attempts: [attempt(1, "fail", msg), attempt(2, "fail", msg)] }),
      result({ testId: "t2", criterionIds: ["2"], status: "fail", error: "timed out after 60000ms", attempts: [attempt(1, "fail", msg), attempt(2, "error", "timed out after 60000ms")] }),
      // Two test() blocks that each failed once, not one test that failed twice.
      result({ testId: "t3", criterionIds: ["3"], runner: "playwright", level: "e2e", status: "fail", attempts: [attempt(1, "fail", "expect(bar).toBeVisible() failed"), attempt(2, "fail", "expect(edge).toBeVisible() failed")] }),
    ],
    plan: null,
    doctor: null,
    artifacts: [],
  });
  assert.equal(out[0].reason, `assertion failed on all 2 attempts: ${msg}`);
  assert.equal(out[1].reason, `assertion failed on the test run: ${msg}`, "an errored retry did not fail an assertion");
  assert.equal(out[2].reason, "assertion failed on the test run: expect(bar).toBeVisible() failed");
});

async function judgeWithBrowserPlan(args: {
  criteria: Criterion[];
  results: RunnerResult[];
  browser?: VerifyPlan["browser"];
  lastBrowserless?: NonNullable<RepoVerifyState["lastBrowserless"]>;
  doctor?: DoctorDiagnosis;
  tests?: VerifyPlan["tests"];
  withheld?: NonNullable<VerifyRun["runnerMeta"]>["e2eWithheld"];
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })) as any;
  const installId = uuid();
  db.insert("installations", { id: installId, userId: "", accountId: 1, accountLogin: "acme", installationId: 1, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "w", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true, ...(args.lastBrowserless ? { verify: { onboarding: { state: "none" }, lastBrowserless: args.lastBrowserless } } : {}) } as any);
  const review = db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 7, prTitle: "t", headSha: "abc", baseSha: "d", status: "reviewing", verdict: null, criteria: args.criteria, taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
  snapshotCriteriaRevision(review.id, review.criteria, null);
  const run = createVerifyRun({ review, repo, status: "judging", triggeredBy: { kind: "pr_event" } });
  const plan = db.insert("verifyPlans", { id: uuid(), schemaVersion: 1, runId: run.id, repoId: repo.id, criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: args.tests ?? [], ...(args.browser ? { browser: args.browser } : {}) });
  const results = db.insert("verifyResults", {
    id: uuid(), schemaVersion: 1, runId: run.id, createdAt: 0,
    payload: { runId: run.id, sha: "abc", planId: plan.id, cliVersion: "0.1", existingTestsTouchingDiff: [], timings: { startedAt: 0, finishedAt: 1 }, results: args.results, ...(args.doctor ? { doctor: args.doctor } : {}) },
  });
  updateRun(run.id, { planId: plan.id, resultsId: results.id, ...(args.withheld ? { runnerMeta: { e2eWithheld: args.withheld } } : {}) });
  try {
    const out = await runVerifyJudge(run.id, { llm: async () => "{}" });
    return { run: out!, verify: db.find("repositories", (r) => r.id === repo.id)?.verify };
  } finally {
    globalThis.fetch = originalFetch;
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("verifyPlans", (p) => p.id === plan.id);
    db.remove("verifyResults", (r) => r.id === results.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
  }
}

test("a judged run records which UI criteria went without a browser on the repo, and clears it only when it had UI criteria", async () => {
  const browser = (over: Partial<NonNullable<VerifyPlan["browser"]>> = {}) => ({ policy: "auto", allowed: false, bootConfigured: false, reason: "no_boot", fixUrl: "https://app/workflow?repo=r&setup=browser", ...over }) as NonNullable<VerifyPlan["browser"]>;
  const unitPass = (id: string) => result({ testId: `u${id}`, criterionIds: [id], status: "pass" });
  const e2e = (id: string, status: RunnerResult["status"]) => result({ testId: `b${id}`, criterionIds: [id], status, runner: "playwright", level: "e2e" });
  const earlier = { count: 2, reason: "not_configured" as const, runId: "earlier", prNumber: 1, at: 1 };

  const unconfigured = await judgeWithBrowserPlan({ criteria: [crit("1", "ui"), crit("2", "ui"), crit("3")], results: [unitPass("1"), unitPass("2"), unitPass("3")], browser: browser() });
  assert.equal(unconfigured.run.status, "completed");
  assert.deepEqual({ ...unconfigured.verify?.lastBrowserless, at: 0 }, { count: 2, reason: "not_configured", runId: unconfigured.run.id, prNumber: 7, at: 0 });
  assert.ok(unconfigured.verify!.lastBrowserless!.at > 1);

  const didNotStart = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "error"), unitPass("1")], browser: browser({ allowed: true, bootConfigured: true, reason: "ok" }), lastBrowserless: earlier });
  assert.equal(didNotStart.verify?.lastBrowserless?.reason, "did_not_start");
  assert.equal(didNotStart.verify?.lastBrowserless?.count, 1);

  const strict = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "error"), unitPass("1")], browser: browser({ policy: "always", allowed: true, bootConfigured: true, reason: "ok" }), lastBrowserless: earlier });
  assert.equal(strict.run.verdicts[0].verdict, "unverifiable");
  assert.deepEqual([strict.verify?.lastBrowserless?.reason, strict.verify?.lastBrowserless?.count], ["did_not_start", 1], "a fallback e2e: always refused still marks the app as not starting");
  const strictNoBoot = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [], browser: browser({ policy: "always" }), lastBrowserless: earlier });
  assert.equal(strictNoBoot.verify?.lastBrowserless, null, "a UI criterion withheld from the planner was never checked, so it is not counted");

  const ran = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "pass")], browser: browser({ allowed: true, bootConfigured: true, reason: "ok" }), lastBrowserless: earlier });
  assert.equal(ran.verify?.lastBrowserless, null, "a browser that ran clears the flag");

  const booted = browser({ allowed: true, bootConfigured: true, reason: "ok" });
  const startedBefore = { count: 3, reason: "did_not_start" as const, runId: "pr-a", prNumber: 4, at: 1 };
  const browserOnly = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "error")], browser: booted, lastBrowserless: startedBefore });
  assert.equal(browserOnly.run.verdicts[0].verdict, "unverifiable");
  assert.deepEqual(browserOnly.verify?.lastBrowserless, startedBefore, "browser tests that could not run keep the app-did-not-start flag");
  const firstNoStart = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "skipped")], browser: booted, lastBrowserless: earlier });
  assert.deepEqual({ ...firstNoStart.verify?.lastBrowserless, at: 0 }, { count: 0, reason: "did_not_start", runId: firstNoStart.run.id, prNumber: 7, at: 0 }, "and record one when there was none");
  const strictBrowserOnly = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "error")], browser: { ...booted, policy: "always" }, lastBrowserless: startedBefore });
  assert.equal(strictBrowserOnly.run.verdicts[0].reason, "the app did not start for browser tests");
  assert.deepEqual(strictBrowserOnly.verify?.lastBrowserless, startedBefore);
  const doctored = await judgeWithBrowserPlan({ criteria: [crit("1", "ui"), crit("2", "ui")], results: [], browser: booted, lastBrowserless: startedBefore, doctor: { stage: "start", code: "app_not_ready", message: "app did not come up" } });
  assert.match(doctored.run.verdicts[0].reason, /setup needs attention/);
  assert.deepEqual(doctored.verify?.lastBrowserless, startedBefore, "a run the doctor flagged proves nothing about the app starting");
  const oneStarted = await judgeWithBrowserPlan({ criteria: [crit("1", "ui"), crit("2", "ui")], results: [e2e("1", "error"), e2e("2", "pass")], browser: booted, lastBrowserless: startedBefore });
  assert.equal(oneStarted.verify?.lastBrowserless, null, "one browser test that ran shows the app started");

  const never = await judgeWithBrowserPlan({ criteria: [crit("1")], results: [unitPass("1")], browser: browser({ policy: "never", reason: "never" }), lastBrowserless: earlier });
  assert.equal(never.verify?.lastBrowserless, null, "e2e: never clears it even without UI criteria");

  const backendOnly = await judgeWithBrowserPlan({ criteria: [crit("1")], results: [unitPass("1")], browser: browser(), lastBrowserless: earlier });
  assert.deepEqual(backendOnly.verify?.lastBrowserless, earlier, "a PR with no UI criteria leaves another PR's flag alone");

  const oldPlan = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [unitPass("1")], lastBrowserless: earlier });
  assert.deepEqual(oldPlan.verify?.lastBrowserless, earlier, "a plan without a browser policy says nothing");

  const nothingToClear = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [e2e("1", "pass")], browser: browser({ allowed: true }) });
  assert.ok(nothingToClear.verify && !("lastBrowserless" in nothingToClear.verify), "no write when there is nothing to clear");
});

test("a run whose browser tests were withheld flags the repo's runner as outdated, and a kill-switch pause records nothing", async () => {
  const booted = { policy: "auto", allowed: true, bootConfigured: true, reason: "ok", fixUrl: "https://app/workflow?repo=r&setup=browser" } as NonNullable<VerifyPlan["browser"]>;
  const tests = [{ id: "b1", level: "e2e", runner: "playwright", criterionIds: ["1"] }] as unknown as VerifyPlan["tests"];
  const unitPass = (id: string) => result({ testId: `u${id}`, criterionIds: [id], status: "pass" });
  const earlier = { count: 2, reason: "not_configured" as const, runId: "earlier", prNumber: 1, at: 1 };

  const outdated = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [unitPass("1")], browser: booted, tests, withheld: "runner_outdated", lastBrowserless: earlier });
  assert.deepEqual([outdated.run.verdicts[0].verdict, outdated.run.verdicts[0].browser], ["pass", "fallback"]);
  assert.deepEqual({ ...outdated.verify?.lastBrowserless, at: 0 }, { count: 1, reason: "runner_outdated", runId: outdated.run.id, prNumber: 7, at: 0 });

  const nothingRan = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [], browser: booted, tests, withheld: "runner_outdated", lastBrowserless: earlier });
  assert.equal(nothingRan.run.verdicts[0].reason, RUNNER_OUTDATED_REASON);
  assert.deepEqual([nothingRan.verify?.lastBrowserless?.reason, nothingRan.verify?.lastBrowserless?.count], ["runner_outdated", 0], "nothing below the browser ran, but the runner is still why");
  const keptCount = { count: 4, reason: "runner_outdated" as const, runId: "pr-a", prNumber: 3, at: 1 };
  const again = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [], browser: booted, tests, withheld: "runner_outdated", lastBrowserless: keptCount });
  assert.deepEqual(again.verify?.lastBrowserless, keptCount, "an existing runner flag keeps its count");

  const off = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [unitPass("1")], browser: booted, tests, withheld: "managed_boot_off", lastBrowserless: keptCount });
  assert.deepEqual([off.run.verdicts[0].verdict, off.run.verdicts[0].browser], ["pass", "fallback"]);
  assert.deepEqual(off.verify?.lastBrowserless, keptCount, "a paused run leaves the repo's last real finding alone");
  const offNothingRan = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [], browser: booted, tests, withheld: "managed_boot_off" });
  assert.equal(offNothingRan.run.verdicts[0].reason, BOOT_PAUSED_REASON);
  assert.ok(offNothingRan.verify && !("lastBrowserless" in offNothingRan.verify), "and never records did_not_start");

  const updated = await judgeWithBrowserPlan({ criteria: [crit("1", "ui")], results: [result({ testId: "b1", criterionIds: ["1"], status: "pass", runner: "playwright", level: "e2e" })], browser: booted, tests, lastBrowserless: keptCount });
  assert.equal(updated.verify?.lastBrowserless, null, "a runner that ran the browser test clears the flag");
  const noUiE2e = await judgeWithBrowserPlan({ criteria: [crit("1", "ui"), crit("2")], results: [unitPass("1")], browser: booted, tests: [{ id: "b2", level: "e2e", runner: "playwright", criterionIds: ["2"] }] as unknown as VerifyPlan["tests"], withheld: "runner_outdated", lastBrowserless: keptCount });
  assert.equal(noUiE2e.verify?.lastBrowserless, null, "withheld browser tests for a non-UI criterion leave the UI criteria unflagged");
});
