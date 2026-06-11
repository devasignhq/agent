// dedupePRReviews collapses duplicate prReviews rows for the same
// (repoId, prNumber) — leftovers from before review creation was idempotent.
// Pure in-memory db, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/dedupe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { dedupePRReviews } from "./dedupe.js";

function seedReview(repoId: string, prNumber: number, patch: Record<string, unknown> = {}) {
  return db.insert("prReviews", {
    id: uuid(),
    repoId,
    prNumber,
    prTitle: "Add widget",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "passed",
    verdict: "approved",
    criteria: [],
    taskId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  } as any);
}

test("merges duplicates: newest survives, history and pointers carry over", () => {
  const repoId = uuid();
  const older = seedReview(repoId, 5, {
    updatedAt: 1000,
    taskId: "task-1",
    progressCommentId: 42,
    progressCommentSha: "abc1234",
  });
  const newer = seedReview(repoId, 5, { updatedAt: 2000 });

  const log = db.insert("reviewLogs", {
    id: uuid(),
    reviewId: older.id,
    kind: "ingest",
    at: 1500,
    action: "comment.received",
    detail: "looks good",
  } as any);
  const notif = db.insert("notifications", {
    id: uuid(),
    userId: "user-1",
    kind: "review",
    title: "PR #5 added to review queue",
    meta: "acme/widgets",
    link: `/reviews/${older.id}`,
    reviewId: older.id,
    createdAt: 1500,
    readAt: null,
  } as any);

  const removed = dedupePRReviews();
  assert.equal(removed, 1);

  const rows = db.filter("prReviews", (r) => r.repoId === repoId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, newer.id);
  // Pointers only the older dupe had are inherited by the survivor.
  assert.equal(rows[0].taskId, "task-1");
  assert.equal(rows[0].progressCommentId, 42);
  assert.equal(rows[0].progressCommentSha, "abc1234");

  // Logs and notifications follow the survivor; the default link is rewritten.
  const movedLog = db.find("reviewLogs", (l) => l.id === log.id);
  assert.equal(movedLog?.reviewId, newer.id);
  const movedNotif = db.find("notifications", (n) => n.id === notif.id);
  assert.equal(movedNotif?.reviewId, newer.id);
  assert.equal(movedNotif?.link, `/reviews/${newer.id}`);
});

test("survivor's own pointers win over a dupe's", () => {
  const repoId = uuid();
  seedReview(repoId, 6, { updatedAt: 1000, progressCommentId: 41 });
  const newer = seedReview(repoId, 6, { updatedAt: 2000, progressCommentId: 43 });

  dedupePRReviews();
  const rows = db.filter("prReviews", (r) => r.repoId === repoId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, newer.id);
  assert.equal(rows[0].progressCommentId, 43);
});

test("distinct PRs are left alone", () => {
  const repoId = uuid();
  seedReview(repoId, 7);
  seedReview(repoId, 8);

  const removed = dedupePRReviews();
  assert.equal(removed, 0);
  assert.equal(db.filter("prReviews", (r) => r.repoId === repoId).length, 2);
});
