// Owner-scope gate on the task routes. GET /api/tasks/:id, POST
// /api/tasks/:id/attachments and DELETE /api/tasks/:taskId/attachments/:id must
// refuse anyone who isn't signed in (401), hide unknown ids (404), and reject a
// signed-in caller who doesn't own the task (403) — for POST/DELETE a rejected
// caller must not mutate the task. Ownership resolves task → review → repo →
// installation → user, OR directly via task.userId for Linear tasks that have no
// linked review yet; both paths are covered below. We drive the exported
// handlers directly with a fake session req/res (same base64url `id:ts` cookie
// getSessionUser decodes), so this runs in-memory with no network. track()
// no-ops without a live Statsig client and enqueueReview/enqueueMaintainerFeedback
// only append to the in-process queue (no worker is started here), so the happy
// paths are side-effect-free. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/task-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import {
  getTaskHandler,
  addTaskAttachmentHandler,
  removeTaskAttachmentHandler,
} from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

// A signed-in request for `userId` — mirrors the base64url `id:ts` session
// oauth.ts mints and getSessionUser() decodes. `params`/`body` vary per route.
function authedReq(userId: string, params: any, body?: any): any {
  const session = Buffer.from(`${userId}:${Date.now()}`).toString("base64url");
  return { cookies: { devasign_session: session }, params, body };
}

function anonReq(params: any, body?: any): any {
  return { cookies: {}, params, body };
}

