// Offline tests for the prior-verdict annotation in the review prompt. No network/db:
//   node --import tsx/esm --test src/review/criteria-format.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendAddedCriteria,
  buildCriteriaSection,
  isRetiredCriterion,
  splitForComment,
  type PriorVerdict,
} from "./criteria-format.js";
import type { Criterion } from "../types.js";

const crit = (id: string, text: string): Criterion => ({ id, text, met: null, evidence: null });
const verdict = (
  id: string,
  text: string,
  met: boolean | null,
  evidence: string | null
): Criterion => ({ id, text, met, evidence });

test("first review (no prior verdicts) marks every criterion not-yet-evaluated", () => {
  const out = buildCriteriaSection([crit("c1", "Adds retry on 5xx"), crit("c2", "Logs failures")], new Map());
  assert.match(out, /- c1: Adds retry on 5xx\n {2}\[not yet evaluated\]/);
  assert.match(out, /- c2: Logs failures\n {2}\[not yet evaluated\]/);
  assert.doesNotMatch(out, /SATISFIED/);
});

test("a previously-met criterion is marked SATISFIED so a follow-up commit can't re-fail it", () => {
  const prior = new Map<string, PriorVerdict>([["c1", { met: true, evidence: "retry loop added in api.ts" }]]);
  const out = buildCriteriaSection([crit("c1", "Adds retry on 5xx")], prior);
  assert.match(out, /\[previously SATISFIED by an earlier commit in this PR\]/);
});

test("a previously-unmet criterion is flagged for fresh re-evaluation", () => {
  const prior = new Map<string, PriorVerdict>([["c1", { met: false, evidence: "no retry found" }]]);
  const out = buildCriteriaSection([crit("c1", "Adds retry on 5xx")], prior);
  assert.match(out, /\[previously NOT met — re-evaluate\]/);
});

test("a met:null prior (evaluated but inconclusive) degrades to not-yet-evaluated", () => {
  const prior = new Map<string, PriorVerdict>([["c1", { met: null, evidence: null }]]);
  const out = buildCriteriaSection([crit("c1", "Adds retry on 5xx")], prior);
  assert.match(out, /\[not yet evaluated\]/);
});

test("a criterion with no matching prior id (e.g. re-synthesized) is not-yet-evaluated", () => {
  const prior = new Map<string, PriorVerdict>([["c1", { met: true, evidence: "x" }]]);
  const out = buildCriteriaSection([crit("c2", "New criterion")], prior);
  assert.match(out, /\[not yet evaluated\]/);
});

test("empty criteria (spec-less PR) produce an empty section — nothing to anchor or invent", () => {
  assert.equal(buildCriteriaSection([], new Map()), "");
});

test("appending new criteria preserves existing met/evidence and assigns fresh ids", () => {
  const existing: Criterion[] = [
    verdict("c1", "Adds retry on 5xx", true, "retry loop in api.ts:42"),
    verdict("c2", "Logs failures", false, "no logger call found"),
    verdict("c3", "Updates docs", null, null),
  ];
  const merged = appendAddedCriteria(existing, ["PR must add rate limiting to /api/foo"]);

  assert.equal(merged.length, 4);
  // existing pass through untouched — bit-for-bit
  assert.deepEqual(merged[0], existing[0]);
  assert.deepEqual(merged[1], existing[1]);
  assert.deepEqual(merged[2], existing[2]);
  // the appended one gets the next sequential id and starts un-evaluated
  assert.deepEqual(merged[3], {
    id: "4",
    text: "PR must add rate limiting to /api/foo",
    met: null,
    evidence: null,
  });
});

test("appending an empty list is a no-op — no flip, no churn", () => {
  const existing: Criterion[] = [verdict("c1", "Adds retry on 5xx", true, "evidence")];
  const merged = appendAddedCriteria(existing, []);
  assert.deepEqual(merged, existing);
});

test("whitespace-only added texts are dropped before id assignment", () => {
  const existing: Criterion[] = [verdict("c1", "X", true, "e")];
  const merged = appendAddedCriteria(existing, ["   ", "", "real new criterion"]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, "2");
  assert.equal(merged[1].text, "real new criterion");
});

test("new ids skip past the highest existing numeric suffix, not the count", () => {
  // existing list has gaps (c1 was removed earlier in some path, or seeded weird) —
  // the next id must not collide with c5 just because the list has 3 entries.
  const existing: Criterion[] = [
    verdict("c2", "a", null, null),
    verdict("c5", "b", null, null),
    verdict("c7", "c", null, null),
  ];
  const merged = appendAddedCriteria(existing, ["x", "y"]);
  assert.equal(merged[3].id, "8");
  assert.equal(merged[4].id, "9");
});

test("spec-less PR (empty existing) bootstraps the list from added criteria", () => {
  const merged = appendAddedCriteria([], ["first thing", "second thing"]);
  assert.deepEqual(merged, [
    { id: "1", text: "first thing", met: null, evidence: null },
    { id: "2", text: "second thing", met: null, evidence: null },
  ]);
});

