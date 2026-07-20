// Deterministic quality checks on a drafted acceptance list. Pure and free (no
// LLM), so this runs both in the unit suite and in the drafting job itself.
//
// It covers only the MECHANICALLY detectable failure modes the bounty prompt
// targets — count, conjoined requirements, unjudgeable words, a missing end
// goal. The judgment-dependent ones (out-of-scope, not verifiable from a PR,
// dictates an implementation, invented from repo context) need a model and live
// in the eval harness instead: scripts/eval-criteria.ts.
//
// ADVISORY ONLY. The job logs these as a telemetry signal and never rejects on
// them — a nagging linter must not stand between a sponsor and funding.
import { MAX_CRITERION_CHARS } from "./acceptance.js";

export type CriteriaLint =
  | "count_out_of_range"
  | "conjoined"
  | "vague_word"
  | "empty_end_goal"
  | "too_long";

export type CriteriaLintFinding = { lint: CriteriaLint; index?: number; detail: string };

// The prompt tells the model to prefer 3-6 and never exceed 8. An EMPTY list is
// deliberately not a finding: it's the intended output for an issue too vague to
// yield a verifiable criterion.
export const MIN_CRITERIA = 3;
export const SOFT_MAX_CRITERIA = 8;

// Words that cannot be judged met/unmet by a reviewer reading a diff. The
// bounty prompt bans these explicitly, so a hit means the model ignored it.
const VAGUE_WORDS = [
  "properly",
  "correctly",
  "robustly",
  "appropriately",
  "gracefully",
  "cleanly",
  "reasonably",
  "as needed",
  "as appropriate",
  "if necessary",
  "where appropriate",
  "make sure it works",
];

// A criterion joining two independent requirements with "and". Both sides must
// be substantial before we flag it — "duplicate deliveries and retries are
// ignored" is one idea, while two 25+ char clauses is almost always two.
const CONJUNCTION_MIN_SIDE = 25;

function isConjoined(text: string): boolean {
  const parts = text.split(/\s+and\s+/i);
  if (parts.length < 2) return false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].trim().length >= CONJUNCTION_MIN_SIDE && parts[i + 1].trim().length >= CONJUNCTION_MIN_SIDE) {
      return true;
    }
  }
  return false;
}

/** Structural problems with a drafted list. Empty array = nothing to flag. */
export function lintCriteria(criteria: string[], endGoal: string): CriteriaLintFinding[] {
  const findings: CriteriaLintFinding[] = [];

  // An empty endGoal is the one finding that also doubles as a correctness
  // signal: the prompt guarantees a non-empty endGoal EVEN when criteria is
  // empty, so its absence means the response never parsed. See criteria-job.ts,
  // which treats that case as a failure rather than a result.
  if (!endGoal.trim()) {
    findings.push({ lint: "empty_end_goal", detail: "endGoal is empty" });
  }

  if (criteria.length > 0 && criteria.length < MIN_CRITERIA) {
    findings.push({
      lint: "count_out_of_range",
      detail: `${criteria.length} criteria (prompt asks for at least ${MIN_CRITERIA} when the issue is specific enough to yield any)`,
    });
  } else if (criteria.length > SOFT_MAX_CRITERIA) {
    findings.push({
      lint: "count_out_of_range",
      detail: `${criteria.length} criteria (prompt caps at ${SOFT_MAX_CRITERIA})`,
    });
  }

  criteria.forEach((text, index) => {
    if (text.length > MAX_CRITERION_CHARS) {
      findings.push({ lint: "too_long", index, detail: `${text.length} chars` });
    }
    if (isConjoined(text)) {
      findings.push({ lint: "conjoined", index, detail: "joins two requirements with 'and'" });
    }
    const lower = text.toLowerCase();
    for (const word of VAGUE_WORDS) {
      // Word-boundary match so "correctly" hits but "incorrectly-named" in a
      // quoted symbol doesn't, and multi-word phrases still match verbatim.
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lower)) {
        findings.push({ lint: "vague_word", index, detail: `unjudgeable wording: "${word}"` });
      }
    }
  });

  return findings;
}
