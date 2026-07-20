// Unit tests for the sponsor-editable acceptance list validator.
//
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/acceptance.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CRITERIA, MAX_CRITERION_CHARS, validateAcceptance } from "./acceptance.js";

function ok(input: unknown): string[] {
  const r = validateAcceptance(input);
  assert.ok(r.ok, `expected validation to pass, got ${JSON.stringify(r)}`);
  return r.acceptance;
}

test("trims and collapses all whitespace, including newlines", () => {
  assert.deepEqual(
    ok(["  the   endpoint\nreturns 409  ", "\tsecond\t\tone "]),
    ["the endpoint returns 409", "second one"],
    "a criterion renders into a markdown bullet — embedded newlines break the list"
  );
});

test("drops blank and whitespace-only entries", () => {
  assert.deepEqual(ok(["real", "", "   ", "\n\t", "also real"]), ["real", "also real"]);
});

test("drops non-string entries rather than rejecting the payload", () => {
  assert.deepEqual(ok(["keep", 42, null, undefined, {}, [], "also keep"]), ["keep", "also keep"]);
});

test("dedupes case-insensitively, preserving the first occurrence's casing", () => {
  assert.deepEqual(
    ok(["Retries Are Capped", "retries are capped", "RETRIES ARE CAPPED"]),
    ["Retries Are Capped"]
  );
});

test("dedupe runs after whitespace collapse", () => {
  assert.deepEqual(ok(["one  two", "one two"]), ["one two"]);
});

test("an empty array is valid", () => {
  assert.deepEqual(ok([]), [], "every bounty carries an empty list today; a minimum would block funding");
});

test("blanks-only input normalizes to an empty list, not an error", () => {
  assert.deepEqual(ok(["", "  "]), []);
});

test("rejects a non-array", () => {
  for (const bad of [null, undefined, "a string", 42, { 0: "x" }]) {
    const r = validateAcceptance(bad);
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "not_an_array");
  }
});

test(`accepts exactly ${MAX_CRITERIA} criteria and rejects one more`, () => {
  const at = Array.from({ length: MAX_CRITERIA }, (_, i) => `criterion ${i}`);
  assert.equal(ok(at).length, MAX_CRITERIA);

  const over = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => `criterion ${i}`);
  const r = validateAcceptance(over);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "too_many");
});

test("the count limit applies AFTER normalization, so padding blanks can't trip it", () => {
  const padded = [...Array.from({ length: MAX_CRITERIA }, (_, i) => `criterion ${i}`), "", "  ", "\n"];
  assert.equal(ok(padded).length, MAX_CRITERIA);
});

test(`accepts a ${MAX_CRITERION_CHARS}-char criterion and rejects one longer, reporting its index`, () => {
  assert.equal(ok(["a".repeat(MAX_CRITERION_CHARS)])[0].length, MAX_CRITERION_CHARS);

  const r = validateAcceptance(["fine", "a".repeat(MAX_CRITERION_CHARS + 1)]);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "too_long");
  assert.equal((r as { index: number }).index, 1, "index must point at the offending criterion");
});
