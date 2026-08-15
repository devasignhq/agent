// task_id is deterministic and always exactly 25 chars (a hard contract rule).
// Run: node --import tsx/esm --test src/bounties/taskid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskIdForBounty, isValidTaskId, taskIdMatchesBounty, TASK_ID_LENGTH } from "./taskid.js";

test("always produces exactly 25 alphanumeric chars", () => {
  for (const id of ["a", "b1e-uuid-value", crypto.randomUUID(), crypto.randomUUID(), "x".repeat(200)]) {
    const t = taskIdForBounty(id);
    assert.equal(t.length, TASK_ID_LENGTH);
    assert.match(t, /^[A-Z2-7]+$/);
    assert.equal(isValidTaskId(t), true);
  }
});

test("is deterministic and distinct per bounty id", () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  assert.equal(taskIdForBounty(a), taskIdForBounty(a)); // stable across calls
  assert.notEqual(taskIdForBounty(a), taskIdForBounty(b));
});

test("isValidTaskId rejects wrong lengths", () => {
  assert.equal(isValidTaskId("short"), false);
  assert.equal(isValidTaskId("x".repeat(26)), false);
});

// Length alone is not validity: the contract validates the character set too, so
// a 25-char string of anything else must never pass as a task id.
test("isValidTaskId rejects a right-length non-base32 string", () => {
  for (const bad of [
    "!".repeat(TASK_ID_LENGTH),
    "x".repeat(TASK_ID_LENGTH), // lowercase
    "task-1".padEnd(TASK_ID_LENGTH, "0"), // 0/1/8/9 are not in the base32 alphabet
    "A".repeat(TASK_ID_LENGTH - 1) + "=", // base32 padding
    "A".repeat(TASK_ID_LENGTH - 1) + "\n", // anchors, not a partial match
  ]) {
    assert.equal(isValidTaskId(bad), false, bad);
  }
  assert.equal(isValidTaskId(taskIdForBounty("x")), true);
  assert.equal(isValidTaskId(undefined as unknown as string), false);
});

test("taskIdMatchesBounty only accepts the id that bounty derives", () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  assert.equal(taskIdMatchesBounty(a, taskIdForBounty(a)), true);
  assert.equal(taskIdMatchesBounty(a, taskIdForBounty(b)), false);
  assert.equal(taskIdMatchesBounty(a, "!".repeat(TASK_ID_LENGTH)), false);
  assert.equal(taskIdMatchesBounty(a, "T".repeat(TASK_ID_LENGTH)), false);
});
