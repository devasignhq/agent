// Pure tests for the conversation comment's non-verdict states. No db / network
// / LLM. Run:
//   node --import tsx/esm --test src/review/progress-comment.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressCommentBody, reviewFailedCommentBody } from "./progress-comment.js";
import { CARD_TITLE } from "./comment.js";

test("every state of the comment carries the same title, so editing it doesn't change its identity", () => {
  for (const body of [progressCommentBody(), reviewFailedCommentBody()]) {
    assert.equal(body.split("\n")[0], CARD_TITLE);
  }
});

test("the placeholder says DevAsign is reviewing and where the results will land", () => {
  const body = progressCommentBody();
  assert.match(body, /⏳ `Review in progress`/);
  assert.match(body, /DevAsign AI is currently reviewing this pull request/);
  assert.match(body, /posted as a single review below/);
  assert.match(body, /one collapsed note per finding/);
});

test("the failure copy admits the run failed and promises a retry", () => {
  const body = reviewFailedCommentBody();
  assert.match(body, /🔴 `Review failed`/);
  assert.match(body, /couldn't complete this review run/);
  assert.match(body, /retry the next time you push/);
});
