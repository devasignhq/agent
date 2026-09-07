// Offline: runner poll bookkeeping — the signals that decide whether a finished
// plan re-dispatches CI, and whether a PR is answered "no plan is coming".
//   DATABASE_URL= node --import tsx/esm --test src/verify/runs-poll.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forgetRunnerPoll,
  noteRunnerGone,
  noteRunnerPoll,
  NO_REVIEW_GRACE_MS,
  RUNNER_GONE_MS,
  runnerGaveUp,
  runnerWaitedWithoutReview,
} from "./runs.js";

const SHA = "b".repeat(40);
let n = 0;
const repoId = () => `repo-${n++}`;

test("a runner still polling is never treated as gone", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerPoll(id, 1, SHA, now - 60_000);
  noteRunnerPoll(id, 1, SHA, now - 1_000);
  assert.equal(runnerGaveUp(id, 1, SHA, now), false, "the latest poll is what counts, not the first");
});

test("silence past RUNNER_GONE_MS means gone", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerPoll(id, 1, SHA, now - RUNNER_GONE_MS - 1);
  assert.equal(runnerGaveUp(id, 1, SHA, now), true);
});

test("an explicit give-up is honoured immediately, closing the stranding window", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerPoll(id, 1, SHA, now);
  noteRunnerGone(id, 1, SHA, now);
  // Without the flag this is a fresh poll, so only the explicit signal can save it.
  assert.equal(runnerGaveUp(id, 1, SHA, now), true);
});

test("a repo nobody polled for is not 'gone' — it never showed up", () => {
  assert.equal(runnerGaveUp(repoId(), 9, SHA, Date.now()), false);
});

test("forgetting a poll clears both the timer and the give-up flag", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerGone(id, 1, SHA, now);
  forgetRunnerPoll(id, 1, SHA);
  assert.equal(runnerGaveUp(id, 1, SHA, now), false, "a re-dispatched runner must not re-dispatch again");
});

test("the no-review grace measures from the FIRST poll, not the latest", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerPoll(id, 1, SHA, now - NO_REVIEW_GRACE_MS - 1_000);
  noteRunnerPoll(id, 1, SHA, now);
  assert.equal(runnerWaitedWithoutReview(id, 1, SHA, NO_REVIEW_GRACE_MS, now), true);
});

test("a runner inside the grace is still waiting", () => {
  const id = repoId();
  const now = Date.now();
  noteRunnerPoll(id, 1, SHA, now - 1_000);
  assert.equal(runnerWaitedWithoutReview(id, 1, SHA, NO_REVIEW_GRACE_MS, now), false);
});
