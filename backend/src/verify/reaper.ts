// Settle verify runs whose in-process job died (redeploy/crash — queue.ts holds
// jobs in memory) or whose runner never came back. Same stance as
// security/stale-scans.ts: a stranded "planning" row would wedge the PR forever.
import { db } from "../db.js";
import { config } from "../config.js";
import { enqueueVerifyJudge } from "../queue.js";
import type { VerifyRun } from "../types.js";

// Planning and judgment are single LLM jobs; 15 quiet minutes is dead, not slow.
export const JOB_STALE_MS = 15 * 60_000;
// A judge whose results are already stored is re-queued at JOB_STALE_MS instead
// of being declared lost; only this much total silence gives up on it.
export const JUDGE_ABANDON_MS = 6 * 60 * 60_000;

export const RUN_LOST = "the server restarted before this run finished";
export const RUN_TIMED_OUT = "the runner did not report results in time";

export type StaleVerdict = { id: string; status: "lost" | "timed_out"; error: string };
export type RequeueJudge = { id: string; requeue: "judge" };
export type StaleAction = StaleVerdict | RequeueJudge;

const isRequeue = (a: StaleAction): a is RequeueJudge => "requeue" in a;

export function selectStaleVerifyRuns(
  runs: VerifyRun[],
  now: number,
  opts: { boot: boolean; runTimeoutMs?: number }
): StaleAction[] {
  const runTimeoutMs = opts.runTimeoutMs ?? config.verify.runTimeoutMs;
  const out: StaleAction[] = [];
  for (const r of runs) {
    const quiet = now - (r.updatedAt || r.createdAt || 0);
    if (r.status === "judging" && r.resultsId) {
      // The runner's results are stored: the judge job is either gone (boot) or
      // still waiting behind the serial queue. Re-run it rather than throw the
      // evidence away, and only give up after far longer silence.
      if (quiet > JUDGE_ABANDON_MS) out.push({ id: r.id, status: "lost", error: RUN_LOST });
      else if (opts.boot || quiet > JOB_STALE_MS) out.push({ id: r.id, requeue: "judge" });
    } else if (r.status === "planning" || r.status === "judging") {
      // The job for these lives only in this process: at boot it is gone by definition.
      if (opts.boot || quiet > JOB_STALE_MS) out.push({ id: r.id, status: "lost", error: RUN_LOST });
    } else if (r.status === "awaiting_runner" || r.status === "running") {
      // The runner is external (CI) and survives our restarts — only silence counts.
      if (quiet > runTimeoutMs) out.push({ id: r.id, status: "timed_out", error: RUN_TIMED_OUT });
    }
  }
  return out;
}

export function sweepStaleVerifyRuns(
  opts: { boot: boolean },
  onSettled?: (run: VerifyRun) => void,
  onRequeueJudge: (runId: string) => void = enqueueVerifyJudge
): number {
  const now = Date.now();
  const stale = selectStaleVerifyRuns(db.filter("verifyRuns", () => true), now, opts);
  for (const s of stale) {
    if (isRequeue(s)) {
      // Bump updatedAt so the next sweep does not re-queue it straight away.
      db.update("verifyRuns", (r) => r.id === s.id, { updatedAt: now });
      onRequeueJudge(s.id);
      continue;
    }
    const run = db.update("verifyRuns", (r) => r.id === s.id, { status: s.status, error: s.error, updatedAt: now });
    if (run && onSettled) {
      try {
        onSettled(run);
      } catch (err) {
        console.error("[verify] reaper onSettled failed", err);
      }
    }
  }
  if (stale.length > 0) console.log(`[verify] reaped ${stale.length} unfinished run(s)`);
  return stale.length;
}

export function startVerifyReaper(onSettled?: (run: VerifyRun) => void): void {
  sweepStaleVerifyRuns({ boot: true }, onSettled);
  setInterval(() => sweepStaleVerifyRuns({ boot: false }, onSettled), 5 * 60_000);
}
