// GET /api/verify/tests lists only the caller's repos, one row per planned test
// of the newest run per review. Driven through the exported handler. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/verify-tests-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { verifyTestsHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function tenant(login: string) {
  const userId = uuid(), installId = uuid(), repoId = uuid(), reviewId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId: gh, githubLogin: login, email: `${login}@x.z`, plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: installId, userId, accountId: gh, accountLogin: login, installationId: gh, repoIds: [] } as any);
  db.insert("repositories", { id: repoId, installationId: installId, owner: login, name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("prReviews", { id: reviewId, repoId, prNumber: 7, prTitle: "Refunds", headSha: "a", baseSha: "b", status: "passed", verdict: null, criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  const runIds: string[] = [];
  const planIds: string[] = [];
  const addRun = (createdAt: number, testPath: string, adopted?: { prUrl: string; prNumber: number; at: number }) => {
    const runId = uuid(), planId = uuid(), resultsId = uuid();
    db.insert("verifyPlans", { id: planId, schemaVersion: 1, runId, repoId, criteriaRevision: 1, commands: [], unverifiable: [], createdAt, tests: [
      { id: "t1", path: testPath, content: "// hidden", criterionIds: ["1"], level: "e2e", levelReason: "", origin: "generated", runner: "playwright", testSignature: "s", strategyVersion: 1, targetFiles: [], ...(adopted ? { adopted } : {}) },
    ] } as any);
    db.insert("verifyResults", { id: resultsId, schemaVersion: 1, runId, createdAt, payload: { runId, results: [{ id: "r1", testId: "t1", criterionIds: ["1"], test: "t", runner: "playwright", level: "e2e", origin: "generated", status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 3, artifactIds: [] }], durationMs: 3, artifactIds: [] }] } } as any);
    db.insert("verifyRuns", { id: runId, schemaVersion: 1, reviewId, repoId, installationId: installId, prNumber: 7, sha: "a", attempt: 1, status: "completed", criteriaRevision: 1, planTier: "pro", planId, resultsId, verdicts: [], timings: { forkedAt: createdAt }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt, updatedAt: createdAt } as any);
    db.insert("verifyArtifacts", { id: uuid(), schemaVersion: 1, runId, repoId, testId: "t1", criterionIds: ["1"], kind: "video", path: "v.webm", storageKey: "k", bytes: 1, contentType: "video/webm", attempt: 1, state: "uploaded", expiresAt: Date.now() + 1e6, createdAt } as any);
    runIds.push(runId);
    planIds.push(planId);
    return runId;
  };
  const cleanup = () => {
    db.remove("verifyArtifacts", (a) => runIds.includes(a.runId));
    db.remove("verifyResults", (r) => runIds.includes(r.runId));
    db.remove("verifyPlans", (p) => planIds.includes(p.id));
    db.remove("verifyRuns", (r) => runIds.includes(r.id));
    db.remove("prReviews", (r) => r.id === reviewId);
    db.remove("repositories", (r) => r.id === repoId);
    db.remove("installations", (i) => i.id === installId);
    db.remove("users", (u) => u.id === userId);
  };
  return { userId, repoId, reviewId, addRun, cleanup };
}

const call = (userId?: string) => {
  const res = fakeRes();
  verifyTestsHandler({ cookies: userId ? { devasign_session: signSession(userId) } : {} } as any, res);
  return res;
};

test("unauthenticated callers get 401", () => {
  assert.equal(call().statusCode, 401);
});

test("only the caller's repos appear, and only the newest run per review", () => {
  const mine = tenant("owner");
  const theirs = tenant("victim");
  try {
    mine.addRun(100, "old.spec.ts");
    const newest = mine.addRun(200, "new.spec.ts", { prUrl: "https://gh/pr/3", prNumber: 3, at: 1 });
    theirs.addRun(300, "theirs.spec.ts");
    const res = call(mine.userId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.rows.length, 1);
    const row = res.body.rows[0];
    assert.equal(row.path, "new.spec.ts");
    assert.equal(row.run.id, newest);
    assert.equal(row.repo.name, "owner/r");
    assert.deepEqual(row.review, { id: mine.reviewId, prNumber: 7, prTitle: "Refunds" });
    assert.equal(row.status, "pass");
    assert.equal(row.evidence.length, 1);
    assert.equal(row.adopted.prNumber, 3);
    assert.deepEqual(res.body.counts, { ran: 1, e2e: 1, unit: 0, passed: 1, failed: 0 });
    assert.deepEqual(res.body.repos, [{ id: mine.repoId, name: "owner/r" }]);
    assert.equal(res.body.truncated, false);
    assert.equal(JSON.stringify(res.body).includes("hidden"), false, "test content never leaves the server");
  } finally {
    mine.cleanup();
    theirs.cleanup();
  }
});
