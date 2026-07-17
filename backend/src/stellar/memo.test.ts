// MEMO_TEXT is limited to 28 BYTES of UTF-8, not 28 characters — multi-byte
// input must be measured in bytes. Run:
//   node --import tsx/esm --test src/stellar/memo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMemo, MEMO_TEXT_MAX_BYTES } from "./memo.js";

test("plain memos within 28 bytes pass and are trimmed", () => {
  assert.deepEqual(validateMemo("devon-devasign"), { ok: true, memo: "devon-devasign" });
  assert.deepEqual(validateMemo("  spaced  "), { ok: true, memo: "spaced" });
  assert.deepEqual(validateMemo("x".repeat(MEMO_TEXT_MAX_BYTES)), {
    ok: true,
    memo: "x".repeat(MEMO_TEXT_MAX_BYTES),
  });
});

test("empty / absent / non-string memos normalize to no-memo", () => {
  assert.deepEqual(validateMemo(""), { ok: true, memo: "" });
  assert.deepEqual(validateMemo("   "), { ok: true, memo: "" });
  assert.deepEqual(validateMemo(undefined), { ok: true, memo: "" });
  assert.deepEqual(validateMemo(null), { ok: true, memo: "" });
  assert.deepEqual(validateMemo(42), { ok: true, memo: "" });
});

test("over 28 bytes is rejected — measured in bytes, not characters", () => {
  assert.deepEqual(validateMemo("x".repeat(29)), { ok: false, reason: "too_long" });
  // 10 three-byte characters = 30 bytes but only 10 chars.
  assert.deepEqual(validateMemo("€".repeat(10)), { ok: false, reason: "too_long" });
  // 9 of them = 27 bytes → fine.
  assert.equal(validateMemo("€".repeat(9)).ok, true);
});
