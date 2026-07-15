// task_id is deterministic and always exactly 25 chars (a hard contract rule).
// Run: node --import tsx/esm --test src/bounties/taskid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskIdForBounty, isValidTaskId, TASK_ID_LENGTH } from "./taskid.js";

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
