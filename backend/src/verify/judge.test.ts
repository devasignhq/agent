// Offline: verdicts are computed from what ran; the model may only downgrade.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/judge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { computeVerdicts, FLAKY_REASON, mergeModelVerdicts, runVerifyJudge } from "./judge.js";
import { createVerifyRun, snapshotCriteriaRevision, updateRun } from "./runs.js";
import type { Criterion, VerifyArtifact, VerifyPlan } from "../types.js";
import type { RunnerResult } from "./contract.js";

const crit = (id: string, kind: Criterion["kind"] = "code"): Criterion => ({ id, text: `criterion ${id}`, met: null, evidence: null, kind });
const art = (id: string, kind: VerifyArtifact["kind"], testId: string): VerifyArtifact =>
  ({ id, schemaVersion: 1, runId: "r", repoId: "p", testId, criterionIds: [], kind, path: `${id}.${kind}`, storageKey: id, bytes: 1, contentType: "x", state: "uploaded", expiresAt: Date.now() + 1e6, createdAt: 0 });
const result = (over: Partial<RunnerResult> & { testId: string; criterionIds: string[]; status: RunnerResult["status"] }): RunnerResult => ({
  id: uuid(), test: over.testId, runner: "node-test", level: "unit", origin: "generated", attempts: [], durationMs: 1, artifactIds: [], ...over,
});

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
