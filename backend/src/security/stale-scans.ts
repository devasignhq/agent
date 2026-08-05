// Reaper for security scan runs that will never finish.
//
// A `securityScans` row only leaves "queued"/"running" when the audit worker
// patches it (audit.ts). The job that would do that lives in an in-memory queue
// (queue.ts) inside this process, so anything that kills the process — a
// redeploy, a crash, an OOM — drops the job and strands the row forever.
//
// A stranded row is not cosmetic. It makes `POST /repositories/:id/security/scan`
// answer 409 for that repo for good, it makes the nightly sweep skip the repo
// (server.ts), and on the Security page it shows the repo as permanently
// scanning. Settling the row is what lets the user scan again.
import { db } from "../db.js";
import type { SecurityScanRun } from "../types.js";

// A healthy run is bounded by MAX_FILES_PER_RUN (500) at concurrency 4, so half
// an hour without a single row write is well past "slow" and into "dead".
export const STALE_MS = 30 * 60 * 1000;

export const INTERRUPTED = "interrupted — the run did not finish";

function inFlight(r: SecurityScanRun): boolean {
  return r.status === "queued" || r.status === "running";
}

/**
 * Ids of the runs that should be failed.
 *
 * At boot every in-flight row is orphaned by definition: the queue that held
 * its job did not survive the restart, so no worker will ever pick it up again.
 * While running, we can only go on silence — the newest log line (or the start
 * time, for a run that never logged) older than STALE_MS.
 */
export function selectStaleScans(
  runs: SecurityScanRun[],
  now: number,
  opts: { boot: boolean }
): string[] {
  return runs
    .filter((r) => {
      if (!inFlight(r)) return false;
      if (opts.boot) return true;
      const lastBeat = r.log.length > 0 ? r.log[r.log.length - 1].at : r.startedAt;
      return now - lastBeat > STALE_MS;
    })
    .map((r) => r.id);
}

/**
 * Apply `selectStaleScans` to the live collection. Each write fans out over SSE
 * via security/live.ts, so an open Security page settles without a reload.
 */
export function sweepStaleSecurityScans(opts: { boot: boolean }): number {
  const now = Date.now();
  const stale = selectStaleScans(db.filter("securityScans", () => true), now, opts);
  for (const id of stale) {
    db.update("securityScans", (r) => r.id === id, {
      status: "errored",
      error: INTERRUPTED,
      finishedAt: now,
    });
  }
  if (stale.length > 0) {
    console.log(`[security] reaped ${stale.length} unfinished scan run(s)`);
  }
  return stale.length;
}
