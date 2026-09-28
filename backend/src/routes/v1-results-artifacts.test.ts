// Posting results confirms which signed artifacts actually uploaded, and only the job that
// resolved a run may post them. A test's own file is never listed in any result's artifactIds,
// so it must be confirmed by testId or it stays pending_upload with no URL. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/v1-results-artifacts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { setArtifactStorageForTests, type ArtifactStorage } from "../verify/storage.js";
import { artifactsHandler, resultsHandler, runClaimedBy, uploadedOnResults } from "./v1.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

const artifact = (runId: string, repoId: string, over: Record<string, unknown>) =>
  ({ id: uuid(), schemaVersion: 1, runId, repoId, criterionIds: [], path: "p", storageKey: "k", bytes: 1, contentType: "text/plain", posterArtifactId: null, state: "pending_upload", expiresAt: Date.now() + 1e6, uploadedAt: null, expiredAt: null, createdAt: Date.now(), ...over }) as any;

const result = (testId: string, logId?: string) => ({
  id: `r-${testId}`, testId, criterionIds: ["1"], test: `${testId}.test.ts`, runner: "node-test", level: "unit", origin: "generated", status: "fail",
  attempts: [{ n: 1, status: "fail", durationMs: 1, artifactIds: logId ? [logId] : [] }], durationMs: 1, artifactIds: [],
});

const storage: ArtifactStorage = {
  signPut: async (key) => ({ url: `https://bucket.test/${key}`, headers: {} }),
  signGet: async (key) => `https://bucket.test/${key}`,
  head: async () => null,
  remove: async () => {},
};

// The job whose resolve claimed the run: PR 3's pull_request run 900, first attempt.
const CLAIMER = { ref: "refs/pull/3/merge", event_name: "pull_request", repository: "acme/widgets", run_id: "900", run_attempt: "1" };

function seedRun(over: Record<string, unknown> = {}) {
  const repoId = uuid(), runId = uuid();
  db.insert("verifyRuns", { id: runId, schemaVersion: 1, reviewId: uuid(), repoId, installationId: uuid(), prNumber: 3, sha: "abc", attempt: 1, status: "running", criteriaRevision: 1, planTier: "pro", verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, runnerMeta: { actionsRunId: "900", runAttempt: "1" }, createdAt: Date.now(), updatedAt: Date.now(), ...over } as any);
  const cleanup = () => {
    db.remove("verifyResults", (r) => r.runId === runId);
    db.remove("verifyArtifacts", (a) => a.runId === runId);
    db.remove("verifyRuns", (r) => r.id === runId);
  };
  return { repoId, runId, cleanup };
}

const runnerReq = (repoId: string, runId: string, body: unknown, claims: Record<string, unknown> = {}) =>
  ({ runner: { repo: { id: repoId }, claims: { ...CLAIMER, ...claims }, plan: "pro" }, params: { runId }, body }) as any;

const signBody = { files: [{ clientRef: "log", kind: "log", path: ".devasign/run.log", bytes: 10, contentType: "text/plain" }] };

async function post(handler: typeof resultsHandler, req: any) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test("uploadedOnResults confirms a test file only when its test was reported", () => {
  const reported = artifact("run", "repo", { kind: "test_file", testId: "t1" });
  const unreported = artifact("run", "repo", { kind: "test_file", testId: "t2" });
  const orphan = artifact("run", "repo", { kind: "test_file" });
  const log = artifact("run", "repo", { kind: "log", testId: "t1" });
  const strayLog = artifact("run", "repo", { kind: "log", testId: "t1" });
  const ids = uploadedOnResults([reported, unreported, orphan, log, strayLog], { results: [result("t1", log.id)] } as any);
  assert.deepEqual(ids.sort(), [reported.id, log.id].sort());
});

test("posting results marks the reported tests' files uploaded alongside their logs", async () => {
  const { repoId, runId, cleanup } = seedRun();
  const file = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "test_file", testId: "t1" }));
  const log = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "log", testId: "t1", attempt: 1 }));
  const skipped = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "test_file", testId: "t9" }));
  try {
    const res = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [result("t1", log.id)] }));
    assert.equal(res.statusCode, 200);
    const state = (id: string) => db.find("verifyArtifacts", (a) => a.id === id)?.state;
    assert.equal(state(file.id), "uploaded", "the test file is readable after results land");
    assert.equal(state(log.id), "uploaded");
    assert.equal(state(skipped.id), "pending_upload", "a file for a test with no result stays unconfirmed");
  } finally {
    cleanup();
  }
});

