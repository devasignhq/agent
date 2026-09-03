// Offline: the planner enforces what the model may not decide — existing tests
// must exist, levels obey the ladder policy, e2e:never wins, flaky signatures are
// regenerated at a new strategy or retired.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { buildCommands, enforcePlanPolicy, NO_BOOT_REASON, planPolicy, RETIRED_REASON, runVerifyPlan, type PlannerDeps } from "./plan.js";
import { recordFlakeOutcome, testSignature } from "./flake.js";
import { createVerifyRun, snapshotCriteriaRevision } from "./runs.js";
import type { Criterion } from "../types.js";
import type { PlanTest } from "./contract.js";

const DIFF = ["diff --git a/src/handler.ts b/src/handler.ts", "--- a/src/handler.ts", "+++ b/src/handler.ts", "@@ -1 +1,2 @@", " export function handler() {}", "+export function refunds() { return 1; }"].join("\n");
const BASE_TREE = ["package.json", "package-lock.json", "src/handler.ts", "src/handler.test.ts", "frontend/src/app.tsx"];

function seed(criteria: Criterion[]) {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: "", accountId: 1, accountLogin: "acme", installationId: 9, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "w", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true, indexState: "none" } as any);
  const review = db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 7, prTitle: "Add refunds", headSha: "abc1234", baseSha: "d", status: "reviewing", verdict: null, criteria, taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
  snapshotCriteriaRevision(review.id, criteria, null);
  const run = createVerifyRun({ review, repo, status: "planning", triggeredBy: { kind: "pr_event" } });
  const cleanup = () => {
    db.remove("verifyPlans", (p) => p.runId === run.id);
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("testFlakeHistory", (r) => r.repoId === repo.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
  };
  return { run, repo, review, cleanup };
}

function deps(opts: { tree?: string[]; files?: Record<string, string>; responses: unknown[] }) {
  const prompts: string[] = [];
  const responses = [...opts.responses];
  const d: PlannerDeps = {
    fetchTree: async () => (opts.tree ?? BASE_TREE).map((path) => ({ path, type: "blob", sha: "s", size: 10 })),
    fetchDiff: async () => DIFF,
    readFile: async (_i, _r, path) => opts.files?.[path] ?? null,
    llm: async ({ user }) => {
      prompts.push(user);
      return { text: JSON.stringify(responses.shift() ?? {}), stopReason: "end_turn" };
    },
  };
  return { deps: d, prompts };
}

const gen = (id: string, level: PlanTest["level"], extra: Partial<PlanTest> = {}) => ({
  path: `criterion-${id}.test.ts`, content: `// DevAsign generated test — criterion ${id}\n`, criterionIds: [id], level, levelReason: "r",
  origin: "generated", runner: level === "e2e" ? "playwright" : "node-test", targetFiles: ["src/handler.ts"], ...extra,
});
const crit = (id: string, kind: Criterion["kind"] = "code", implied = false): Criterion => ({ id, text: `Criterion ${id} holds`, met: null, evidence: null, kind, implied });

test("a cited existing test that is not in the tree is rejected; the criterion is re-planned", async () => {
  const s = seed([crit("1"), crit("2")]);
  const { deps: d, prompts } = deps({
    responses: [
      { tests: [{ path: "src/nope.test.ts", content: null, criterionIds: ["1"], level: "unit", levelReason: "x", origin: "existing", runner: "node-test", targetFiles: [] }, gen("2", "unit")] },
      { tests: [gen("1", "unit")] },
    ],
  });
  try {
    const out = await runVerifyPlan(s.run.id, d);
    assert.equal(out?.status, "awaiting_runner");
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.ok(!plan.tests.some((t) => t.path === "src/nope.test.ts"), "hallucinated path must not be planned");
    assert.deepEqual(plan.tests.map((t) => [t.criterionIds[0], t.origin, t.path]).sort(), [["1", "generated", ".devasign/tests/criterion-1.test.ts"], ["2", "generated", ".devasign/tests/criterion-2.test.ts"]]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Re-plan ONLY these criteria/);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify");
    assert.match(String(log?.detail), /src\/nope\.test\.ts \(missing_existing\)/);
    assert.equal(plan.unverifiable.length, 0);
  } finally {
    s.cleanup();
  }
});

