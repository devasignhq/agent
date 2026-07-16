// Resolve the AI review row for a bounty's delivering PR, and partition its
// criteria into the bounty-seeded list vs later additions. Shared by the
// contributor list view (compact projection, no N+1 client fetches) and the
// detailed GET /bounties/:id/review endpoint so the two can never disagree on
// which review row "counts".
import { db } from "../db.js";
import type { Bounty, Criterion, PRReview } from "../types.js";

export function findBountyReview(b: Bounty): PRReview | null {
  if (!b.prNumber) return null;
  const [owner, name] = b.repo.split("/");
  const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (!repo) return null;
  const candidates = db
    .filter("prReviews", (r) => r.repoId === repo.id && r.prNumber === b.prNumber)
    .sort((x, y) => y.updatedAt - x.updatedAt);
  // Prefer the row explicitly stamped with this bounty (pipeline stage b);
  // fall back to any review of the PR (webhook rows predating the stamp).
  return candidates.find((r) => r.bountyId === b.id) ?? candidates[0] ?? null;
}

const BOUNTY_ID_RE = /^bounty-\d+$/;

/**
 * Partition a review's criteria: `main` = the bounty-seeded (locked) list in
 * acceptance order — or, for reviews predating the seed, whatever criteria the
 * review has; `rest` = additive criteria beyond the seeded list.
 */
export function partitionBountyCriteria(review: PRReview): { main: Criterion[]; rest: Criterion[] } {
  const seeded = review.criteria
    .filter((c) => BOUNTY_ID_RE.test(c.id))
    .sort((x, y) => Number(x.id.slice(7)) - Number(y.id.slice(7)));
  const extras = review.criteria.filter((c) => !BOUNTY_ID_RE.test(c.id));
  return seeded.length ? { main: seeded, rest: extras } : { main: extras, rest: [] };
}

export function criteriaCounts(main: Criterion[]) {
  return {
    met: main.filter((c) => c.met === true).length,
    unmet: main.filter((c) => c.met === false).length,
    pending: main.filter((c) => c.met == null).length,
    total: main.length,
  };
}
