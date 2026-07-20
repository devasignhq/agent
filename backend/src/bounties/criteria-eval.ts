// Scoring for the bounty-criteria eval harness (scripts/eval-criteria.ts).
//
// The offline mock returns four fixed criteria regardless of input, so CI can
// prove the drafting plumbing works and nothing at all about whether the
// criteria are GOOD. That judgment needs a live model — but the aggregation
// around it does not, so it lives here: pure, exported and unit-tested, the
// same split the review pipeline uses for partitionReverifiedVulns.
//
// The four flags are exactly the failure modes the bounty prompt's guardrails
// target. If a rule is added there, add a flag here, or the eval stops
// measuring the thing the prompt is trying to prevent.
import { lintCriteria, type CriteriaLintFinding } from "./criteria-lint.js";

export type CriterionFlag =
  /** Requires work the issue never asked for — the contributor does it unpaid. */
  | "out_of_scope"
  /** Cannot be settled by reading the PR: needs a running app, a deploy, a chat. */
  | "not_pr_verifiable"
  /** Names a solution instead of an outcome, forbidding a better implementation. */
  | "dictates_implementation"
  /** Derived from a repo_context file summary rather than from the issue. */
  | "invented_from_context";

export const CRITERION_FLAGS: CriterionFlag[] = [
  "out_of_scope",
  "not_pr_verifiable",
  "dictates_implementation",
  "invented_from_context",
];

export type JudgeVerdict = { index: number; flags: CriterionFlag[]; note: string };

export type ScoredCriterion = {
  index: number;
  text: string;
  flags: CriterionFlag[];
  note: string;
};

export type EvalCase = {
  ref: string;
  endGoal: string;
  criteria: string[];
  scored: ScoredCriterion[];
  lint: CriteriaLintFinding[];
  /** Criteria carrying at least one flag. */
  flaggedCount: number;
};

// Keep the literal "bounty criteria evaluation" marker — the offline LLM mock
// keys off it, so the harness stays smoke-testable without an API key.
export const JUDGE_SYSTEM_PROMPT =
  "You are DevAsign's bounty criteria evaluation step. You are given a GitHub issue, the list of acceptance " +
  "criteria another model drafted from it, and the paths of repository files that were shown as background " +
  "context. Judge each criterion and emit a JSON object: " +
  '{"results": [{"index": number, "flags": string[], "note": string}]}. ' +
  "`index` is the criterion's zero-based position in the list you were given. `note` is one short sentence " +
  "justifying the flags, or why the criterion is sound when there are none. Use ONLY these flags:\n" +
  "- `out_of_scope`: the criterion requires work the issue does not ask for (added hardening, refactors, " +
  "telemetry, docs, accessibility or performance the issue never mentions).\n" +
  "- `not_pr_verifiable`: the criterion cannot be settled by reading a pull request. It needs the application " +
  "running, a screenshot, a staging deploy, a benchmark, a design review, or a conversation.\n" +
  "- `dictates_implementation`: the criterion names a specific solution, file or data structure instead of " +
  "stating the outcome, so it forbids a better implementation.\n" +
  "- `invented_from_context`: the criterion was derived from the background repository files rather than from " +
  "the issue itself. Background files are descriptive only; a requirement that exists solely because a file " +
  "exists is invented.\n" +
  "Return an EMPTY `flags` array for a sound criterion — most criteria in a good list should have none. Be " +
  "strict but do not invent problems: a criterion that is merely terse, or that restates the issue plainly, is " +
  "sound. Judge only what is written; never rewrite the criterion. Never use emoji.";

/** The share of flagged criteria above which a run is considered a regression. */
export const FLAG_RATE_THRESHOLD = 0.15;

/**
 * Extract the judge's verdicts from a raw model response.
 *
 * Tolerant by design: fenced JSON, surrounding prose, unknown flag strings and
 * out-of-range indices all degrade to "no verdict for that criterion" rather
 * than throwing. A judge that returns garbage should show up as unjudged
 * criteria in the report, not as a crashed run halfway through a paid corpus.
 */
export function parseJudgeVerdicts(raw: string, criteriaCount: number): JudgeVerdict[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed?.results) ? parsed.results : [];
  const seen = new Set<number>();
  const out: JudgeVerdict[] = [];
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || index < 0 || index >= criteriaCount) continue;
    if (seen.has(index)) continue; // first verdict per criterion wins
    seen.add(index);
    const raw: unknown[] = Array.isArray(row?.flags) ? row.flags : [];
    const flags: CriterionFlag[] = raw.filter((f): f is CriterionFlag =>
      CRITERION_FLAGS.includes(f as CriterionFlag)
    );
    out.push({ index, flags: [...new Set(flags)], note: String(row?.note ?? "").trim() });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Join one issue's drafted criteria with the judge's verdicts and the linter. */
export function scoreCriteria(args: {
  ref: string;
  endGoal: string;
  criteria: string[];
  verdicts: JudgeVerdict[];
}): EvalCase {
  const byIndex = new Map(args.verdicts.map((v) => [v.index, v]));
  const scored: ScoredCriterion[] = args.criteria.map((text, index) => {
    const verdict = byIndex.get(index);
    return {
      index,
      text,
      flags: verdict?.flags ?? [],
      // An unjudged criterion is reported as such rather than assumed sound —
      // silently counting it as clean would flatter the score.
      note: verdict?.note || (verdict ? "" : "(no verdict returned)"),
    };
  });
  return {
    ref: args.ref,
    endGoal: args.endGoal,
    criteria: args.criteria,
    scored,
    lint: lintCriteria(args.criteria, args.endGoal),
    flaggedCount: scored.filter((s) => s.flags.length > 0).length,
  };
}

export type EvalSummary = {
  cases: number;
  totalCriteria: number;
  flagged: number;
  flagRate: number;
  byFlag: Record<CriterionFlag, number>;
  lintFindings: number;
  emptyCases: number;
  unjudged: number;
  passed: boolean;
};

/**
 * Roll a run up to the numbers worth acting on. `flagRate` is per-criterion,
 * not per-issue: one issue producing six bad criteria is a worse signal than
 * six issues producing one each, and averaging per-issue would hide that.
 */
export function summarizeEval(cases: EvalCase[], threshold = FLAG_RATE_THRESHOLD): EvalSummary {
  const byFlag = Object.fromEntries(CRITERION_FLAGS.map((f) => [f, 0])) as Record<CriterionFlag, number>;
  let totalCriteria = 0;
  let flagged = 0;
  let lintFindings = 0;
  let emptyCases = 0;
  let unjudged = 0;

  for (const c of cases) {
    totalCriteria += c.criteria.length;
    flagged += c.flaggedCount;
    lintFindings += c.lint.length;
    if (!c.criteria.length) emptyCases++;
    for (const s of c.scored) {
      if (s.note === "(no verdict returned)") unjudged++;
      for (const f of s.flags) byFlag[f]++;
    }
  }

  const flagRate = totalCriteria ? flagged / totalCriteria : 0;
  return {
    cases: cases.length,
    totalCriteria,
    flagged,
    flagRate,
    byFlag,
    lintFindings,
    emptyCases,
    unjudged,
    passed: flagRate <= threshold,
  };
}
