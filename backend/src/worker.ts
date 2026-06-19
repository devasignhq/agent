// Subscribe to the in-memory queue and run review + index jobs.
import { onJob } from "./queue.js";
import { runLinearIngestJob, runMaintainerFeedbackJob, runReviewJob } from "./review/pipeline.js";
import { buildRepoIndex } from "./review/indexer.js";
import { runGuidanceIngestJob } from "./review/guidance.js";

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
      case "guidance_ingest":
        console.log(`[worker] guidance_ingest ${job.payload.repoId}/${job.payload.itemId}`);
        await runGuidanceIngestJob(job.payload);
        return;
    }
  });
  console.log("[worker] review + index worker subscribed");
}
