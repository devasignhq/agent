// The defect review stage's pure core. Two things are worth pinning here, and
// both are safety properties rather than formatting:
//
//   1. normaliseDefectFindings is a FILTER. Blocker-severity defects gate a
//      merge, so the "no concrete failure scenario, no finding" rule has to be
//      enforced in code — a prompt instruction alone would be a suggestion.
//   2. dedupeAndCapFindings collapses findings that mean the same thing in
//      different words, so the defect pass can't re-report what the holistic
//      pass already flagged (which would double-count in the gate).
//
// Run: ANTHROPIC_API_KEY= node --import tsx/esm --test src/review/defect-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFECT_FINDING_CAP,
  dedupeAndCapFindings,
  normaliseDefectFindings,
  type HolisticFinding,
} from "./pipeline.js";

const ok = (over: Record<string, unknown> = {}) => ({
  path: "src/pay.ts",
  defectClass: "unhandled-error",
  concern: "The catch block swallows the error and returns success.",
  failureScenario: "A 500 from the payment provider is reported to the caller as a completed charge.",
  severity: "warn",
  fixPrompt: "Fix: rethrow",
  ...over,
});

test("drops a finding with no failureScenario — the precision gate", () => {
  const out = normaliseDefectFindings([ok({ failureScenario: "" }), ok({ failureScenario: "   " })]);
  assert.equal(out.length, 0, "a finding with no concrete failure scenario is speculation, not a defect");
});

test("drops a finding with no concern", () => {
  assert.equal(normaliseDefectFindings([ok({ concern: "" })]).length, 0);
});

test("keeps a well-formed finding with every field intact", () => {
  const [f] = normaliseDefectFindings([ok({ severity: "blocker" })]);
  assert.equal(f.severity, "blocker");
  assert.equal(f.path, "src/pay.ts");
  assert.equal(f.defectClass, "unhandled-error");
  assert.match(f.failureScenario!, /completed charge/);
  assert.equal(f.fixPrompt, "Fix: rethrow");
});

test("an unrecognized severity falls back to warn, never blocker", () => {
  for (const bad of ["critical", "high", "BLOCKER", undefined, null, 7, {}]) {
    const [f] = normaliseDefectFindings([ok({ severity: bad })]);
    assert.equal(f.severity, "warn", `severity ${JSON.stringify(bad)} must not be able to gate a merge`);
  }
});

test('"nit" survives as its own tier', () => {
  assert.equal(normaliseDefectFindings([ok({ severity: "nit" })])[0].severity, "nit");
});

test("caps the number of findings", () => {
  const many = Array.from({ length: 40 }, (_, i) => ok({ concern: `distinct concern number ${i}` }));
  assert.equal(normaliseDefectFindings(many).length, DEFECT_FINDING_CAP);
});

test("truncates over-long free text so one finding can't blow up a comment", () => {
  const [f] = normaliseDefectFindings([
    ok({ concern: "x".repeat(50_000), failureScenario: "y".repeat(50_000) }),
  ]);
  assert.ok(f.concern.length < 5_000, "concern should be clamped");
  assert.ok(f.failureScenario!.length < 5_000, "failureScenario should be clamped");
});

test("tolerates junk input", () => {
  assert.deepEqual(normaliseDefectFindings(null), []);
  assert.deepEqual(normaliseDefectFindings("nope"), []);
  assert.deepEqual(normaliseDefectFindings([null, 42, "x"]), []);
});

test("dedupe collapses a defect that paraphrases an existing holistic finding", () => {
  const alreadyReported: HolisticFinding[] = [
    { path: "src/pay.ts", concern: "Returns before the write lands", severity: "blocker" },
  ];
  const defects = normaliseDefectFindings([
    ok({ concern: "returns before the write lands." }),
    ok({ concern: "The retry is not idempotent and can double-charge." }),
  ]);
  const out = dedupeAndCapFindings(defects, DEFECT_FINDING_CAP, alreadyReported);
  assert.equal(out.length, 1, "the paraphrase should be dropped, the distinct finding kept");
  assert.match(out[0].concern, /idempotent/);
});

test("dedupe keeps the same concern reported against different files", () => {
  const defects = normaliseDefectFindings([
    ok({ path: "src/a.ts" }),
    ok({ path: "src/b.ts" }),
  ]);
  assert.equal(dedupeAndCapFindings(defects, DEFECT_FINDING_CAP).length, 2);
});

test("dedupe with no `against` list behaves as before for a single source", () => {
  const dupes: HolisticFinding[] = [
    { path: "src/a.ts", concern: "same thing", severity: "warn" },
    { path: "src/a.ts", concern: "same thing", severity: "warn" },
    { path: "src/a.ts", concern: "different thing entirely", severity: "warn" },
  ];
  assert.equal(dedupeAndCapFindings(dupes, 20).length, 2);
});
