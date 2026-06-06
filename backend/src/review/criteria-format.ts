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
// New IDs continue the `c{N}` sequence past whatever numeric suffix the
// existing list reached, so they never collide with a preserved id.
export function appendAddedCriteria(
  existing: Criterion[],
  addedTexts: string[]
): Criterion[] {
  const cleaned = addedTexts.map((t) => String(t || "").trim()).filter(Boolean);
  if (!cleaned.length) return existing;
  let nextN = 0;
  for (const c of existing) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) {
      const n = Number(m[1]);
      if (n > nextN) nextN = n;
    }
  }
  const added: Criterion[] = cleaned.map((text) => ({
    id: `c${++nextN}`,
    text,
    met: null,
    evidence: null,
  }));
  return [...existing, ...added];
}
