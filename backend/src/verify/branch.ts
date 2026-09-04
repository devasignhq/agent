// The verify branch of a review: forked right after the criteria are persisted,
// planned in parallel with the review stages (a Promise, not a queue job — the
// queue is serial), joined with a bounded wait before the verdict.
import { db } from "../db.js";
import { config } from "../config.js";
import type { Criterion, Installation, PRReview, RepoWorkflow, Repository, ReviewLogEntry, VerifyRun } from "../types.js";
import { runVerifyPlan } from "./plan.js";
import { buildVerificationView, type VerificationView } from "./report.js";
import { createVerifyRun, snapshotCriteriaRevision, TERMINAL_STATUSES, updateRun } from "./runs.js";

export const VERIFY_STAGE_DISABLED = "Verification disabled by workflow";
export const VERIFY_NO_CRITERIA = "No verifiable criteria — verification skipped";
export const VERIFY_FORK_PR = "PR from a fork — verification skipped (GitHub issues no OIDC token to fork workflows)";
export const VERIFY_FORKED = "Verification branch forked";

type Log = (action: string, extra?: Partial<ReviewLogEntry>) => void;

export type VerifyBranch = { run: VerifyRun | null; settled: Promise<VerifyRun | null> };

export function isVerifiableCriterion(c: Criterion): boolean {
  return (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy;
}

export function startVerifyBranch(args: {
  review: PRReview;
  repo: Repository;
  install: Installation | null;
  wf: RepoWorkflow;
  criteria: Criterion[];
  criteriaFinishedAt: number;
  headFromFork?: boolean;
  log: Log;
}): VerifyBranch {
  const { review, repo, install, wf, criteria, log } = args;
  const revision = snapshotCriteriaRevision(review.id, criteria, null);
  const verifiable = criteria.filter(isVerifiableCriterion);
  const base = { review, repo, install, criteriaRevision: revision.revision, triggeredBy: { kind: "pr_event" as const } };
  if (!wf.stages.verify) {
    const run = createVerifyRun({ ...base, status: "skipped", skipReason: "verify_disabled" });
    log(VERIFY_STAGE_DISABLED, { meta: { runId: run.id } });
    return { run, settled: Promise.resolve(run) };
  }
  if (!verifiable.length) {
    const run = createVerifyRun({ ...base, status: "skipped", skipReason: "no_criteria" });
    log(VERIFY_NO_CRITERIA, { meta: { runId: run.id } });
    return { run, settled: Promise.resolve(run) };
  }
  // A `pull_request` workflow on a fork's PR gets a read-only token and no OIDC
  // token at all, so no runner can ever claim this run — planning one would only
  // produce a 60-minute timeout on every push.
  if (args.headFromFork) {
    const run = createVerifyRun({ ...base, status: "skipped", skipReason: "fork_pr" });
    log(VERIFY_FORK_PR, { meta: { runId: run.id } });
    return { run, settled: Promise.resolve(run) };
  }
  const run = createVerifyRun({ ...base, status: "planning" });
  updateRun(run.id, { timings: { ...run.timings, criteriaFinishedAt: args.criteriaFinishedAt } });
  log(VERIFY_FORKED, {
    detail: `${verifiable.length} criteria to verify; planning tests in parallel with the review`,
    meta: { runId: run.id, criteria: verifiable.length, revision: revision.revision },
  });
  const settled = runVerifyPlan(run.id).catch((err) => {
    console.error(`[verify] branch failed for run ${run.id}:`, err);
    return updateRun(run.id, { status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  });
  return { run, settled };
}

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

export async function joinVerifyBranch(
  branch: VerifyBranch,
  args: { review: PRReview; repo: Repository; criteria: Criterion[]; log: Log; timeoutMs?: number }
): Promise<VerificationView> {
  const timeoutMs = args.timeoutMs ?? config.verify.joinTimeoutMs;
  let run = branch.run;
  if (run && run.status === "planning") {
    await Promise.race([branch.settled, sleep(timeoutMs)]);
  }
  const finishedAt = Date.now();
  run = run ? db.find("verifyRuns", (r) => r.id === run!.id) ?? run : null;
  if (run) {
    run = updateRun(run.id, { timings: { ...run.timings, reviewBranch: { startedAt: run.timings.forkedAt, finishedAt } } }) ?? run;
  }
  const view = buildVerificationView({ run, review: args.review, repo: args.repo, criteria: args.criteria });
  if (run && run.status !== "skipped") {
    const settled = TERMINAL_STATUSES.has(run.status) || run.status === "awaiting_runner";
    args.log(settled ? `Verification joined: ${view.state}` : "Verification still planning at join — reporting pending", {
      detail: view.state === "setup_pending" ? view.nudge : undefined,
      meta: { runId: run.id, state: view.state, overlapMs: finishedAt - run.timings.forkedAt, status: run.status },
    });
  }
  return view;
}
