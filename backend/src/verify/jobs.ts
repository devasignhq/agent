// Verify-branch background jobs (queue.ts bucket "verify").
import { runVerifyJudge } from "./judge.js";
import { runVerifyPlan } from "./plan.js";
import { runVerifyFeedback } from "./feedback.js";
import { runVerifyOnboard } from "./onboarding/job.js";
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

export async function runVerifyOnboardJob(repoId: string, opts: { trigger: "install" | "manual" | "doctor"; mode?: "separate" | "extend"; workflow?: string }): Promise<void> {
  await runVerifyOnboard(repoId, opts);
}