// Owner with an install → repo → review → task (GitHub task, owned via the
// review chain) plus a second task that's Linear-sourced (owned directly via
// task.userId, with no linked review). An unrelated signed-in stranger owns a
// different install/repo. Fresh uuids per call keep the shared in-memory db
// collision-free across tests.
function seed() {
  const ownerId = uuid(), strangerId = uuid();
  const ownerInst = uuid(), strangerInst = uuid();
  const ownerRepo = uuid(), strangerRepo = uuid();
  const reviewId = uuid(), ghTaskId = uuid(), linearTaskId = uuid();
  const ghAtt = uuid(), linearAtt = uuid();
  const gh = Math.floor(Math.random() * 1e9);

  db.insert("users", { id: ownerId, githubId: gh, githubLogin: "owner", email: "o@x.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("users", { id: strangerId, githubId: gh + 1, githubLogin: "stranger", email: "s@x.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: ownerInst, userId: ownerId, accountId: 1, accountLogin: "owner", installationId: gh, repoIds: [] } as any);
  db.insert("installations", { id: strangerInst, userId: strangerId, accountId: 2, accountLogin: "stranger", installationId: gh + 1, repoIds: [] } as any);
  db.insert("repositories", { id: ownerRepo, installationId: ownerInst, owner: "o", name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("repositories", { id: strangerRepo, installationId: strangerInst, owner: "s", name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("prReviews", { id: reviewId, repoId: ownerRepo, prNumber: 7, prTitle: "t", headSha: "a", baseSha: "b", status: "passed", verdict: null, criteria: [], taskId: ghTaskId, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  // GitHub task: owned only through review → repo → install (no userId).
  db.insert("tasks", { id: ghTaskId, source: "github", externalId: uuid(), title: "t", endGoal: null, attachments: [{ id: ghAtt, kind: "text", note: "n", createdAt: Date.now() }], createdAt: Date.now() } as any);
  // Linear task: owned directly via userId, with no linked review.
  db.insert("tasks", { id: linearTaskId, source: "linear", externalId: uuid(), title: "t", endGoal: null, attachments: [{ id: linearAtt, kind: "text", note: "n", createdAt: Date.now() }], createdAt: Date.now(), userId: ownerId } as any);

  return { ownerId, strangerId, ghTaskId, linearTaskId, ghAtt, linearAtt };
}

const attCount = (id: string) =>
  db.find("tasks", (t) => t.id === id)!.attachments.length;

// --- GET /tasks/:id ---

test("GET /tasks/:id: rejects a signed-out caller with 401", () => {
  const { ghTaskId } = seed();
  const res = fakeRes();
  getTaskHandler(anonReq({ id: ghTaskId }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "not_signed_in");
});

test("GET /tasks/:id: 404 for an unknown id (no existence leak)", () => {
  const { strangerId } = seed();
  const res = fakeRes();
  getTaskHandler(authedReq(strangerId, { id: uuid() }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "task_not_found");
});

test("GET /tasks/:id: 403 when the task's repo isn't the caller's", () => {
  const { strangerId, ghTaskId } = seed();
  const res = fakeRes();
  getTaskHandler(authedReq(strangerId, { id: ghTaskId }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("GET /tasks/:id: 200 for the owner via the review chain", () => {
  const { ownerId, ghTaskId } = seed();
  const res = fakeRes();
  getTaskHandler(authedReq(ownerId, { id: ghTaskId }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, ghTaskId);
});

test("GET /tasks/:id: 200 for the owner of a review-less Linear task (task.userId)", () => {
  const { ownerId, linearTaskId } = seed();
  const res = fakeRes();
  getTaskHandler(authedReq(ownerId, { id: linearTaskId }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, linearTaskId);
});

// --- POST /tasks/:id/attachments ---

test("POST /tasks/:id/attachments: 401 signed-out, task untouched", () => {
  const { ghTaskId } = seed();
  const res = fakeRes();
  addTaskAttachmentHandler(anonReq({ id: ghTaskId }, { kind: "link" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(attCount(ghTaskId), 1);
});

test("POST /tasks/:id/attachments: 404 for an unknown id", () => {
  const { strangerId } = seed();
  const res = fakeRes();
  addTaskAttachmentHandler(authedReq(strangerId, { id: uuid() }, { kind: "link" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "task_not_found");
});

test("POST /tasks/:id/attachments: 403 for a non-owner, task untouched", () => {
  const { strangerId, ghTaskId } = seed();
  const res = fakeRes();
  addTaskAttachmentHandler(authedReq(strangerId, { id: ghTaskId }, { kind: "link" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
  assert.equal(attCount(ghTaskId), 1);
});

test("POST /tasks/:id/attachments: owner adds an attachment via the review chain", () => {
  const { ownerId, ghTaskId } = seed();
  const res = fakeRes();
  addTaskAttachmentHandler(authedReq(ownerId, { id: ghTaskId }, { kind: "link" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(attCount(ghTaskId), 2);
});

test("POST /tasks/:id/attachments: owner adds to a review-less Linear task (task.userId)", () => {
  const { ownerId, linearTaskId } = seed();
  const res = fakeRes();
  addTaskAttachmentHandler(authedReq(ownerId, { id: linearTaskId }, { kind: "link" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(attCount(linearTaskId), 2);
});

// --- DELETE /tasks/:taskId/attachments/:attachmentId ---

test("DELETE /tasks/:taskId/attachments/:id: 401 signed-out, attachment kept", () => {
  const { ghTaskId, ghAtt } = seed();
  const res = fakeRes();
  removeTaskAttachmentHandler(anonReq({ taskId: ghTaskId, attachmentId: ghAtt }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(attCount(ghTaskId), 1);
});

test("DELETE /tasks/:taskId/attachments/:id: 404 for an unknown task id", () => {
  const { strangerId } = seed();
  const res = fakeRes();
  removeTaskAttachmentHandler(authedReq(strangerId, { taskId: uuid(), attachmentId: uuid() }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "task_not_found");
});

test("DELETE /tasks/:taskId/attachments/:id: 403 for a non-owner, attachment kept", () => {
  const { strangerId, ghTaskId, ghAtt } = seed();
  const res = fakeRes();
  removeTaskAttachmentHandler(authedReq(strangerId, { taskId: ghTaskId, attachmentId: ghAtt }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
  assert.equal(attCount(ghTaskId), 1);
});

test("DELETE /tasks/:taskId/attachments/:id: owner removes via the review chain", () => {
  const { ownerId, ghTaskId, ghAtt } = seed();
  const res = fakeRes();
  removeTaskAttachmentHandler(authedReq(ownerId, { taskId: ghTaskId, attachmentId: ghAtt }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed.id, ghAtt);
  assert.equal(attCount(ghTaskId), 0);
});

test("DELETE /tasks/:taskId/attachments/:id: owner removes from a review-less Linear task (task.userId)", () => {
  const { ownerId, linearTaskId, linearAtt } = seed();
  const res = fakeRes();
  removeTaskAttachmentHandler(authedReq(ownerId, { taskId: linearTaskId, attachmentId: linearAtt }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed.id, linearAtt);
  assert.equal(attCount(linearTaskId), 0);
});
