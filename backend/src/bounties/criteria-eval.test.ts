// Unit tests for the pure half of the criteria eval harness. The judgment
// itself needs a live model, but everything around it — parsing the judge's
// answer, joining verdicts to criteria, rolling up the run — is deterministic
// and belongs under CI, so a broken aggregation can't quietly flatter a report.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/criteria-eval.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_RATE_THRESHOLD,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeVerdicts,
  scoreCriteria,
  summarizeEval,
  type EvalCase,
} from "./criteria-eval.js";

const CRITERIA = [
  "Duplicate webhook deliveries are ignored.",
  "The receiver returns 202 for a replayed delivery id.",
  "A new delivery id is still processed.",
];
const GOAL = "The webhook receiver ignores duplicate deliveries.";

// ── the judge prompt ─────────────────────────────────────────────────────────

test("the judge prompt keeps its offline-mock marker", () => {
  assert.match(
    JUDGE_SYSTEM_PROMPT,
    /bounty criteria evaluation/,
    "mockComplete keys off this literal — without it the harness cannot smoke-test offline"
  );
});

// ── parsing ──────────────────────────────────────────────────────────────────

test("parses a well-formed judge response", () => {
  const raw = JSON.stringify({
    results: [
      { index: 0, flags: [], note: "sound" },
      { index: 1, flags: ["not_pr_verifiable"], note: "needs the app running" },
    ],
  });
  assert.deepEqual(parseJudgeVerdicts(raw, 3), [
    { index: 0, flags: [], note: "sound" },
    { index: 1, flags: ["not_pr_verifiable"], note: "needs the app running" },
  ]);
});

test("tolerates fenced JSON and surrounding prose", () => {
  const raw = 'Here you go:\n```json\n{"results":[{"index":0,"flags":[],"note":"ok"}]}\n```\nHope that helps.';
  assert.equal(parseJudgeVerdicts(raw, 1).length, 1);
});

test("unparseable output yields no verdicts rather than throwing", () => {
  for (const raw of ["", "not json at all", "{", "{oops}"]) {
    assert.deepEqual(parseJudgeVerdicts(raw, 3), [], `should degrade quietly: ${raw}`);
  }
});

test("drops out-of-range indices, unknown flags, and duplicate verdicts", () => {
  const raw = JSON.stringify({
    results: [
      { index: 0, flags: ["out_of_scope", "made_up_flag"], note: "a" },
      { index: 0, flags: ["not_pr_verifiable"], note: "duplicate, ignored" },
      { index: 9, flags: ["out_of_scope"], note: "out of range" },
      { index: -1, flags: [], note: "negative" },
      { index: "two", flags: [], note: "not a number" },
    ],
  });
  const out = parseJudgeVerdicts(raw, 3);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { index: 0, flags: ["out_of_scope"], note: "a" });
});

test("deduplicates repeated flags on one criterion", () => {
  const raw = JSON.stringify({
    results: [{ index: 0, flags: ["out_of_scope", "out_of_scope"], note: "n" }],
  });
  assert.deepEqual(parseJudgeVerdicts(raw, 1)[0].flags, ["out_of_scope"]);
});

// ── scoring ──────────────────────────────────────────────────────────────────

test("joins verdicts onto criteria by index and counts flagged ones", () => {
  const c = scoreCriteria({
    ref: "acme/pay#12",
    endGoal: GOAL,
    criteria: CRITERIA,
    verdicts: [
      { index: 0, flags: [], note: "sound" },
      { index: 1, flags: ["out_of_scope", "not_pr_verifiable"], note: "two problems" },
      { index: 2, flags: [], note: "sound" },
    ],
  });
  assert.equal(c.flaggedCount, 1, "one criterion is flagged, not two flags counted twice");
  assert.deepEqual(c.scored[1].flags, ["out_of_scope", "not_pr_verifiable"]);
  assert.deepEqual(c.lint, [], "a clean list should also lint clean");
});

test("an unjudged criterion is reported as such, not assumed sound", () => {
  const c = scoreCriteria({ ref: "r", endGoal: GOAL, criteria: CRITERIA, verdicts: [] });
  assert.equal(c.flaggedCount, 0);
  assert.ok(
    c.scored.every((s) => s.note === "(no verdict returned)"),
    "silently treating missing verdicts as clean would flatter the score"
  );
  assert.equal(summarizeEval([c]).unjudged, 3, "and the summary must surface them");
});

test("the linter runs alongside the judge", () => {
  const c = scoreCriteria({
    ref: "r",
    endGoal: "",
    criteria: ["Errors are handled properly."],
    verdicts: [],
  });
  const kinds = c.lint.map((f) => f.lint);
  assert.ok(kinds.includes("empty_end_goal"));
  assert.ok(kinds.includes("vague_word"));
  assert.ok(kinds.includes("count_out_of_range"));
});

// ── summarizing ──────────────────────────────────────────────────────────────

function mkCase(criteria: string[], verdicts: EvalCase["scored"][number]["flags"][]): EvalCase {
  return scoreCriteria({
    ref: "r",
    endGoal: GOAL,
    criteria,
    verdicts: criteria.map((_, index) => ({ index, flags: verdicts[index] ?? [], note: "n" })),
  });
}

test("flagRate is per-criterion, not per-issue", () => {
  // One issue with 4 bad criteria out of 4, plus three clean issues of 4.
  const bad = mkCase(["a", "b", "c", "d"], [["out_of_scope"], ["out_of_scope"], ["out_of_scope"], ["out_of_scope"]]);
  const clean = mkCase(["a", "b", "c", "d"], [[], [], [], []]);
  const s = summarizeEval([bad, clean, clean, clean]);

  assert.equal(s.totalCriteria, 16);
  assert.equal(s.flagged, 4);
  assert.equal(s.flagRate, 0.25, "4/16 — averaging per-issue would report the same and hide the concentration");
  assert.equal(s.byFlag.out_of_scope, 4);
});

test("passes only when the flag rate is at or under the threshold", () => {
  const clean = mkCase(["a", "b", "c", "d"], [[], [], [], []]);
  assert.equal(summarizeEval([clean]).passed, true);

  const oneBad = mkCase(["a", "b", "c", "d"], [["out_of_scope"], [], [], []]);
  assert.equal(summarizeEval([oneBad]).flagRate, 0.25);
  assert.equal(summarizeEval([oneBad]).passed, false);
  assert.equal(summarizeEval([oneBad], 0.5).passed, true, "the threshold is caller-supplied");
  assert.ok(FLAG_RATE_THRESHOLD > 0 && FLAG_RATE_THRESHOLD < 1);
});

test("counts issues that produced no criteria at all", () => {
  const empty = scoreCriteria({ ref: "r", endGoal: "too vague to say", criteria: [], verdicts: [] });
  const s = summarizeEval([empty]);
  assert.equal(s.emptyCases, 1);
  assert.equal(s.totalCriteria, 0);
  assert.equal(s.flagRate, 0, "no criteria means no flag rate, not a divide-by-zero");
  assert.equal(s.passed, true);
});
