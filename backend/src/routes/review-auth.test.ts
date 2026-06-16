// Owner-scope gate on the single-review routes. GET /api/reviews/:id and
// POST /api/reviews/:id/rerun must refuse anyone who isn't signed in (401),
// hide unknown ids (404), and reject a signed-in caller who doesn't own the
// review's repo (403) — for rerun, a rejected caller must not flip status or
// enqueue a run. We drive the exported handlers directly with a fake session
// req/res (a signed-JWT cookie minted via signSession, as in prod), so this runs
// in-memory with no network. enqueueReview only appends to the queue (no worker
// is started here), so the happy path is side-effect-free. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/review-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { getReviewHandler, rerunReviewHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

// A signed-in request for `userId` hitting review `id` — mints the same signed-JWT
// session cookie oauth.ts issues, so getSessionUser() verifies it as it does in prod.
function authedReq(userId: string, id: string): any {
  return { cookies: { devasign_session: signSession(userId) }, params: { id } };
}

function anonReq(id: string): any {
  return { cookies: {}, params: { id } };
}

// Owner (with install → repo → review → log + task) plus an unrelated signed-in
// stranger who owns a different install/repo. Fresh uuids per call keep the
// shared in-memory db collision-free across tests.
function seed() {
  const ownerId = uuid(), strangerId = uuid();
  const ownerInst = uuid(), strangerInst = uuid();
  const repoId = uuid(), reviewId = uuid(), taskId = uuid();
  const gh = Math.floor(Math.random() * 1e9);

  db.insert("users", { id: ownerId, githubId: gh, githubLogin: "owner", email: "o@x.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("users", { id: strangerId, githubId: gh + 1, githubLogin: "stranger", email: "s@x.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: ownerInst, userId: ownerId, accountId: 1, accountLogin: "owner", installationId: gh, repoIds: [] } as any);
  db.insert("installations", { id: strangerInst, userId: strangerId, accountId: 2, accountLogin: "stranger", installationId: gh + 1, repoIds: [] } as any);
  db.insert("repositories", { id: repoId, installationId: ownerInst, owner: "o", name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("repositories", { id: uuid(), installationId: strangerInst, owner: "s", name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("prReviews", { id: reviewId, repoId, prNumber: 7, prTitle: "t", headSha: "a", baseSha: "b", status: "passed", verdict: null, criteria: [], taskId, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  db.insert("reviewLogs", { id: uuid(), reviewId, kind: "ingest", at: Date.now(), action: "x" } as any);
  db.insert("tasks", { id: taskId, source: "github", externalId: "e", title: "t", endGoal: null, attachments: [], createdAt: Date.now() } as any);

  return { ownerId, strangerId, reviewId, taskId };
}

test("GET /reviews/:id: rejects a signed-out caller with 401", () => {
  const { reviewId } = seed();
  const res = fakeRes();
  getReviewHandler(anonReq(reviewId), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "not_signed_in");
});

test("GET /reviews/:id: 404 for an unknown id (no existence leak)", () => {
  const { strangerId } = seed();
  const res = fakeRes();
  getReviewHandler(authedReq(strangerId, uuid()), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "review_not_found");
});

test("GET /reviews/:id: 403 when the review's repo isn't the caller's", () => {
  const { strangerId, reviewId } = seed();
  const res = fakeRes();
  getReviewHandler(authedReq(strangerId, reviewId), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("GET /reviews/:id: 200 with review/logs/task for the owner", () => {
  const { ownerId, reviewId, taskId } = seed();
  const res = fakeRes();
  getReviewHandler(authedReq(ownerId, reviewId), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.review.id, reviewId);
  assert.equal(res.body.logs.length, 1);
  assert.equal(res.body.task.id, taskId);
});

test("POST /reviews/:id/rerun: 401 signed-out, status untouched", () => {
  const { reviewId } = seed();
  const res = fakeRes();
  rerunReviewHandler(anonReq(reviewId), res);
  assert.equal(res.statusCode, 401);
  assert.equal(db.find("prReviews", (r) => r.id === reviewId)!.status, "passed");
});

test("POST /reviews/:id/rerun: 403 for a non-owner, status untouched", () => {
  const { strangerId, reviewId } = seed();
  const res = fakeRes();
  rerunReviewHandler(authedReq(strangerId, reviewId), res);
  assert.equal(res.statusCode, 403);
  assert.equal(db.find("prReviews", (r) => r.id === reviewId)!.status, "passed");
});

test("POST /reviews/:id/rerun: owner re-queues the review", () => {
  const { ownerId, reviewId } = seed();
  const res = fakeRes();
  rerunReviewHandler(authedReq(ownerId, reviewId), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(db.find("prReviews", (r) => r.id === reviewId)!.status, "queued");
});
