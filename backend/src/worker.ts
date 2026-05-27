// Subscribe to the in-memory queue and run review + index jobs.
import { onJob } from "./queue.js";
import { runMaintainerFeedbackJob, runReviewJob } from "./review/pipeline.js";
import { buildRepoIndex } from "./review/indexer.js";

export function startWorker() {
  onJob(async (job) => {
    switch (job.type) {
      case "review":
        console.log(`[worker] review ${job.payload.reviewId}`);
        await runReviewJob(job.payload.reviewId);
        return;
      case "maintainer_feedback":
        console.log(`[worker] maintainer_feedback ${job.payload.reviewId}`);
        await runMaintainerFeedbackJob(job.payload.reviewId, job.payload.comment);
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
