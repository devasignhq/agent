// Offline tests for the GitHub-Actions test-gating helpers. No network/db:
//   node --import tsx/esm --test src/review/tests-ci.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRun,
  combineWithTests,
  extractFailedJobs,
  pickWorkflowRun,
  runMatchesWorkflow,
  testFailureFinding,
  type GhWorkflowJob,
  type GhWorkflowRun,
} from "./tests-ci.js";

const run = (over: Partial<GhWorkflowRun>): GhWorkflowRun => ({
  id: 1,
  head_sha: "abc",
  status: "completed",
  conclusion: "success",
  ...over,
});

test("runMatchesWorkflow matches by display name or filename, case-insensitively", () => {
  const r = run({ name: "CI", path: ".github/workflows/ci.yml" });
  assert.equal(runMatchesWorkflow(r, "ci"), true); // by name
  assert.equal(runMatchesWorkflow(r, "ci.yml"), true); // by filename
  assert.equal(runMatchesWorkflow(r, "CI.YML"), true);
  assert.equal(runMatchesWorkflow(r, "lint"), false);
  assert.equal(runMatchesWorkflow(r, ""), true); // empty filter = any
});

test("pickWorkflowRun returns the newest matching run, or null", () => {
  const runs = [
    run({ id: 10, name: "CI" }),
    run({ id: 30, name: "CI" }),
    run({ id: 20, name: "Lint" }),
  ];
  assert.equal(pickWorkflowRun(runs, "CI")?.id, 30);
  assert.equal(pickWorkflowRun(runs, "Lint")?.id, 20);
  assert.equal(pickWorkflowRun(runs, "Deploy"), null);
  // empty filter picks newest overall
  assert.equal(pickWorkflowRun(runs, "")?.id, 30);
});

test("classifyRun: not-completed → pending", () => {
  assert.equal(classifyRun(run({ status: "queued", conclusion: null })), "pending");
  assert.equal(classifyRun(run({ status: "in_progress", conclusion: null })), "pending");
});

test("classifyRun: only failure/timeout block; success passes; rest are non-blocking skipped", () => {
  assert.equal(classifyRun(run({ conclusion: "success" })), "passed");
  assert.equal(classifyRun(run({ conclusion: "failure" })), "failed");
  assert.equal(classifyRun(run({ conclusion: "timed_out" })), "failed");
  for (const c of ["cancelled", "neutral", "skipped", "action_required", "stale", null]) {
    assert.equal(classifyRun(run({ conclusion: c })), "skipped", `conclusion=${c}`);
  }
});

test("extractFailedJobs keeps only failed/timed-out jobs with their urls", () => {
  const jobs: GhWorkflowJob[] = [
    { name: "unit", status: "completed", conclusion: "success", html_url: "u1" },
    { name: "integration", status: "completed", conclusion: "failure", html_url: "u2" },
    { name: "flaky", status: "completed", conclusion: "timed_out", html_url: "u3" },
    { name: "lint", status: "completed", conclusion: "skipped", html_url: "u4" },
  ];
  assert.deepEqual(extractFailedJobs(jobs), [
    { name: "integration", url: "u2" },
    { name: "flaky", url: "u3" },
  ]);
});

test("testFailureFinding is a blocker that names the failing jobs and carries a fix prompt", () => {
  const f = testFailureFinding({
    workflowName: "CI",
    htmlUrl: "https://gh/run/1",
    failedJobs: [{ name: "unit", url: "x" }],
  });
  assert.equal(f.severity, "blocker");
  assert.match(f.concern, /unit/);
  assert.match(f.concern, /https:\/\/gh\/run\/1/);
  assert.ok(f.fixPrompt && f.fixPrompt.length > 0);
});

test("combineWithTests: the full gating matrix", () => {
  // pending always holds, preserving the pre-test outcome for later
  assert.deepEqual(combineWithTests(true, "pending"), { effectivePassed: true, pending: true });
  assert.deepEqual(combineWithTests(false, "pending"), { effectivePassed: false, pending: true });
  // a failed run forces a fail regardless of pre-test
  assert.deepEqual(combineWithTests(true, "failed"), { effectivePassed: false, pending: false });
  // passed/skipped/errored defer to the pre-test outcome (non-blocking)
  assert.deepEqual(combineWithTests(true, "passed"), { effectivePassed: true, pending: false });
  assert.deepEqual(combineWithTests(false, "passed"), { effectivePassed: false, pending: false });
  assert.deepEqual(combineWithTests(true, "skipped"), { effectivePassed: true, pending: false });
  assert.deepEqual(combineWithTests(true, "errored"), { effectivePassed: true, pending: false });
});
