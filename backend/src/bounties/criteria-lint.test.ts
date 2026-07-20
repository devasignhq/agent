// Unit tests for the deterministic criteria linter.
//
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/criteria-lint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CRITERION_CHARS } from "./acceptance.js";
import { lintCriteria, MIN_CRITERIA, SOFT_MAX_CRITERIA } from "./criteria-lint.js";

const GOAL = "The webhook receiver ignores duplicate deliveries.";
const CLEAN = [
  "Duplicate webhook deliveries are ignored.",
  "The receiver returns 202 for a replayed delivery id.",
  "A new delivery id is still processed.",
];

function kinds(criteria: string[], endGoal = GOAL): string[] {
  return lintCriteria(criteria, endGoal).map((f) => f.lint);
}

test("a well-formed list produces no findings", () => {
  assert.deepEqual(lintCriteria(CLEAN, GOAL), []);
});

test("flags an empty endGoal", () => {
  assert.ok(kinds(CLEAN, "").includes("empty_end_goal"));
  assert.ok(kinds(CLEAN, "   ").includes("empty_end_goal"), "whitespace-only counts as empty");
});

test("an empty criteria list is NOT a count finding", () => {
  assert.deepEqual(
    kinds([]),
    [],
    "empty is the intended output for an issue too vague to yield a verifiable criterion"
  );
});

test(`flags a list shorter than ${MIN_CRITERIA} but non-empty`, () => {
  assert.ok(kinds(["only one criterion here."]).includes("count_out_of_range"));
  assert.ok(kinds(CLEAN.slice(0, 2)).includes("count_out_of_range"));
});

test(`flags a list longer than ${SOFT_MAX_CRITERIA}`, () => {
  const many = Array.from({ length: SOFT_MAX_CRITERIA + 1 }, (_, i) => `Criterion number ${i} holds.`);
  assert.ok(kinds(many).includes("count_out_of_range"));

  const atCap = Array.from({ length: SOFT_MAX_CRITERIA }, (_, i) => `Criterion number ${i} holds.`);
  assert.deepEqual(kinds(atCap), [], "exactly at the cap is fine");
});

test("flags two substantial requirements joined by 'and', with the criterion index", () => {
  const findings = lintCriteria(
    [
      ...CLEAN,
      "The endpoint returns 409 once the escrow is funded and the bot comment is rewritten with the locked list.",
    ],
    GOAL
  );
  const conjoined = findings.find((f) => f.lint === "conjoined");
  assert.ok(conjoined, "expected a conjoined finding");
  assert.equal(conjoined.index, 3);
});

test("does not flag 'and' joining one idea", () => {
  assert.deepEqual(
    kinds([...CLEAN, "Retries and replays are capped."]),
    [],
    "both sides must be substantial before this is two requirements"
  );
});

test("flags each unjudgeable word the prompt bans", () => {
  for (const bad of [
    "The handler behaves correctly.",
    "Errors are handled properly.",
    "The retry loop degrades gracefully.",
    "Timeouts are extended as needed.",
  ]) {
    const findings = lintCriteria([...CLEAN, bad], GOAL);
    assert.ok(
      findings.some((f) => f.lint === "vague_word" && f.index === 3),
      `expected a vague_word finding for: ${bad}`
    );
  }
});

test("flags an over-length criterion", () => {
  const findings = lintCriteria([...CLEAN, "a".repeat(MAX_CRITERION_CHARS + 1)], GOAL);
  const tooLong = findings.find((f) => f.lint === "too_long");
  assert.ok(tooLong);
  assert.equal(tooLong.index, 3);
});