test("non-standard existing ids still continue by trailing digits", () => {
  // Defensive: if some upstream path ever seeded non-standard ids, the helper
  // parses the trailing number off each so it keeps numbering instead of colliding.
  const existing: Criterion[] = [
    verdict("acceptance-1", "weird id", null, null),
    verdict("c3", "legacy id", null, null),
  ];
  const merged = appendAddedCriteria(existing, ["new"]);
  // trailing digits: acceptance-1 → 1, c3 → 3; highest is 3, so next is 4
  assert.equal(merged[2].id, "4");
});

test("appended ids continue past legacy UPPERCASE ids instead of restarting at 1", () => {
  // The reported bug: synthesis emitted "C1".."C9" (uppercase), the old lowercase-only
  // parser matched none of them, and appended criteria restarted at c1 — so the comment
  // showed two runs (C1..C9 then c1..c7). Trailing-digit parsing must continue: C9 → 10, 11.
  const existing: Criterion[] = Array.from({ length: 9 }, (_, i) =>
    verdict(`C${i + 1}`, `met ${i + 1}`, true, "ok")
  );
  const merged = appendAddedCriteria(existing, ["new bar A", "new bar B"]);
  assert.equal(merged.length, 11);
  assert.equal(merged[9].id, "10");
  assert.equal(merged[10].id, "11");
});

test("appended ids continue past plain-number ids", () => {
  const existing: Criterion[] = [
    verdict("1", "a", true, "ok"),
    verdict("2", "b", null, null),
    verdict("3", "c", false, "no"),
  ];
  const merged = appendAddedCriteria(existing, ["d"]);
  assert.equal(merged[3].id, "4");
});

// --- splitForComment: regressed vs unmet vs met buckets for the comment/UI ---

test("splitForComment: the reported scenario — 11 met + 4 new unmet → zero regressions", () => {
  const filled: Criterion[] = [];
  const prior = new Map<string, PriorVerdict>();
  for (let i = 1; i <= 11; i++) {
    filled.push(verdict(`c${i}`, `met ${i}`, true, "ok"));
    prior.set(`c${i}`, { met: true, evidence: "ok" }); // satisfied by the first commit
  }
  for (let i = 12; i <= 15; i++) {
    filled.push(verdict(`c${i}`, `new ${i}`, false, "not yet")); // added by the comment, no prior
  }
  const { regressed, unmet, met } = splitForComment(filled, prior);
  assert.equal(regressed.length, 0); // the bug: these used to be reported as "not met"
  assert.deepEqual(unmet.map((c) => c.id), ["c12", "c13", "c14", "c15"]);
  assert.equal(met.length, 11);
});

test("splitForComment: a previously-met criterion now unmet is a regression, not plain unmet", () => {
  const filled = [
    verdict("c1", "was met", false, "removed the retry loop"),
    verdict("c2", "never met", false, "missing"),
    verdict("c3", "still met", true, "present"),
  ];
  const prior = new Map<string, PriorVerdict>([
    ["c1", { met: true, evidence: "retry loop in api.ts" }],
    ["c2", { met: false, evidence: "missing" }],
    ["c3", { met: true, evidence: "present" }],
  ]);
  const { regressed, unmet, met } = splitForComment(filled, prior);
  assert.deepEqual(regressed.map((c) => c.id), ["c1"]);
  assert.deepEqual(unmet.map((c) => c.id), ["c2"]);
  assert.deepEqual(met.map((c) => c.id), ["c3"]);
});

test("splitForComment: an inconclusive (met:null) prior is not treated as a regression", () => {
  const filled = [verdict("c1", "x", false, "no")];
  const prior = new Map<string, PriorVerdict>([["c1", { met: null, evidence: null }]]);
  const { regressed, unmet } = splitForComment(filled, prior);
  assert.equal(regressed.length, 0);
  assert.deepEqual(unmet.map((c) => c.id), ["c1"]);
});

// PR-comment feedback retires a criterion by pointing it at its replacement
// (reword) or flagging it not-applicable — it is never deleted, because the
// revision history has to keep it. The review must stop grading it.
test("criteria retired through comment feedback drop out of the comment split", () => {
  const criteria: Criterion[] = [
    { id: "1", text: "old wording", met: false, evidence: null, supersededBy: "4" },
    { id: "2", text: "not our problem", met: false, evidence: null, notApplicable: true },
    { id: "3", text: "still open", met: false, evidence: null },
    { id: "4", text: "new wording", met: true, evidence: null },
  ];
  assert.deepEqual(criteria.map(isRetiredCriterion), [true, true, false, false]);
  const { regressed, unmet, met } = splitForComment(criteria, new Map<string, PriorVerdict>([["1", { met: true, evidence: null }]]));
  assert.deepEqual(unmet.map((c) => c.id), ["3"], "only live criteria stay open");
  assert.deepEqual(met.map((c) => c.id), ["4"]);
  assert.deepEqual(regressed.map((c) => c.id), [], "a retired criterion cannot regress");
});
