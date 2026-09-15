// GET /api/verify/tests lists only the caller's repos, one row per planned test
// of the newest run per review. Driven through the exported handler. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/verify-tests-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { RepoVerifyState } from "../types.js";
import { signSession } from "../github/oauth.js";
import { archiveTestsHandler, verifyTestsHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function tenant(login: string, verify?: RepoVerifyState) {
  const userId = uuid(), installId = uuid(), repoId = uuid(), reviewId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId: gh, githubLogin: login, email: `${login}@x.z`, plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: installId, userId, accountId: gh, accountLogin: login, installationId: gh, repoIds: [] } as any);
  db.insert("repositories", { id: repoId, installationId: installId, owner: login, name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true, ...(verify ? { verify } : {}) } as any);
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
  return { userId, installId, repoId, reviewId, addRun, cleanup };
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
    assert.deepEqual(res.body.counts, { ran: 1, e2e: 1, unit: 0, passed: 1, failed: 0, archived: 0 });
    assert.deepEqual(res.body.repos, [{ id: mine.repoId, name: "owner/r" }]);
    assert.equal(res.body.truncated, false);
    assert.equal(JSON.stringify(res.body).includes("hidden"), false, "test content never leaves the server");
  } finally {
    mine.cleanup();
    theirs.cleanup();
  }
});

const archive = (userId: string | undefined, reviewId: string, body: unknown) => {
  const res = fakeRes();
  archiveTestsHandler({ cookies: userId ? { devasign_session: signSession(userId) } : {}, params: { id: reviewId }, body } as any, res);
  return res;
};

test("archiving marks rows across later runs, restoring clears it, and other tenants are refused", () => {
  const mine = tenant("archiver");
  const theirs = tenant("stranger");
  try {
    mine.addRun(100, "a.spec.ts");
    assert.equal(archive(undefined, mine.reviewId, { paths: ["a.spec.ts"] }).statusCode, 401);
    assert.equal(archive(theirs.userId, mine.reviewId, { paths: ["a.spec.ts"] }).statusCode, 403);
    assert.equal(archive(mine.userId, mine.reviewId, { paths: [] }).statusCode, 400);
    assert.equal(archive(mine.userId, mine.reviewId, { paths: ["a.spec.ts"] }).statusCode, 200);
    mine.addRun(200, "a.spec.ts");
    let body = call(mine.userId).body;
    assert.ok(body.rows[0].archived);
    assert.equal(body.counts.archived, 1);
    assert.equal(body.counts.ran, 0);
    assert.equal(archive(mine.userId, mine.reviewId, { paths: ["a.spec.ts"], archived: false }).statusCode, 200);
    body = call(mine.userId).body;
    assert.equal(body.rows[0].archived, null);
  } finally {
    mine.cleanup();
    theirs.cleanup();
  }
});

test("browserSetup lists only the caller's repos that had UI criteria checked without a browser", () => {
  const notConfigured = { count: 3, reason: "not_configured" as const, runId: "run-a", prNumber: 7, at: 10 };
  const mine = tenant("zeta-owner", { onboarding: { state: "none" }, lastBrowserless: notConfigured });
  const theirs = tenant("intruder", { onboarding: { state: "none" }, lastBrowserless: { ...notConfigured, runId: "run-x" } });
  const quietId = uuid(), failingId = uuid();
  const repo = (id: string, name: string, verify: RepoVerifyState) =>
    db.insert("repositories", { id, installationId: mine.installId, owner: "zeta-owner", name, defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true, verify } as any);
  const didNotStart = { count: 1, reason: "did_not_start" as const, runId: "run-b", prNumber: 8, at: 20 };
  repo(quietId, "quiet", { onboarding: { state: "verified" }, lastBrowserless: null });
  repo(failingId, "app", { onboarding: { state: "verified" }, lastBrowserless: didNotStart });
  try {
    const body = call(mine.userId).body;
    assert.equal(body.browserSetup.length, 2);
    const [failing, bare] = body.browserSetup;
    assert.equal(failing.repoId, failingId);
    assert.equal(failing.repo, "zeta-owner/app");
    assert.equal(failing.status, "failing");
    assert.deepEqual(failing.lastBrowserless, didNotStart);
    assert.ok(failing.fixUrl.endsWith(`/workflow?repo=${failingId}&setup=browser`));
    assert.deepEqual({ ...bare, fixUrl: undefined }, { repoId: mine.repoId, repo: "zeta-owner/r", status: "not_configured", missing: [], lastBrowserless: notConfigured, fixUrl: undefined });
    assert.equal(JSON.stringify(body.browserSetup).includes("run-x"), false, "another tenant's repo never appears");
    assert.deepEqual(call(theirs.userId).body.browserSetup.map((b: { repoId: string }) => b.repoId), [theirs.repoId]);
  } finally {
    db.remove("repositories", (r) => r.id === quietId || r.id === failingId);
    mine.cleanup();
    theirs.cleanup();
  }
});
