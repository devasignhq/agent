// Pure tests for the merge score. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/score.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerification, mergeScore, scoreHeader, scoreIcon, type Scorable } from "./score.js";

const finding = (
  severity: Scorable["severity"],
  securitySeverity?: Scorable["securitySeverity"]
): Scorable => ({ scoreKind: "finding", severity, securitySeverity });

const criterion = (scoreKind: Scorable["scoreKind"]): Scorable => ({
  scoreKind,
  severity: "warn",
});

test("failing verification tests cost 10 each; all failing caps the score in the red", () => {
  const counts = (over: Partial<{ pass: number; fail: number; unverifiable: number; pending: number }>) => ({
    pass: 0, fail: 0, unverifiable: 0, pending: 0, ...over,
  });
  assert.deepEqual(applyVerification(100, counts({ pass: 3, fail: 1 })), { score: 90, allFailing: false });
  assert.deepEqual(applyVerification(100, counts({ pass: 1, fail: 3 })), { score: 70, allFailing: false });
  assert.deepEqual(applyVerification(100, counts({ pass: 0, fail: 2 })), { score: 49, allFailing: true });
  assert.deepEqual(applyVerification(30, counts({ pass: 0, fail: 1 })), { score: 20, allFailing: true }, "the cap never raises");
  assert.deepEqual(applyVerification(100, counts({ pass: 2, unverifiable: 3, pending: 1 })), { score: 100, allFailing: false });
  assert.deepEqual(applyVerification(85, null), { score: 85, allFailing: false });
  assert.deepEqual(applyVerification(85, undefined), { score: 85, allFailing: false });
});

test("nothing open scores 100", () => {
  assert.equal(mergeScore([]), 100);
  assert.equal(mergeScore([criterion("criterion-met")]), 100);
});

test("criteria are weighted regressed > unmet > unevaluated", () => {
  assert.equal(mergeScore([criterion("criterion-regressed")]), 80);
  assert.equal(mergeScore([criterion("criterion-unmet")]), 85);
  assert.equal(mergeScore([criterion("criterion-unevaluated")]), 95);
});

test("findings are weighted blocker > warn > nit", () => {
  assert.equal(mergeScore([finding("blocker")]), 80);
  assert.equal(mergeScore([finding("warn")]), 94);
  assert.equal(mergeScore([finding("nit")]), 98);
});

test("a security finding is scored on its 4-tier severity, not the coarse one", () => {
  // Both are legacy "blocker"; only the tier separates them.
  assert.equal(mergeScore([finding("blocker", "critical")]), 75);
  assert.equal(mergeScore([finding("warn", "high")]), 88);
  assert.equal(mergeScore([finding("warn", "medium")]), 94);
  assert.equal(mergeScore([finding("warn", "low")]), 98);
});

test("penalties accumulate and clamp at 0 rather than going negative", () => {
  assert.equal(mergeScore([criterion("criterion-unmet"), finding("blocker")]), 65);
  const pileOn = Array.from({ length: 20 }, () => finding("blocker"));
  assert.equal(mergeScore(pileOn), 0);
});

test("the same input always scores the same — no ordering effects", () => {
  const items = [finding("nit"), criterion("criterion-unmet"), finding("blocker", "high")];
  assert.equal(mergeScore(items), mergeScore([...items].reverse()));
});

test("icon thresholds: green at 80, amber at 50, red below", () => {
  assert.equal(scoreIcon(100), "✅");
  assert.equal(scoreIcon(80), "✅");
  assert.equal(scoreIcon(79), "🟡");
  assert.equal(scoreIcon(50), "🟡");
  assert.equal(scoreIcon(49), "🔴");
  assert.equal(scoreIcon(0), "🔴");
});

test("scoreHeader renders the icon, label and value", () => {
  assert.equal(scoreHeader(63), "### 🟡 Merge score: 63/100");
  assert.equal(scoreHeader(100, "Test score"), "### ✅ Test score: 100/100");
});
