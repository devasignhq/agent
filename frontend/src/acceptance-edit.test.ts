// Unit tests for the acceptance-criteria row editor (acceptance-edit.ts).
//   node --test src/acceptance-edit.test.ts
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addRow,
  editRow,
  isDirty,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  moveRow,
  normalizeForSave,
  overLongRows,
  removeRow,
} from "./acceptance-edit.ts";

const ROWS = ["first", "second", "third"];

test("addRow appends a blank row", () => {
  assert.deepEqual(addRow(ROWS), ["first", "second", "third", ""]);
});

test("addRow stops at the cap the backend enforces", () => {
  const full = Array.from({ length: MAX_CRITERIA }, (_, i) => `c${i}`);
  assert.equal(addRow(full).length, MAX_CRITERIA, "a 13th row would just 400 on save");
});

test("removeRow drops the given index and ignores out-of-range", () => {
  assert.deepEqual(removeRow(ROWS, 1), ["first", "third"]);
  assert.deepEqual(removeRow(ROWS, 9), ROWS);
  assert.deepEqual(removeRow(ROWS, -1), ROWS);
});

test("editRow replaces one row without touching the others", () => {
  assert.deepEqual(editRow(ROWS, 1, "changed"), ["first", "changed", "third"]);
  assert.deepEqual(editRow(ROWS, 9, "x"), ROWS);
});

test("every operation returns a new array, never mutating in place", () => {
  const original = [...ROWS];
  addRow(ROWS);
  removeRow(ROWS, 0);
  editRow(ROWS, 0, "x");
  moveRow(ROWS, 0, 1);
  assert.deepEqual(ROWS, original, "React state must not be mutated behind the renderer's back");
});

// ── ordering ─────────────────────────────────────────────────────────────────
// Order is load-bearing: the backend seeds review criteria from this list
// positionally as bounty-1..N.

test("moveRow swaps with the neighbour in each direction", () => {
  assert.deepEqual(moveRow(ROWS, 1, -1), ["second", "first", "third"]);
  assert.deepEqual(moveRow(ROWS, 1, 1), ["first", "third", "second"]);
});

test("moveRow is a no-op at both boundaries", () => {
  assert.deepEqual(moveRow(ROWS, 0, -1), ROWS, "cannot move the first row up");
  assert.deepEqual(moveRow(ROWS, 2, 1), ROWS, "cannot move the last row down");
  assert.deepEqual(moveRow(ROWS, 9, -1), ROWS);
});

// ── normalization ────────────────────────────────────────────────────────────

test("normalizeForSave mirrors the backend: collapse, trim, drop blanks, dedupe", () => {
  assert.deepEqual(
    normalizeForSave(["  spans\na newline ", "", "   ", "Keep This", "keep this"]),
    ["spans a newline", "Keep This"],
    "first casing wins on a case-insensitive duplicate"
  );
});

test("normalizeForSave tolerates an all-blank editor", () => {
  assert.deepEqual(normalizeForSave(["", "  "]), [], "clearing every row is a valid save");
});

test("isDirty ignores blank rows and whitespace-only edits", () => {
  assert.equal(isDirty(["a", "b"], ["a", "b"]), false);
  assert.equal(isDirty(["a", "b", ""], ["a", "b"]), false, "an empty row being typed into is not a change");
  assert.equal(isDirty(["  a  ", "b"], ["a", "b"]), false);
  assert.equal(isDirty(["a", "c"], ["a", "b"]), true);
  assert.equal(isDirty(["b", "a"], ["a", "b"]), true, "a reorder IS a change");
  assert.equal(isDirty(["a"], ["a", "b"]), true);
});

test("overLongRows reports exactly the rows the backend would reject", () => {
  const rows = ["fine", "x".repeat(MAX_CRITERION_CHARS), "y".repeat(MAX_CRITERION_CHARS + 1)];
  assert.deepEqual(overLongRows(rows), [2], "the boundary length is allowed, one over is not");
});
