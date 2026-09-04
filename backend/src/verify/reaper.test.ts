// Offline: which verify runs the reaper settles, and how.
//   node --import tsx/esm --test src/verify/reaper.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_STALE_MS, JUDGE_ABANDON_MS, selectStaleVerifyRuns, type StaleAction } from "./reaper.js";
import type { VerifyRun } from "../types.js";

const NOW = 1_700_000_000_000;
function run(status: VerifyRun["status"], updatedAgoMs: number, resultsId?: string): VerifyRun {
  return { id: `${status}-${updatedAgoMs}`, status, resultsId, updatedAt: NOW - updatedAgoMs, createdAt: NOW - updatedAgoMs } as VerifyRun;
}

const label = (a: StaleAction) => ("requeue" in a ? `requeue:${a.requeue}` : a.status);

test("at boot every planning/judging run is lost; runner-side runs only time out on silence", () => {
  const runs = [
    run("planning", 1_000),
    run("judging", 1_000),
    run("awaiting_runner", 1_000),
    run("running", 2 * 60 * 60_000),
    run("completed", 0),
    run("setup_pending", 10 * 60 * 60_000),
  ];
  const out = selectStaleVerifyRuns(runs, NOW, { boot: true, runTimeoutMs: 60 * 60_000 });
  assert.deepEqual(
    out.map((s) => [s.id, label(s)]),
    [
      ["planning-1000", "lost"],
      ["judging-1000", "lost"],
      ["running-7200000", "timed_out"],
    ]
  );
});

test("while running, a job is only lost after JOB_STALE_MS of silence", () => {
  const runs = [run("planning", JOB_STALE_MS - 1), run("judging", JOB_STALE_MS + 1), run("awaiting_runner", 59 * 60_000)];
  const out = selectStaleVerifyRuns(runs, NOW, { boot: false, runTimeoutMs: 60 * 60_000 });
  assert.deepEqual(out.map((s) => s.id), [`judging-${JOB_STALE_MS + 1}`]);
});

// A judge job can sit behind the serial queue for longer than JOB_STALE_MS. The
// results are already stored, so losing the run throws away real evidence:
// re-queue instead, and only give up after JUDGE_ABANDON_MS.
test("a judging run whose results are stored is re-queued, not lost", () => {
  const runs = [
    run("judging", JOB_STALE_MS + 1, "res-1"),
    run("judging", JOB_STALE_MS - 1, "res-2"),
    run("judging", JUDGE_ABANDON_MS + 1, "res-3"),
    run("judging", JOB_STALE_MS + 1),
  ];
  assert.deepEqual(
    selectStaleVerifyRuns(runs, NOW, { boot: false, runTimeoutMs: 60 * 60_000 }).map((s) => [s.id, label(s)]),
    [
      [`judging-${JOB_STALE_MS + 1}`, "requeue:judge"],
      [`judging-${JUDGE_ABANDON_MS + 1}`, "lost"],
      [`judging-${JOB_STALE_MS + 1}`, "lost"],
    ]
  );
  // At boot the in-process job is certainly gone, so re-run it immediately.
  assert.deepEqual(
    selectStaleVerifyRuns([run("judging", 1_000, "res-1")], NOW, { boot: true, runTimeoutMs: 60 * 60_000 }).map(label),
    ["requeue:judge"]
  );
});
