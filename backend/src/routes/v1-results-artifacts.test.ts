// Posting results confirms which signed artifacts actually uploaded. A test's own
// file is never listed in any result's artifactIds, so it must be confirmed by
// testId or it stays pending_upload with no URL. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/v1-results-artifacts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { resultsHandler, uploadedOnResults } from "./v1.js";

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
  const repoId = uuid(), runId = uuid();
  db.insert("verifyRuns", { id: runId, schemaVersion: 1, reviewId: uuid(), repoId, installationId: uuid(), prNumber: 3, sha: "abc", attempt: 1, status: "running", criteriaRevision: 1, planTier: "pro", verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt: Date.now(), updatedAt: Date.now() } as any);
  const file = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "test_file", testId: "t1" }));
  const log = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "log", testId: "t1", attempt: 1 }));
  const skipped = db.insert("verifyArtifacts", artifact(runId, repoId, { kind: "test_file", testId: "t9" }));
  try {
    const res = fakeRes();
    await resultsHandler(
      { runner: { repo: { id: repoId }, plan: "pro" }, params: { runId }, body: { runId, sha: "abc", results: [result("t1", log.id)] } } as any,
      res
    );
    assert.equal(res.statusCode, 200);
    const state = (id: string) => db.find("verifyArtifacts", (a) => a.id === id)?.state;
    assert.equal(state(file.id), "uploaded", "the test file is readable after results land");
    assert.equal(state(log.id), "uploaded");
    assert.equal(state(skipped.id), "pending_upload", "a file for a test with no result stays unconfirmed");
  } finally {
    db.remove("verifyResults", (r) => r.runId === runId);
    db.remove("verifyArtifacts", (a) => a.runId === runId);
    db.remove("verifyRuns", (r) => r.id === runId);
  }
});
