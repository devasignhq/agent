// Pure-body tests for the "review in progress" → verdict conversation comment.
// No db / network / LLM (mirrors decisions.test.ts / criteria-format.test.ts). Run:
//   node --import tsx/esm --test src/review/progress-comment.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressCommentBody, reviewFailedCommentBody, verdictCommentBody } from "./progress-comment.js";

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

test("verdictCommentBody: passed + spec → ✅ all criteria met, with summary", () => {
  const body = verdictCommentBody({
    status: "passed",
    specless: false,
    summary: "Everything checks out.",
  });
  assert.match(body, /✅/);
  assert.match(body, /all acceptance criteria met/i);
  assert.match(body, /Everything checks out\./);
});

test("verdictCommentBody: passed + spec-less → ✅ no issues found", () => {
  const body = verdictCommentBody({ status: "passed", specless: true, summary: "" });
  assert.match(body, /✅/);
  assert.match(body, /no issues found/i);
  assert.doesNotMatch(body, /acceptance criteria met/i);
});

test("verdictCommentBody: changes_requested → 🔴 changes requested", () => {
  const body = verdictCommentBody({
    status: "changes_requested",
    specless: false,
    summary: "Two criteria are unmet.",
  });
  assert.match(body, /🔴/);
  assert.match(body, /changes requested/i);
  assert.match(body, /Two criteria are unmet\./);
});

test("verdictCommentBody: links the full review only when a URL is given", () => {
  const withUrl = verdictCommentBody({
    status: "passed",
    specless: false,
    summary: "ok",
    reviewUrl: "https://github.com/acme/widgets/pull/1#pullrequestreview-99",
  });
  assert.match(withUrl, /\[View the full review\]\(https:\/\/github\.com\/acme\/widgets\/pull\/1#pullrequestreview-99\)/);

  const withoutUrl = verdictCommentBody({ status: "passed", specless: false, summary: "ok" });
  assert.doesNotMatch(withoutUrl, /\]\(http/);
  assert.match(withoutUrl, /See the full review below/);
});

test("verdictCommentBody: omits the review pointer entirely when hasReview is false", () => {
  const body = verdictCommentBody({
    status: "passed",
    specless: true,
    summary: "Nothing to flag.",
    hasReview: false,
  });
  // Still a complete banner with the outcome + summary…
  assert.match(body, /✅/);
  assert.match(body, /no issues found/i);
  assert.match(body, /Nothing to flag\./);
  // …but no pointer to a review we deliberately didn't post (no link, no text).
  assert.doesNotMatch(body, /See the full review/);
  assert.doesNotMatch(body, /View the full review/);
  assert.doesNotMatch(body, /\]\(http/);
});

test("reviewFailedCommentBody: explains the failure and the auto-retry", () => {
  const body = reviewFailedCommentBody();
  assert.match(body, /review failed/i);
  assert.match(body, /retry/i);
});
