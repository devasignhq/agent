// Queue search matching. Mirrors frontend/src/review-search.ts — the frontend
// re-applies the same predicate, so keep the matched field set identical.

const MAX_QUERY_LEN = 128;
const MAX_TERMS = 8;
const NUMERIC = /^\d+$/;

// Bounds a pathological history; only the ?q= path is capped.
export const REVIEW_SEARCH_LIMIT = 200;

export function reviewSearchTerms(query: string): string[] {
  return query
    .slice(0, MAX_QUERY_LEN)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => (t.startsWith("#") ? t.slice(1) : t))
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

// A digit term prefix-matches the PR number: exact would blank the list on every
// keystroke before the number is complete.
export function reviewMatchesTerms(
  row: { prTitle?: string | null; prNumber?: number | null },
  repoLabel: string,
  terms: string[]
): boolean {
  if (terms.length === 0) return true;
  const hay = `${row.prTitle ?? ""} ${repoLabel}`.toLowerCase();
  const num = row.prNumber == null ? "" : String(row.prNumber);
  return terms.every((t) => hay.includes(t) || (NUMERIC.test(t) && num.startsWith(t)));
}
