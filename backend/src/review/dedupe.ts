// Merge duplicated prReviews rows left behind by the pre-idempotency webhook
// handler (opened/reopened/ready_for_review used to insert without checking,
// and the dashboard sync could race the webhook). One row per (repoId,
// prNumber) is the invariant the queue UI, the synchronize webhook path, and
// chargeForNewPRReview all assume — duplicates each ran their own pipeline
// and posted their own GitHub comments.
//
// Runs once at boot, after initDb loads the snapshot. The most recently
// updated row survives; pointers the survivor is missing (taskId, the GitHub
// progress-comment id, the approval id) are inherited from the freshest dupe
// that has them, and reviewLogs/notifications are reassigned so history and
// notification links keep working after the merge.

import { db } from "../db.js";
import type { PRReview } from "../types.js";

export function dedupePRReviews(): number {
  const byPR = new Map<string, PRReview[]>();
  for (const r of db.table("prReviews")) {
    const key = `${r.repoId}#${r.prNumber}`;
    const rows = byPR.get(key);
    if (rows) rows.push(r);
    else byPR.set(key, [r]);
  }

  let removed = 0;
  for (const rows of byPR.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
    const survivor = sorted[0];
    const losers = sorted.slice(1);

    const patch: Partial<PRReview> = {};
    for (const loser of losers) {
      if (survivor.taskId == null && patch.taskId === undefined && loser.taskId != null) {
        patch.taskId = loser.taskId;
      }
      if (
        survivor.progressCommentId == null &&
        patch.progressCommentId === undefined &&
        loser.progressCommentId != null
      ) {
        patch.progressCommentId = loser.progressCommentId;
        patch.progressCommentSha = loser.progressCommentSha;
      }
      if (
        survivor.approveReviewId == null &&
        patch.approveReviewId === undefined &&
        loser.approveReviewId != null
      ) {
        patch.approveReviewId = loser.approveReviewId;
      }
    }
    if (Object.keys(patch).length > 0) {
      db.update("prReviews", (r) => r.id === survivor.id, patch);
    }

    const loserIds = new Set(losers.map((l) => l.id));
    const orphanLogs = db.filter("reviewLogs", (l) => loserIds.has(l.reviewId));
    for (const l of orphanLogs) {
      db.update("reviewLogs", (x) => x.id === l.id, { reviewId: survivor.id });
    }
    const orphanNotifs = db.filter(
      "notifications",
      (n) => n.reviewId != null && loserIds.has(n.reviewId)
    );
    for (const n of orphanNotifs) {
      db.update("notifications", (x) => x.id === n.id, {
        reviewId: survivor.id,
        // Only rewrite the default review link; leave custom links alone.
        ...(n.link === `/reviews/${n.reviewId}` ? { link: `/reviews/${survivor.id}` } : {}),
      });
    }

    db.remove("prReviews", (r) => loserIds.has(r.id));
    removed += losers.length;
    console.log(
      `[dedupe] merged ${losers.length} duplicate review row${losers.length === 1 ? "" : "s"} ` +
        `for repo ${survivor.repoId} PR #${survivor.prNumber} into ${survivor.id}`
    );
  }
  return removed;
}
