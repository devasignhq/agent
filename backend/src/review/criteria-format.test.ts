// Offline tests for the prior-verdict annotation in the review prompt. No network/db:
//   node --import tsx/esm --test src/review/criteria-format.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCriteriaSection, type PriorVerdict } from "./criteria-format.js";
import type { Criterion } from "../types.js";

const crit = (id: string, text: string): Criterion => ({ id, text, met: null, evidence: null });

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
