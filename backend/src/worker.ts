// Subscribe to the in-memory queue and run review + index jobs.
import { onJob, type Job } from "./queue.js";
import { flushPending } from "./db.js";
import { runLinearIngestJob, runMaintainerFeedbackJob, runReviewJob } from "./review/pipeline.js";
import { buildRepoIndex } from "./review/indexer.js";
import { runGuidanceIngestJob } from "./review/guidance.js";
import { runBountyCriteriaJob } from "./bounties/criteria-job.js";
import { runSecurityAudit } from "./security/audit.js";
import { runCrossRepoTopologyJob } from "./review/cross-repo/job.js";
import { enqueueVerifyFeedbackIfEligible } from "./verify/feedback.js";
import {
  runVerifyFeedbackJob,
  runVerifyJudgeJob,
  runVerifyOnboardJob,
  runVerifyPlanJob,
} from "./verify/jobs.js";

// Run one job to completion. A job mutates the store (a finished review writes
// its prReviews/reviewLogs rows and charges the monthly count) but there is no
// HTTP response here to hang the durability barrier on — so the caller flushes
// after us. Kept separate so that flush is unconditional across every job type.
async function runJob(job: Job): Promise<void> {
  switch (job.type) {
    case "review":
      console.log(`[worker] review ${job.payload.reviewId}`);
      await runReviewJob(job.payload.reviewId);
      return;
    case "maintainer_feedback":
      console.log(`[worker] maintainer_feedback ${job.payload.reviewId}`);
      try {
        await runMaintainerFeedbackJob(job.payload.reviewId, job.payload.comment);
      } finally {
        // The verify loop reads the criteria the legacy job may have just changed.
        enqueueVerifyFeedbackIfEligible(job.payload.reviewId, job.payload.comment);
      }
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
    case "bounty_criteria":
      console.log(`[worker] bounty_criteria ${job.payload.bountyId}`);
      await runBountyCriteriaJob(job.payload.bountyId);
      return;
    case "security_audit":
      console.log(
        `[worker] security_audit ${job.payload.repoId} (${job.payload.trigger}${job.payload.full ? ", full" : ""})`
      );
      await runSecurityAudit(job.payload);
      return;
    case "cross_repo_topology":
      console.log(
        `[worker] cross_repo_topology ${job.payload.installationId} (${job.payload.trigger})`
      );
      await runCrossRepoTopologyJob(job.payload);
      return;
    case "verify_plan":
      console.log(`[worker] verify_plan ${job.payload.runId}`);
      await runVerifyPlanJob(job.payload.runId);
      return;
    case "verify_judge":
      console.log(`[worker] verify_judge ${job.payload.runId}`);
      await runVerifyJudgeJob(job.payload.runId);
      return;
    case "verify_feedback":
      console.log(`[worker] verify_feedback ${job.payload.reviewId}#${job.payload.comment.commentId ?? "?"}`);
      await runVerifyFeedbackJob(job.payload.reviewId, job.payload.comment);
      return;
    case "verify_onboard":
      console.log(`[worker] verify_onboard ${job.payload.repoId} (${job.payload.trigger})`);
      await runVerifyOnboardJob(job.payload.repoId);
      return;
  }
}

export function startWorker() {
  onJob(async (job) => {
    try {
      await runJob(job);
    } finally {
      // Durability barrier: a completed job's writes must reach Postgres before
      // the queue moves on, so a redeploy/kill right after a review finishes
      // can't lose the review or its monthly-count charge (the recurring
      // "PRs disappeared on deploy" bug). flushPending() is bounded + no-op when
      // nothing is staged (and in ephemeral mode), so this is cheap.
      await flushPending();
    }
  });
  console.log("[worker] review + index worker subscribed");
}
