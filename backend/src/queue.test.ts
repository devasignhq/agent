// enqueueReview must be idempotent while a job for the same review row is
// still waiting: webhook redelivery, the dashboard sync poll, and a reopen can
// all ask for the same review within one drain window, and each extra job is a
// full duplicate pipeline run (LLM cost + duplicate GitHub comments). No
// subscriber is registered here, so jobs stay pending and counts are exact. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/queue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueBountyCriteria,
  enqueueMaintainerFeedback,
  enqueueReview,
  queueSnapshot,
} from "./queue.js";

test("enqueueReview dedupes a review that is already pending", () => {
  const first = enqueueReview("review-1");
  const second = enqueueReview("review-1");
  assert.equal(second.id, first.id);
  assert.equal(queueSnapshot().reviews, 1);
});

test("different reviews still enqueue independently", () => {
  const before = queueSnapshot().reviews;
  enqueueReview("review-2");
  assert.equal(queueSnapshot().reviews, before + 1);
});

test("maintainer-feedback jobs are not collapsed into review jobs", () => {
  const before = queueSnapshot().reviews;
  // Same reviewId as an already-pending review job — feedback is distinct work
  // (analyzing a comment), so it must keep its own job.
  enqueueMaintainerFeedback("review-1", {
    body: "please also handle the empty case",
    author: "alice",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
    sourceEvent: "issue_comment",
  });
  assert.equal(queueSnapshot().reviews, before + 1);
});

// ── bounty criteria drafting ─────────────────────────────────────────────────
// Same idempotency argument as enqueueReview: a webhook redelivery or a
// re-comment can ask twice, and the second job would burn another LLM call
// only to overwrite the first one's answer.
test("enqueueBountyCriteria dedupes a bounty that is already pending", () => {
  const first = enqueueBountyCriteria("bounty-1");
  const second = enqueueBountyCriteria("bounty-1");
  assert.equal(second.id, first.id);
});

test("different bounties still enqueue independently", () => {
  const before = queueSnapshot().reviews;
  enqueueBountyCriteria("bounty-2");
  assert.equal(queueSnapshot().reviews, before + 1);
});

test("criteria jobs drain in the reviews bucket, never behind an index build", () => {
  const before = queueSnapshot();
  enqueueBountyCriteria("bounty-3");
  const after = queueSnapshot();
  assert.equal(after.reviews, before.reviews + 1, "a sponsor is waiting on this");
  assert.equal(after.index, before.index, "must not queue behind a multi-minute repo index");
});
