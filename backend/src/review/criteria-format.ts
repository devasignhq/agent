// Helpers for rendering the review prompt's "# Criteria" block. Kept in their
// own module (no db/llm/github imports) so they're cheap to unit-test offline:
//   node --import tsx/esm --test src/review/criteria-format.test.ts
import type { Criterion } from "../types.js";

// The verdict a criterion received in the previous review of this PR. Captured
// before the current run mutates state, then handed to the review step so it can
// anchor on what earlier commits already established.
export type PriorVerdict = { met: boolean | null; evidence: string | null };

// Render the "# Criteria" list, annotating each criterion with the verdict it
// got in the previous review of an *earlier commit in the same PR*. The
// annotation is what lets the review step keep an already-satisfied criterion
// satisfied instead of re-judging it from scratch — which is how a passed
// criterion used to flip to "unmet" when an unrelated follow-up commit (e.g. a
// security fix) was pushed. `prior` is empty on a first review, so every line
// reads "not yet evaluated" — identical to the old un-annotated behaviour.
export function buildCriteriaSection(
  criteria: Criterion[],
  prior: Map<string, PriorVerdict>
): string {
  return criteria
    .map((c) => {
      const p = prior.get(c.id);
      const tag =
        p?.met === true
          ? "  [previously SATISFIED by an earlier commit in this PR]"
          : p?.met === false
            ? "  [previously NOT met — re-evaluate]"
            : "  [not yet evaluated]";
      return `- ${c.id}: ${c.text}\n${tag}`;
    })
    .join("\n");
}

// Append fresh criteria from a maintainer comment (or any other additive source)
// onto the existing list. Existing criteria pass through untouched — including
// `met` and `evidence` — so prior verdicts survive the next review pass and
// already-satisfied requirements don't re-fail just because a new bar moved.
// New IDs continue the plain-number sequence past whatever number the existing
// list reached, so the criteria render as one run (1, 2, 3 …) across commits
// instead of restarting. The trailing-digit parse is prefix-tolerant so it also
// counts past legacy ids ("c5", "C5") on PRs synthesized before this convention.
export function appendAddedCriteria(
  existing: Criterion[],
  addedTexts: string[]
): Criterion[] {
  const cleaned = addedTexts.map((t) => String(t || "").trim()).filter(Boolean);
  if (!cleaned.length) return existing;
  let nextN = 0;
  for (const c of existing) {
    const m = /(\d+)$/.exec(c.id);
    if (m) {
      const n = Number(m[1]);
      if (n > nextN) nextN = n;
    }
  }
  const added: Criterion[] = cleaned.map((text) => ({
    id: String(++nextN),
    text,
    met: null,
    evidence: null,
  }));
  return [...existing, ...added];
}

// Partition the scored criteria for the verdict comment / in-app timeline.
// `regressed` are criteria an earlier commit satisfied that a later commit broke
// — surfaced prominently because the developer needs to know their change undid
// prior work. `unmet` are still-open requirements (newly added or never met).
// `met` are currently satisfied; the comment collapses these instead of
// re-listing them on every run. A criterion is only "regressed", never also
// "unmet" — the prior-met check takes precedence over the not-met bucket.
/** Superseded by a reword, or marked not-applicable, through PR-comment feedback. */
export function isRetiredCriterion(c: Criterion): boolean {
  return !!c.supersededBy || !!c.notApplicable;
}

export function splitForComment(
  criteria: Criterion[],
  prior: Map<string, PriorVerdict>
): { regressed: Criterion[]; unmet: Criterion[]; met: Criterion[] } {
  const regressed: Criterion[] = [];
  const unmet: Criterion[] = [];
  const met: Criterion[] = [];
  for (const c of criteria) {
    // Reworded or dismissed via PR-comment feedback: the replacement is graded
    // instead, so listing the retired text would re-open a closed question.
    if (isRetiredCriterion(c)) continue;
    if (c.met === true) met.push(c);
    else if (prior.get(c.id)?.met === true) regressed.push(c);
    else unmet.push(c);
  }
  return { regressed, unmet, met };
}
