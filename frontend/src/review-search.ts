// Queue search matching. Mirrors backend/src/review/search.ts — the server only
// widens the candidate pool, so this predicate decides what actually renders.

const MAX_QUERY_LEN = 128;
const MAX_TERMS = 8;
const NUMERIC = /^\d+$/;

export type ReviewSearchRow = {
  title?: string | null;
  repo?: string | null;
  prNumber?: number | null;
};

// Bounded so a pasted essay can't turn into a 10k-term AND scan per keystroke.
export function reviewSearchTerms(query: string): string[] {
  return query
    .slice(0, MAX_QUERY_LEN)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => (t.startsWith("#") ? t.slice(1) : t))
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

// All terms must hit, so "acme login" narrows instead of widening. A digit term
// prefix-matches the PR number: exact would blank the list on every keystroke
// before the number is complete.
export function matchesReviewTerms(row: ReviewSearchRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = `${row.title ?? ""} ${row.repo ?? ""}`.toLowerCase();
  const num = row.prNumber == null ? "" : String(row.prNumber);
  return terms.every((t) => hay.includes(t) || (NUMERIC.test(t) && num.startsWith(t)));
}

export function matchesReviewQuery(row: ReviewSearchRow, query: string): boolean {
  return matchesReviewTerms(row, reviewSearchTerms(query));
}

// Built with URLSearchParams so a typed "&" or "#" can't corrupt the URL.
export function reviewsQuery(opts: { status?: string; q?: string } = {}): string {
  const p = new URLSearchParams();
  if (opts.status) p.set("status", opts.status);
  const q = (opts.q ?? "").trim().slice(0, MAX_QUERY_LEN);
  if (q) p.set("q", q);
  const s = p.toString();
  return s ? `?${s}` : "";
}
