// Subscribe to the in-memory queue and run review jobs.
import { onJob } from "./queue.js";
import { runMaintainerFeedbackJob, runReviewJob } from "./review/pipeline.js";

export function startWorker() {
  onJob(async (job) => {
    switch (job.type) {
      case "review":
        await runReviewJob(job.payload.reviewId);
        return;
      case "maintainer_feedback":
        await runMaintainerFeedbackJob(job.payload.reviewId, job.payload.comment);
        return;
    }
  });
  console.log("[worker] review worker subscribed");
}
