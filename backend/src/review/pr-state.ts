// Backfill for PRReview.prState on rows that predate the field (or whose
// `pull_request.closed` webhook never arrived). The review pipeline already
// self-heals prState on every run; this covers rows nobody re-reviews, so the
// composer still locks when a user opens an old merged PR.
import { db } from "../db.js";
import { gh } from "../github/app.js";
import { notifyUser } from "../notifications-stream.js";
import type { PRReview } from "../types.js";
import { prStateOf } from "./decisions.js";

// One in-flight resolve per review. getReviewHandler is polled every 2.5s while
// a review is live, so without this a single open PR would storm the GitHub API.
const inFlight = new Set<string>();

export function needsPrStateBackfill(review: Pick<PRReview, "prState">): boolean {
  return review.prState === undefined;
}

// Fire-and-forget: never blocks the response, never throws to the caller.
export async function reconcilePrState(review: PRReview): Promise<void> {
  if (!needsPrStateBackfill(review) || inFlight.has(review.id)) return;
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  if (!repo) return;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install?.installationId) return;
  inFlight.add(review.id);
  try {
    const pr = await gh<{ state?: string; merged?: boolean; merged_at?: string | null }>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/pulls/${review.prNumber}`
    );
    const prState = prStateOf(pr || {});
    db.update("prReviews", (r) => r.id === review.id, { prState });
    if (prState !== "open" && install.userId) notifyUser(install.userId);
  } catch (err) {
    console.warn(`[pr-state] reconcile failed for review ${review.id}:`, err);
  } finally {
    inFlight.delete(review.id);
  }
}
