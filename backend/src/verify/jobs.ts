// Verify-branch background jobs (queue.ts bucket "verify").
import { runVerifyJudge } from "./judge.js";
import { runVerifyPlan } from "./plan.js";

export async function runVerifyPlanJob(runId: string): Promise<void> {
  await runVerifyPlan(runId);
}

export async function runVerifyJudgeJob(runId: string): Promise<void> {
  await runVerifyJudge(runId);
}

// Phase 4b / 5.
export async function runVerifyFeedbackJob(reviewId: string, commentId: number): Promise<void> {
  console.warn(`[verify] feedback for ${reviewId}#${commentId}: not available on this server yet`);
}

export async function runVerifyOnboardJob(repoId: string): Promise<void> {
  console.warn(`[verify] onboarding for ${repoId}: not available on this server yet`);
}
