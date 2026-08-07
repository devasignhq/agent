import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTaskId, taskIdForBounty } from "./taskid.js";

test("isValidTaskId enforces base32 charset and 25-char length", () => {
  assert.equal(isValidTaskId("!!!!!!!!!!!!!!!!!!!!!!!!!"), false, "Illegal charset must return false");
  assert.equal(isValidTaskId("lower-case-invalid-base32"), false, "Lowercase characters must return false");
  assert.equal(isValidTaskId("SHORT"), false, "Short taskId must return false");

  const validId = taskIdForBounty("bounty_test_123");
  assert.equal(isValidTaskId(validId), true, "Valid base32 derived taskId must return true");
});
