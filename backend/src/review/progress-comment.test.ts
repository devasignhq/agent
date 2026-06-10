// Pure-body tests for the "review in progress" → verdict conversation comment.
// No db / network / LLM (mirrors decisions.test.ts / criteria-format.test.ts). Run:
//   node --import tsx/esm --test src/review/progress-comment.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { minimalReviewBody, progressCommentBody, reviewFailedCommentBody, verdictCommentBody } from "./progress-comment.js";

test("progressCommentBody: matches the screenshot placeholder", () => {
  const body = progressCommentBody();
  assert.match(body, /PR Review In Progress/);
  assert.match(body, /currently running/);
  assert.match(body, /updated automatically/);
  // All three "What's happening?" bullets.
  assert.match(body, /Analysing the diff and changed files/);
  assert.match(body, /Evaluating code quality, patterns, and potential issues/);
  assert.match(body, /Generating actionable suggestions/);
  assert.match(body, /minute or two/);
});

test("verdictCommentBody: passed + spec → ✅ headline wrapping the full review body", () => {
  const reviewBody = "## End goal\nShip the widget.\n\n## ✅ All 3 acceptance criteria met";
  const body = verdictCommentBody({ status: "passed", specless: false, reviewBody });
  assert.match(body, /✅/);
  assert.match(body, /^## ✅ DevAsign review — all acceptance criteria met/);
  // The full review body is embedded verbatim under the headline.
  assert.ok(body.includes(reviewBody), "the full review body should be embedded");
});

test("verdictCommentBody: passed + spec-less → ✅ no issues found headline", () => {
  const reviewBody = "No blocking bugs, regressions, or security concerns surfaced.";
  const body = verdictCommentBody({ status: "passed", specless: true, reviewBody });
  assert.match(body, /^## ✅ DevAsign review — no issues found/);
  assert.doesNotMatch(body, /acceptance criteria met/i);
  assert.ok(body.includes(reviewBody));
});

test("verdictCommentBody: changes_requested → 🔴 changes requested headline", () => {
  const reviewBody = "## ❌ Acceptance criteria not met\n- **C1** — login still broken";
  const body = verdictCommentBody({ status: "changes_requested", specless: false, reviewBody });
  assert.match(body, /🔴/);
  assert.match(body, /^## 🔴 DevAsign review — changes requested/);
  assert.ok(body.includes(reviewBody));
});

test("minimalReviewBody: a short pointer to the comment, not the full verdict", () => {
  const body = minimalReviewBody();
  // Non-empty (GitHub requires a body for REQUEST_CHANGES/COMMENT) and points at
  // the conversation comment that carries the verdict.
  assert.match(body, /pinned comment/i);
  // It is NOT the verdict itself — no end goal / per-criterion detail.
  assert.doesNotMatch(body, /## End goal/);
  assert.ok(body.length < 300, "should be a one-liner, not the full verdict");
});

test("reviewFailedCommentBody: explains the failure and the auto-retry", () => {
  const body = reviewFailedCommentBody();
  assert.match(body, /review failed/i);
  assert.match(body, /retry/i);
});
