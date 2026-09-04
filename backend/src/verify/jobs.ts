// Verify-branch background jobs (queue.ts bucket "verify").
import { runVerifyJudge } from "./judge.js";
import { runVerifyPlan } from "./plan.js";
import { runVerifyFeedback } from "./feedback.js";
import type { MaintainerComment } from "../queue.js";

export async function runVerifyPlanJob(runId: string): Promise<void> {
  await runVerifyPlan(runId);
}

export async function runVerifyJudgeJob(runId: string): Promise<void> {
  await runVerifyJudge(runId);
}

export async function runVerifyFeedbackJob(reviewId: string, comment: MaintainerComment): Promise<void> {
  await runVerifyFeedback(reviewId, comment);
}

// Phase 5.

export async function runVerifyOnboardJob(repoId: string): Promise<void> {
  console.warn(`[verify] onboarding for ${repoId}: not available on this server yet`);
}
