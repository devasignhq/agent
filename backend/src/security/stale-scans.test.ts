// Unit test for the stranded-scan reaper. Pure selector only — no db, no
// network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= \
//     node --import tsx/esm --test src/security/stale-scans.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStaleScans, STALE_MS } from "./stale-scans.js";
import type { SecurityScanRun, SecurityScanStatus } from "../types.js";

const NOW = 1_770_000_000_000;

function run(
  id: string,
  status: SecurityScanStatus,
  startedAt: number,
  log: { at: number; line: string }[] = []
): SecurityScanRun {
  return {
    id,
    repoId: `repo-${id}`,
    trigger: "manual",
    full: true,
    status,
    startedAt,
    filesScanned: 0,
    cacheHits: 0,
    introduced: 0,
    resolved: 0,
    stillOpen: 0,
    log,
  };
}

test("boot fails every in-flight run — the queue that held its job is gone", () => {
  const runs = [
    run("a", "queued", NOW - 1000),
    run("b", "running", NOW - 1000, [{ at: NOW - 500, line: "scanning…" }]),
    run("c", "completed", NOW - 1000),
    run("d", "errored", NOW - 1000),
  ];
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: true }), ["a", "b"]);
});

test("mid-life, a run that is still writing log lines is left alone", () => {
  const runs = [
    // Started long ago but logged a second ago — alive, just slow.
    run("alive", "running", NOW - 4 * STALE_MS, [{ at: NOW - 1000, line: "scanning…" }]),
    // Last log line is older than the window — the worker is gone.
    run("silent", "running", NOW - 4 * STALE_MS, [{ at: NOW - STALE_MS - 1, line: "scanning…" }]),
    // Never logged; falls back to startedAt.
    run("never-started", "queued", NOW - STALE_MS - 1),
    run("fresh", "queued", NOW - 1000),
  ];
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: false }), ["silent", "never-started"]);
});

test("a settled run is never re-failed, however old", () => {
  const runs = [
    run("done", "completed", NOW - 100 * STALE_MS),
    run("failed", "errored", NOW - 100 * STALE_MS),
  ];
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: false }), []);
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: true }), []);
});

test("a row with no log array falls back to startedAt instead of throwing", () => {
  // `log` is non-optional on the type, but a legacy or partially-written row
  // can reach the reaper without one — and throwing here would stop every run
  // behind it from being settled.
  const missing = { ...run("no-log", "running", NOW - STALE_MS - 1), log: undefined };
  const fresh = { ...run("no-log-fresh", "running", NOW - 1000), log: undefined };
  const runs = [missing, fresh] as unknown as SecurityScanRun[];
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: false }), ["no-log"]);
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: true }), ["no-log", "no-log-fresh"]);
});

test("exactly at the threshold is not yet stale", () => {
  const runs = [run("edge", "running", NOW - STALE_MS)];
  assert.deepEqual(selectStaleScans(runs, NOW, { boot: false }), []);
});
