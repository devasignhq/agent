// Verify-branch background jobs (queue.ts bucket "verify").
import { runVerifyJudge } from "./judge.js";
import { runVerifyPlan } from "./plan.js";
import { runVerifyFeedback } from "./feedback.js";
import { runVerifyOnboard, type OnboardOptions } from "./onboarding/job.js";
import type { MaintainerComment, VerifyOnboardJob } from "../queue.js";

export async function runVerifyPlanJob(runId: string): Promise<void> {
  await runVerifyPlan(runId);
}

export async function runVerifyJudgeJob(runId: string): Promise<void> {
  await runVerifyJudge(runId);
}

export async function runVerifyFeedbackJob(reviewId: string, comment: MaintainerComment): Promise<void> {
  await runVerifyFeedback(reviewId, comment);
}

/** The queued payload as onboarding options — every field the queue kept, none dropped. */
export function onboardOptions(payload: VerifyOnboardJob["payload"]): OnboardOptions {
  const { repoId: _repoId, ...opts } = payload;
  return opts;
}

export async function runVerifyOnboardJob(repoId: string, opts: OnboardOptions): Promise<void> {
  await runVerifyOnboard(repoId, opts);
}
