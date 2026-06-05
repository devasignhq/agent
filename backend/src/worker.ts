// Subscribe to the in-memory queue and run review + index jobs.
import { onJob } from "./queue.js";
import { runLinearIngestJob, runMaintainerFeedbackJob, runReviewJob } from "./review/pipeline.js";
import { buildRepoIndex } from "./review/indexer.js";
import { reviewOwnerPendingDeletion } from "./account.js";

export function startWorker() {
  onJob(async (job) => {
    switch (job.type) {
      case "review":
        // Skip while the install owner is pending deletion — no analysis, no
        // GitHub comments. Reviews resume automatically once they restore.
        if (reviewOwnerPendingDeletion(job.payload.reviewId)) {
          console.log(`[worker] skip review ${job.payload.reviewId} — owner pending deletion`);
          return;
        }
        console.log(`[worker] review ${job.payload.reviewId}`);
        await runReviewJob(job.payload.reviewId);
        return;
      case "maintainer_feedback":
        if (reviewOwnerPendingDeletion(job.payload.reviewId)) {
          console.log(`[worker] skip maintainer_feedback ${job.payload.reviewId} — owner pending deletion`);
          return;
        }
        console.log(`[worker] maintainer_feedback ${job.payload.reviewId}`);
        await runMaintainerFeedbackJob(job.payload.reviewId, job.payload.comment);
        return;
      case "linear_ingest":
        console.log(`[worker] linear_ingest ${job.payload.issueId}`);
        await runLinearIngestJob(job.payload.integrationId, job.payload.issueId);
        return;
      case "index":
        console.log(
          `[worker] index ${job.payload.repoId} (${job.payload.full ? "full" : "incremental"})`
        );
        await buildRepoIndex(job.payload.repoId, {
          full: job.payload.full,
          changedPaths: job.payload.changedPaths,
        });
        return;
    }
  });
  console.log("[worker] review + index worker subscribed");
}
