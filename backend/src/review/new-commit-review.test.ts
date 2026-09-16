// Unit tests for the new-commit intent review's pure pieces: the gate predicate
// (shouldReviewNewCommits) and the LLM-output normalizer (normalizeCommitIntent).
// No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/new-commit-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReviewNewCommits, normalizeCommitIntent, deltaIsOwnWork } from "./pipeline.js";

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

// ── deltaIsOwnWork ──────────────────────────────────────────────────────────
// devasignhq/agent#252: resolving a conflict by merging main into the branch left the head
// "ahead", so the compare walked in the three commits main had gained and the intent review
// minted six criteria from another PR's merged work — permanent on the row, and unsatisfiable
// because that code lives in the base branch and never appears in this PR's diff.
test("deltaIsOwnWork: true when every delta commit belongs to the PR", () => {
  assert.equal(deltaIsOwnWork(["aaa", "bbb"], ["aaa", "bbb", "ccc"]), true);
  assert.equal(deltaIsOwnWork(["AAA"], ["aaa"]), true, "shas compare case-insensitively");
  assert.equal(deltaIsOwnWork([], []), true, "an empty delta carries nothing foreign");
});

test("deltaIsOwnWork: false when the delta carries a commit the PR does not own", () => {
  // The #252 shape: one own commit (the merge) plus the base branch's commits.
  assert.equal(deltaIsOwnWork(["07bd5d2", "e0b0288", "cc6e548", "71bf6ad"], ["7821fbd", "71bf6ad"]), false);
  assert.equal(deltaIsOwnWork(["aaa"], []), false, "an unknown PR commit list is not a licence to proceed");
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