test("existing tests that DO exist are cited, not regenerated", async () => {
  const s = seed([crit("1")]);
  const { deps: d } = deps({ responses: [{ tests: [{ path: "src/handler.test.ts", content: null, criterionIds: ["1"], level: "unit", levelReason: "covers it", origin: "existing", runner: "node-test", targetFiles: [] }] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.tests[0].origin, "existing");
    assert.equal(plan.tests[0].path, "src/handler.test.ts");
    assert.equal(plan.tests[0].content, null);
    assert.equal(plan.commands[0].cmd, 'node --test "src/handler.test.ts"');
  } finally {
    s.cleanup();
  }
});

test("API-only diff caps code criteria at integration; a blast-radius ui criterion may escalate to e2e", async () => {
  const s = seed([crit("1"), crit("2", "ui", true)]);
  const { deps: d } = deps({
    tree: [...BASE_TREE, "playwright.config.ts"],
    responses: [{ tests: [gen("1", "e2e"), gen("2", "e2e", { path: "e2e/consumers.spec.ts" })] }, { tests: [gen("1", "unit")] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    const byId = new Map(plan.tests.map((t) => [t.criterionIds[0], t]));
    assert.equal(byId.get("1")?.level, "unit", "the e2e test for the code criterion was rejected and re-planned");
    assert.equal(byId.get("2")?.level, "e2e");
    assert.equal(byId.get("2")?.path, ".devasign/tests/e2e/consumers.spec.ts");
    const pw = plan.commands.find((c) => c.runner === "playwright")!;
    assert.match(pw.cmd, /playwright test --config \.devasign\/playwright\.config\.ts/);
    assert.equal(pw.needsBrowsers, true);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify");
    assert.equal(log?.meta?.apiOnly, true);
    assert.equal(log?.meta?.e2eAllowed, true);
  } finally {
    s.cleanup();
  }
});

test("e2e: never in .devasign.yml overrides the workflow; ui criteria become unverifiable", async () => {
  const s = seed([crit("1", "ui")]);
  const { deps: d } = deps({
    tree: [...BASE_TREE, "playwright.config.ts", ".devasign.yml"],
    files: { ".devasign.yml": "verify:\n  e2e: never\n  start: npm start\n  url: http://localhost:3000\n" },
    responses: [{ tests: [gen("1", "e2e")] }, {}],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.tests.length, 0);
    assert.match(plan.unverifiable[0].reason, /e2e: never/);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.devasignYml?.parsed?.e2e, "never");
  } finally {
    s.cleanup();
  }
});

test("no boot config: a ui criterion that needs e2e is unverifiable with a fix link, never a flaky test", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const { deps: d, prompts } = deps({ responses: [{ tests: [gen("2", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => t.criterionIds[0]), ["2"]);
    assert.equal(plan.unverifiable[0].criterionId, "1");
    assert.equal(plan.unverifiable[0].reason, NO_BOOT_REASON);
    assert.match(String(plan.unverifiable[0].fixUrl), /\/settings\/verify\?repo=/);
    assert.match(prompts[0], /E2E allowed: no \(no app start \/ login configured\)/);
    assert.match(prompts[0], /\[1\]: max level component/);
  } finally {
    s.cleanup();
  }
});

test("flake history: a quarantined signature is regenerated at a new strategy; a retired one is dropped", async () => {
  const s = seed([crit("1"), crit("2")]);
  const sig1 = testSignature("Criterion 1 holds", "unit", ["src/handler.ts"]);
  const sig2 = testSignature("Criterion 2 holds", "unit", ["src/handler.ts"]);
  recordFlakeOutcome({ repoId: s.repo.id, signature: sig1, runId: "old", outcome: "flaky", strategyVersion: 1, criterionText: "Criterion 1 holds", level: "unit", targetFiles: ["src/handler.ts"] });
  for (let i = 0; i < 3; i++) recordFlakeOutcome({ repoId: s.repo.id, signature: sig2, runId: `old${i}`, outcome: "flaky", strategyVersion: 1, criterionText: "Criterion 2 holds", level: "unit", targetFiles: ["src/handler.ts"] });
  const { deps: d, prompts } = deps({ responses: [{ tests: [gen("1", "unit"), gen("2", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.match(prompts[0], /\[1\]: the previous unit test .* was flaky and is quarantined\. Regenerate with a DIFFERENT strategy \(strategy version 2\)/);
    assert.match(prompts[0], /\[2\]: RETIRED/);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => [t.criterionIds[0], t.strategyVersion]), [["1", 2]]);
    assert.deepEqual(plan.unverifiable, [{ criterionId: "2", reason: RETIRED_REASON }]);
  } finally {
    s.cleanup();
  }
});

test("pure helpers: planPolicy, enforcePlanPolicy, buildCommands", () => {
  const setup = { languages: [], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] };
  const p = planPolicy({ criteria: [crit("1"), crit("2", "ui")], wfE2e: "auto", yml: { start: "x", url: "y" }, setup, touched: ["src/a.ts"] });
  assert.equal(p.apiOnly, true);
  assert.equal(p.e2eAllowed, true);
  assert.equal(p.maxLevel.get("1"), "integration");
  assert.equal(p.maxLevel.get("2"), "e2e");
  const noBoot = planPolicy({ criteria: [crit("2", "ui")], wfE2e: "always", yml: null, setup, touched: ["frontend/src/a.tsx"] });
  assert.equal(noBoot.e2eAllowed, false);
  assert.equal(noBoot.maxLevel.get("2"), "component");
  const { kept, violations } = enforcePlanPolicy([gen("1", "component") as any, gen("2", "e2e") as any], p, new Set());
  assert.deepEqual(kept.map((t) => t.criterionIds[0]), ["2"]);
  assert.deepEqual(violations.map((v) => v.reason), ["level"]);
  const cmds = buildCommands([
    { id: "a", path: ".devasign/tests/a.test.ts", content: "", criterionIds: ["1"], level: "unit", levelReason: "", origin: "generated", runner: "vitest", testSignature: "s", strategyVersion: 1, targetFiles: [] },
    { id: "b", path: "tests/test_b.py", content: null, criterionIds: ["2"], level: "integration", levelReason: "", origin: "existing", runner: "pytest", testSignature: "s", strategyVersion: 1, targetFiles: [] },
  ]);
  assert.deepEqual(cmds.map((c) => c.cmd), ['npx vitest run ".devasign/tests/a.test.ts"', 'python -m pytest -q "tests/test_b.py"']);
});