test("runClaimedBy matches the signed run id and attempt, reading a missing attempt as the first", () => {
  const run = (runnerMeta: unknown) => ({ runnerMeta }) as any;
  const as = (claims: Record<string, unknown>) => ({ claims }) as any;
  assert.equal(runClaimedBy(run({ actionsRunId: "900", runAttempt: "1" }), as({ run_id: "900", run_attempt: "1" })), true);
  assert.equal(runClaimedBy(run({ actionsRunId: "900" }), as({ run_id: "900" })), true, "GitHub's run_attempt claim is optional in the type");
  assert.equal(runClaimedBy(run({ actionsRunId: "900", runAttempt: "1" }), as({ run_id: "900" })), true);
  assert.equal(runClaimedBy(run({ actionsRunId: "900", runAttempt: "2" }), as({ run_id: "900", run_attempt: "1" })), false);
  assert.equal(runClaimedBy(run({ actionsRunId: "900", runAttempt: "1" }), as({ run_id: "9000", run_attempt: "1" })), false);
  assert.equal(runClaimedBy(run(undefined), as({ run_id: "900", run_attempt: "1" })), false, "nothing has claimed it");
});

test("only the job whose resolve claimed a run may sign its artifacts or post its results", async () => {
  // Run ids are on the PR's check run and comment, and a head sha is public on a public repo, so
  // any job that can mint a token for this repo — including a generated test reading its parent's env — knows both.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a job on another PR in the repo", { ref: "refs/pull/4/merge", run_id: "901" }],
    ["another job on the same PR", { run_id: "901" }],
    ["a dispatched job", { ref: "refs/heads/main", event_name: "repository_dispatch", run_id: "902" }],
    ["a later attempt of the claiming run that never resolved", { run_attempt: "2" }],
  ];
  setArtifactStorageForTests(storage);
  const { repoId, runId, cleanup } = seedRun();
  const pending = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "log", testId: "t1" }));
  try {
    for (const [label, claims] of cases) {
      const signed = await post(artifactsHandler, runnerReq(repoId, runId, signBody, claims));
      assert.deepEqual([signed.statusCode, signed.body.error], [403, "actions_run_mismatch"], `${label}: artifacts`);
      const posted = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [result("t1", pending.id)] }, claims));
      assert.deepEqual([posted.statusCode, posted.body.error], [403, "actions_run_mismatch"], `${label}: results`);
      assert.match(posted.body.detail, /only the GitHub Actions job that resolved this run/);
    }
    const run = db.find("verifyRuns", (r) => r.id === runId)!;
    assert.deepEqual([run.status, run.resultsId ?? null], ["running", null], "no forged verdict is queued");
    assert.equal(db.filter("verifyResults", (r) => r.runId === runId).length, 0);
    assert.deepEqual(db.filter("verifyArtifacts", (a) => a.runId === runId).map((a) => [a.id, a.state]), [[pending.id, "pending_upload"]], "nothing signed, nothing confirmed");

    // The control: the claiming job itself goes through, artifacts then results.
    const signed = await post(artifactsHandler, runnerReq(repoId, runId, signBody));
    assert.equal(signed.statusCode, 200);
    assert.equal(signed.body.uploads.length, 1);
    const posted = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [result("t1", signed.body.uploads[0].artifactId)] }));
    assert.deepEqual([posted.statusCode, posted.body.status], [200, "judging"]);
  } finally {
    setArtifactStorageForTests(undefined);
    cleanup();
  }
});

test("a run no job has resolved yet takes artifacts and results from nobody", async () => {
  setArtifactStorageForTests(storage);
  const { repoId, runId, cleanup } = seedRun({ status: "awaiting_runner", runnerMeta: undefined });
  try {
    const signed = await post(artifactsHandler, runnerReq(repoId, runId, signBody));
    assert.deepEqual([signed.statusCode, signed.body.error], [403, "actions_run_mismatch"]);
    const posted = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [] }));
    assert.deepEqual([posted.statusCode, posted.body.error], [403, "actions_run_mismatch"]);
    assert.equal(db.find("verifyRuns", (r) => r.id === runId)!.status, "awaiting_runner");
  } finally {
    setArtifactStorageForTests(undefined);
    cleanup();
  }
});

test("a timed-out run still takes its claiming job's late results, and no one else's", async () => {
  const { repoId, runId, cleanup } = seedRun({ status: "timed_out", error: "the runner did not report results in time" });
  try {
    const stranger = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [result("t1")] }, { run_id: "901" }));
    assert.deepEqual([stranger.statusCode, stranger.body.error], [403, "actions_run_mismatch"]);
    assert.equal(db.find("verifyRuns", (r) => r.id === runId)!.status, "timed_out");

    const late = await post(resultsHandler, runnerReq(repoId, runId, { runId, sha: "abc", results: [result("t1")] }));
    assert.deepEqual([late.statusCode, late.body.status], [200, "judging"]);
    const run = db.find("verifyRuns", (r) => r.id === runId)!;
    assert.equal(run.error, null, "a slow runner that finally reports beats a stale verdict");
    assert.ok(run.resultsId);
  } finally {
    cleanup();
  }
});

test("another repo's run is not found, whoever asks", async () => {
  const { runId, cleanup } = seedRun();
  try {
    const res = await post(resultsHandler, runnerReq(uuid(), runId, { runId, sha: "abc", results: [] }));
    assert.deepEqual([res.statusCode, res.body.error], [404, "run_not_found"], "the claim check must not confirm it exists");
  } finally {
    cleanup();
  }
});
