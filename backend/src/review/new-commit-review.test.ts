// Unit tests for the new-commit intent review's pure pieces: the gate predicate
// (shouldReviewNewCommits) and the LLM-output normalizer (normalizeCommitIntent).
// No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/new-commit-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReviewNewCommits, normalizeCommitIntent } from "./pipeline.js";

// ── shouldReviewNewCommits ──────────────────────────────────────────────────
const base = {
  startedNewCommit: true,
  lastReviewedSha: "aaa111",
  headSha: "bbb222",
  priorCriteriaCount: 3,
};

test("shouldReviewNewCommits: true on a new-sha re-review of a PR with criteria + a recorded base", () => {
  assert.equal(shouldReviewNewCommits(base), true);
});

test("shouldReviewNewCommits: false on the first review (no lastReviewedSha)", () => {
  assert.equal(shouldReviewNewCommits({ ...base, lastReviewedSha: null }), false);
  assert.equal(shouldReviewNewCommits({ ...base, lastReviewedSha: undefined }), false);
});

test("shouldReviewNewCommits: false on a same-sha rerun (head equals base, or not a new commit)", () => {
  assert.equal(shouldReviewNewCommits({ ...base, headSha: "aaa111" }), false); // base === head
  assert.equal(shouldReviewNewCommits({ ...base, startedNewCommit: false }), false); // manual rerun
});

test("shouldReviewNewCommits: false when the PR has no prior criteria", () => {
  assert.equal(shouldReviewNewCommits({ ...base, priorCriteriaCount: 0 }), false);
});

// ── normalizeCommitIntent ───────────────────────────────────────────────────
test("normalizeCommitIntent: trims, drops empties, and caps addedCriteria at 10", () => {
  const many = Array.from({ length: 14 }, (_, i) => `  criterion ${i}  `);
  const out = normalizeCommitIntent({ addedCriteria: ["  real  ", "", "   ", ...many] });
  assert.equal(out.addedCriteria.length, 10);
  assert.equal(out.addedCriteria[0], "real"); // trimmed, empties dropped
});

test("normalizeCommitIntent: forces intentFindings to advisory 'warn' even if the model says blocker", () => {
  const out = normalizeCommitIntent({
    intentFindings: [
      { concern: "commit claims to add retry but the diff doesn't", severity: "blocker", fixPrompt: "fix" },
      { concern: "log noise", severity: "warn", fixPrompt: "fix" },
    ],
  });
  assert.deepEqual(out.intentFindings.map((f) => f.severity), ["warn", "warn"]);
});

test("normalizeCommitIntent: empty/garbage input yields empty arrays and empty summary", () => {
  const out = normalizeCommitIntent({});
  assert.deepEqual(out.addedCriteria, []);
  assert.deepEqual(out.intentFindings, []);
  assert.equal(out.summary, "");
  const out2 = normalizeCommitIntent({ addedCriteria: "nope", intentFindings: 5, summary: 42 });
  assert.deepEqual(out2.addedCriteria, []);
  assert.deepEqual(out2.intentFindings, []);
  assert.equal(out2.summary, "42"); // coerced to string
});
