// Offline: what the runner is handed must carry the plan's uncovered criteria
// and the repo's fail-on default, or CI cannot say why nothing ran.
//   DATABASE_URL= node --import tsx/esm --test src/verify/runs-plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerPlanFor } from "./runs.js";
import type { Repository, VerifyPlan, VerifyRun } from "../types.js";

const run = { reviewId: "no-such-review", criteriaRevision: 1 } as VerifyRun;
const plan = {
  id: "p1",
  criteriaRevision: 1,
  tests: [],
  commands: [],
  unverifiable: [{ criterionId: "1", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=r" }],
} as unknown as VerifyPlan;

test("runnerPlanFor carries unverifiable reasons with their fix links and defaults fail-on to never", () => {
  const out = runnerPlanFor(run, plan, {} as Repository);
  assert.deepEqual(out.unverifiable, plan.unverifiable);
  assert.equal(out.failOn, "never");
});

test("runnerPlanFor passes the repo's stored fail-on setting through, including unverifiable", () => {
  const strict = runnerPlanFor(run, plan, { workflow: { verify: { e2e: "auto", failOn: "unverifiable" } } } as unknown as Repository);
  assert.equal(strict.failOn, "unverifiable");
  const legacy = runnerPlanFor(run, plan, { workflow: { verify: { failOn: "bogus" } } } as unknown as Repository);
  assert.equal(legacy.failOn, "never");
});

test("runnerPlanFor hands the runner the verify block the plan was made with, and none when it had none", () => {
  const verifyConfig = { start: "npm run dev -- --port 5173", url: "http://localhost:5173", ready: "/" };
  const out = runnerPlanFor(run, { ...plan, verifyConfig, verifyConfigFrom: "base" } as VerifyPlan, {} as Repository);
  assert.deepEqual(out.verifyConfig, verifyConfig);
  assert.equal("verifyConfig" in runnerPlanFor(run, plan, {} as Repository), false);
});
