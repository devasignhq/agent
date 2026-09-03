// Verify-branch background jobs. Phase 1 wires the queue and settles runs
// honestly; the planner/judge bodies land in phase 2.
import { db } from "../db.js";
import { updateRun } from "./runs.js";

const NOT_IMPLEMENTED = "verifier stage not available on this server yet";

export async function runVerifyPlanJob(runId: string): Promise<void> {
  const run = db.find("verifyRuns", (r) => r.id === runId);
  if (!run || run.status !== "planning") return;
  updateRun(run.id, { status: "failed", error: `planner: ${NOT_IMPLEMENTED}` });
}

export async function runVerifyJudgeJob(runId: string): Promise<void> {
  const run = db.find("verifyRuns", (r) => r.id === runId);
  if (!run || run.status !== "judging") return;
  updateRun(run.id, { status: "failed", error: `judgment: ${NOT_IMPLEMENTED}` });
}

export async function runVerifyFeedbackJob(_reviewId: string, _commentId: number): Promise<void> {
  console.warn(`[verify] feedback: ${NOT_IMPLEMENTED}`);
}

export async function runVerifyOnboardJob(_repoId: string): Promise<void> {
  console.warn(`[verify] onboarding: ${NOT_IMPLEMENTED}`);
}
