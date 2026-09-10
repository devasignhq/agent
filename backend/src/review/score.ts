// The merge score shown at the top of the DevAsign review comment.
//
// Deterministic weighted penalty from 100, computed from the OPEN item set —
// never asked of the model. A score that drifts 72 -> 68 on a rerun of an
// unchanged diff would destroy trust in the card faster than a missed bug, and
// a pure function is the only version we can unit-test offline.
//
//   node --import tsx/esm --test src/review/score.test.ts
import type { SecuritySeverity } from "../types.js";

// What a scored item costs. Criteria are split out from findings because "a
// requirement the PR was asked for and did not deliver" is a different kind of
// miss from "a bug someone noticed along the way", and a regression — something
// an earlier commit in this same PR had working — is the worst of the three.
export type ScoreKind =
  | "criterion-regressed"
  | "criterion-unmet"
  | "criterion-unevaluated"
  | "criterion-met"
  | "finding";

export type Scorable = {
  scoreKind: ScoreKind;
  severity: "blocker" | "warn" | "nit";
  // Security findings carry the Security page's 4-tier severity; it replaces the
  // coarse blocker/warn/nit weight so a "high" doesn't cost the same as a "low".
  securitySeverity?: SecuritySeverity;
};

const CRITERION_WEIGHTS: Record<ScoreKind, number> = {
  "criterion-regressed": 20,
  "criterion-unmet": 15,
  "criterion-unevaluated": 5,
  "criterion-met": 0,
  finding: 0,
};

const SEVERITY_WEIGHTS = { blocker: 20, warn: 6, nit: 2 } as const;

const SECURITY_WEIGHTS: Record<SecuritySeverity, number> = {
  critical: 25,
  high: 12,
  medium: 6,
  low: 2,
};

export function itemPenalty(item: Scorable): number {
  if (item.scoreKind !== "finding") return CRITERION_WEIGHTS[item.scoreKind];
  if (item.securitySeverity) return SECURITY_WEIGHTS[item.securitySeverity];
  return SEVERITY_WEIGHTS[item.severity];
}

/** 0-100. A clean PR with nothing open scores 100. */
export function mergeScore(open: Scorable[]): number {
  let penalty = 0;
  for (const item of open) penalty += itemPenalty(item);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

export type VerificationCounts = { pass: number; fail: number; unverifiable: number; pending: number };

// A failing verification test is an assertion failure against the code (the
// judge routes broken/flaky tests to "unverifiable", never "fail"). Every
// verified test failing is a different situation: cap the score in the red.
export const FAILING_TEST_PENALTY = 10;
export const ALL_FAILING_CAP = 49;

export function applyVerification(
  base: number,
  counts?: VerificationCounts | null
): { score: number; allFailing: boolean } {
  if (!counts || counts.fail <= 0) return { score: base, allFailing: false };
  const allFailing = counts.pass === 0;
  let score = Math.max(0, Math.min(100, Math.round(base - counts.fail * FAILING_TEST_PENALTY)));
  if (allFailing) score = Math.min(score, ALL_FAILING_CAP);
  return { score, allFailing };
}

// Green at 80+, amber through the middle, red below 50 — the reader should be
// able to tell "ship it" from "look at this" from the icon alone.
export function scoreIcon(score: number): string {
  return score >= 80 ? "✅" : score >= 50 ? "🟡" : "🔴";
}

/** The "### ✅ Merge score: 92/100" header line. */
export function scoreHeader(score: number, label = "Merge score"): string {
  return `### ${scoreIcon(score)} ${label}: ${score}/100`;
}
