// Settle verify runs whose in-process job died (redeploy/crash — queue.ts holds
// jobs in memory) or whose runner never came back. Same stance as
// security/stale-scans.ts: a stranded "planning" row would wedge the PR forever.
import { db } from "../db.js";
import { config } from "../config.js";
import type { VerifyRun } from "../types.js";

// Planning and judgment are single LLM jobs; 15 quiet minutes is dead, not slow.
export const JOB_STALE_MS = 15 * 60_000;

export const RUN_LOST = "the server restarted before this run finished";
export const RUN_TIMED_OUT = "the runner did not report results in time";

export type StaleVerdict = { id: string; status: "lost" | "timed_out"; error: string };

export function selectStaleVerifyRuns(
  runs: VerifyRun[],
  now: number,
  opts: { boot: boolean; runTimeoutMs?: number }
): StaleVerdict[] {
  const runTimeoutMs = opts.runTimeoutMs ?? config.verify.runTimeoutMs;
  const out: StaleVerdict[] = [];
  for (const r of runs) {
    const quiet = now - (r.updatedAt || r.createdAt || 0);
    if (r.status === "planning" || r.status === "judging") {
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
  onSettled?: (run: VerifyRun) => void
): number {
  const now = Date.now();
  const stale = selectStaleVerifyRuns(db.filter("verifyRuns", () => true), now, opts);
  for (const s of stale) {
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
