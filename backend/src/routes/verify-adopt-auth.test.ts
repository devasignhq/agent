// The adopt-tests route takes a run id from the request body, and run ids are
// public (the PR comment deep-links them). The run must therefore belong to the
// review the caller was just authorized for, or one tenant could open a PR in
// another's repository. Driven through the exported handler with a signed
// session cookie, so no network is involved. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/verify-adopt-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { adoptTestsHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function tenant(login: string) {
  const userId = uuid(), installId = uuid(), repoId = uuid(), reviewId = uuid(), runId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId: gh, githubLogin: login, email: `${login}@x.z`, plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: installId, userId, accountId: gh, accountLogin: login, installationId: gh, repoIds: [] } as any);
  db.insert("repositories", { id: repoId, installationId: installId, owner: login, name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("prReviews", { id: reviewId, repoId, prNumber: 7, prTitle: "t", headSha: "a", baseSha: "b", status: "passed", verdict: null, criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  db.insert("verifyRuns", { id: runId, schemaVersion: 1, reviewId, repoId, installationId: installId, prNumber: 7, sha: "a", attempt: 1, status: "completed", criteriaRevision: 1, planTier: "pro", verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt: Date.now(), updatedAt: Date.now() } as any);
  return { userId, installId, repoId, reviewId, runId };
}

function cleanup(t: ReturnType<typeof tenant>) {
  db.remove("verifyRuns", (r) => r.id === t.runId);
  db.remove("prReviews", (r) => r.id === t.reviewId);
  db.remove("repositories", (r) => r.id === t.repoId);
  db.remove("installations", (i) => i.id === t.installId);
  db.remove("users", (u) => u.id === t.userId);
}

test("a run from another tenant is not adoptable through a review you do own", async () => {
  const mine = tenant("owner");
  const theirs = tenant("victim");
  try {
    const res = fakeRes();
    await adoptTestsHandler(
      { cookies: { devasign_session: signSession(mine.userId) }, params: { id: mine.reviewId }, body: { runId: theirs.runId } } as any,
      res
    );
    assert.equal(res.statusCode, 404, "the other tenant's run must not resolve");
    assert.deepEqual(res.body, { error: "run_not_found" });
    // Nothing was written to the victim's run.
    assert.equal(db.find("verifyRuns", (r) => r.id === theirs.runId)?.report, undefined);
  } finally {
    cleanup(mine);
    cleanup(theirs);
  }
});

test("a run id from a different review of your own repo is refused too", async () => {
  const mine = tenant("owner2");
  const otherReview = uuid();
  const otherRun = uuid();
  db.insert("prReviews", { id: otherReview, repoId: mine.repoId, prNumber: 8, prTitle: "t2", headSha: "c", baseSha: "d", status: "passed", verdict: null, criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  db.insert("verifyRuns", { id: otherRun, schemaVersion: 1, reviewId: otherReview, repoId: mine.repoId, installationId: mine.installId, prNumber: 8, sha: "c", attempt: 1, status: "completed", criteriaRevision: 1, planTier: "pro", verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt: Date.now(), updatedAt: Date.now() } as any);
  try {
    const res = fakeRes();
    await adoptTestsHandler(
      { cookies: { devasign_session: signSession(mine.userId) }, params: { id: mine.reviewId }, body: { runId: otherRun } } as any,
      res
    );
    assert.equal(res.statusCode, 404);
  } finally {
    db.remove("verifyRuns", (r) => r.id === otherRun);
    db.remove("prReviews", (r) => r.id === otherReview);
    cleanup(mine);
  }
});

test("an unauthenticated or foreign caller never reaches the run lookup", async () => {
  const mine = tenant("owner3");
  const stranger = tenant("stranger");
  try {
    const anon = fakeRes();
    await adoptTestsHandler({ cookies: {}, params: { id: mine.reviewId }, body: {} } as any, anon);
    assert.equal(anon.statusCode, 401);

    const foreign = fakeRes();
    await adoptTestsHandler(
      { cookies: { devasign_session: signSession(stranger.userId) }, params: { id: mine.reviewId }, body: { runId: mine.runId } } as any,
      foreign
    );
    assert.equal(foreign.statusCode, 403);
  } finally {
    cleanup(mine);
    cleanup(stranger);
  }
});
