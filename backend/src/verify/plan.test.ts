// Offline: the planner enforces what the model may not decide — existing tests
// must exist, levels obey the ladder policy, e2e:never wins, flaky signatures are
// regenerated at a new strategy or retired.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { buildCommands, enforcePlanPolicy, hasUntriedRung, MISSING_PACKAGE_REASON, NO_BOOT_REASON, GENERATED_TEST_PREFIX, normalizeGeneratedPath, normalizeRawTests, PLAN_CUT_OFF_REASON, PLAN_UNUSABLE_REASON, rebaseGeneratedContent, rebaseRelativeImports, planPolicy, RETIRED_REASON, runnerAvailable, runVerifyPlan, type PlannerDeps } from "./plan.js";
import type { StructuredResult } from "../llm.js";
import { recordFlakeOutcome, testSignature } from "./flake.js";
import { createVerifyRun, snapshotCriteriaRevision } from "./runs.js";
import type { Criterion } from "../types.js";
import type { DetectedSetup, PlanTest } from "./contract.js";
import { ADOPT_DIR } from "./onboarding/job.js";

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

// A scripted answer: a plain object is a manifest; `{ __stop, raw }` fakes a cut
// or prose answer. Body calls are answered from the manifest entry's `content`
// unless `bodies[path]` scripts them.
type Scripted = unknown | { __stop: "max_tokens" | "end_turn"; raw?: string };
function scripted(r: Scripted): StructuredResult {
  const s = r as { __stop?: string; raw?: string };
  if (s && typeof s === "object" && s.__stop) return { input: null, text: s.raw ?? "", stopReason: s.__stop, raw: s.raw ?? "" };
  return { input: r ?? {}, text: JSON.stringify(r ?? {}), stopReason: "tool_use", raw: JSON.stringify(r ?? {}) };
}

function deps(opts: { tree?: string[]; files?: Record<string, string>; diff?: string; responses: Scripted[]; bodies?: Record<string, Scripted[]> }) {
  const prompts: string[] = [];
  const bodyPrompts: string[] = [];
  const responses = [...opts.responses];
  const bodies = Object.fromEntries(Object.entries(opts.bodies ?? {}).map(([k, v]) => [k, [...v]]));
  const seen: Array<{ path?: string; content?: string }> = [];
  let inFlight = 0;
  const gauge = { maxInFlight: 0, manifestBudgets: [] as number[] };
  const d: PlannerDeps = {
    fetchTree: async () => (opts.tree ?? BASE_TREE).map((path) => ({ path, type: "blob", sha: "s", size: 10 })),
    fetchDiff: async () => opts.diff ?? DIFF,
    readFile: async (_i, _r, path) => opts.files?.[path] ?? null,
    llm: async ({ messages, tool, maxTokens }) => {
      const user = messages[0].content;
      if (tool.name !== "submit_test_file") {
        prompts.push(user);
        gauge.manifestBudgets.push(maxTokens);
        const next = responses.shift();
        for (const t of ((next as { tests?: unknown[] })?.tests ?? []) as Array<{ path?: string; content?: string }>) seen.push(t);
        return scripted(next);
      }
      bodyPrompts.push(user);
      inFlight += 1;
      gauge.maxInFlight = Math.max(gauge.maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      const path = /^- path: (.+)$/m.exec(user)?.[1] ?? "";
      const queued = bodies[path]?.shift();
      if (queued !== undefined) return scripted(queued);
      const src = seen.find((t) => t.path === path || t.path === `./${path}`);
      return scripted({ path, content: src?.content ?? `// DevAsign generated test\n` });
    },
  };
  return { deps: d, prompts, bodyPrompts, gauge };
}

const gen = (id: string, level: PlanTest["level"], extra: Partial<PlanTest> & { strategy?: string } = {}) => ({
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
    assert.match(String(plan.unverifiable[0].fixUrl), /\/workflow\?repo=/);
    assert.match(prompts[0], /Browser \(e2e\) tests: not available \(no app start \/ login configured\)/);
    assert.match(prompts[0], /UI criteria remain testable at component level/);
    assert.match(prompts[0], /\[1\]: max level component/);
  } finally {
    s.cleanup();
  }
});

const PKG = (deps: Record<string, string>) => JSON.stringify({ devDependencies: deps });

test("the installed package list reaches the planner and the body prompt", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = deps({ files: { "package.json": PKG({ vitest: "^3", "@testing-library/react": "^16" }) }, responses: [{ tests: [gen("1", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    // renderSetup feeds buildPlannerUserPrompt and the body step's shared-context system prompt alike.
    assert.match(prompts[0], /Installed packages \(the ONLY ones a test may import\): @testing-library\/react, vitest/);
  } finally {
    s.cleanup();
  }
});

test("without a render library the component rung closes, and a waved-off ui criterion is not re-asked", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const responses = [{ tests: [gen("2", "unit")], unverifiable: [{ criterionId: "1", reason: "nothing can render it" }] }];
  const { deps: d, prompts } = deps({ files: { "package.json": PKG({ vitest: "^3" }) }, diff: UI_DIFF, responses });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(prompts.length, 1, "re-asking would only pressure the model into an import it does not have");
    assert.match(prompts[0], /No component-test environment either/);
    assert.doesNotMatch(prompts[0], /UI criteria remain testable at component level/);
    assert.equal(db.find("verifyPlans", (p) => p.runId === s.run.id)!.unverifiable[0].criterionId, "1");
  } finally {
    s.cleanup();
  }
});

test("with a render library present the component rung stays open and the criterion is re-asked", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const responses = [{ tests: [gen("2", "unit")], unverifiable: [{ criterionId: "1", reason: "nothing can render it" }] }, { tests: [gen("1", "component")] }];
  const { deps: d, prompts } = deps({ files: { "package.json": PKG({ vitest: "^3", "@testing-library/react": "^16", jsdom: "^25" }) }, diff: UI_DIFF, responses });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /UI criteria remain testable at component level/);
    assert.match(prompts[1], /Re-plan ONLY these criteria/);
  } finally {
    s.cleanup();
  }
});

test("a body importing a package the repo lacks is repaired once, naming what it may use instead", async () => {
  const s = seed([crit("1")]);
  const { deps: d, bodyPrompts } = deps({
    files: { "package.json": PKG({ vitest: "^3" }) },
    responses: [{ tests: [gen("1", "unit", { runner: "vitest" })] }],
    bodies: {
      "criterion-1.test.ts": [
        { path: "criterion-1.test.ts", content: 'import "@testing-library/jest-dom/vitest";\nimport { it } from "vitest";\n' },
        { path: "criterion-1.test.ts", content: 'import { it, expect } from "vitest";\nit("holds", () => expect(1).toBe(1));\n' },
      ],
    },
  });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(bodyPrompts.length, 2, "exactly one repair pass");
    const attempts = (db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!.meta as any).attempts.bodies[`${GENERATED_TEST_PREFIX}/criterion-1.test.ts`];
    assert.match(attempts[0].reason, /it imports "@testing-library\/jest-dom", which this repository does not have/);
    assert.match(attempts[0].reason, /Rewrite it using only these packages: .*vitest/);
    assert.equal(attempts[1].kind, "repair");
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.match(String(plan.tests[0].content), /import \{ it, expect \} from "vitest"/);
    assert.equal(plan.unverifiable.length, 0);
  } finally {
    s.cleanup();
  }
});

test("a body still importing a missing package after repair is dropped; its criterion says so, its sibling ships", async () => {
  const s = seed([crit("1"), crit("2")]);
  const doomed = { path: "criterion-1.test.ts", content: 'import { render } from "@testing-library/react";\n' };
  const { deps: d } = deps({
    files: { "package.json": PKG({ vitest: "^3" }) },
    responses: [{ tests: [gen("1", "unit", { runner: "vitest" }), gen("2", "unit", { runner: "vitest" })] }],
    bodies: { "criterion-1.test.ts": [doomed, doomed] },
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => t.criterionIds[0]), ["2"], "the sibling still ships");
    assert.deepEqual(plan.unverifiable, [{ criterionId: "1", reason: MISSING_PACKAGE_REASON }]);
    assert.match(String(db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")?.detail), /body failed: .*criterion-1/);
  } finally {
    s.cleanup();
  }
});

test("two generated tests given one path both ship, under distinct names, neither overwriting the other", async () => {
  const s = seed([crit("1"), crit("2")]);
  // Seen live: three browser tests planned at one path ran as one file, and all three criteria
  // were credited with the last file's outcome.
  const { deps: d } = deps({
    responses: [{ tests: [gen("1", "unit", { path: "src/shape.test.ts" }), gen("2", "unit", { path: "src/shape.test.ts" })] }],
    bodies: { "src/shape.test.ts": [{ path: "src/shape.test.ts", content: "// one\n" }, { path: "src/shape.test.ts", content: "// two\n" }] },
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => [t.criterionIds[0], t.path, t.content]), [
      ["1", ".devasign/tests/src/shape.test.ts", "// one\n"],
      ["2", ".devasign/tests/src/shape-2.test.ts", "// two\n"],
    ]);
  } finally {
    s.cleanup();
  }
});

test("a browser spec that does not parse is repaired once, told the error and its line, before it can sink its batch", async () => {
  const s = seed([crit("1", "ui")]);
  // The live case: one bad regex flag made Playwright fail two passing specs loaded beside it.
  const broken = "import { test } from '@playwright/test'\ntest('pill', async ({ page }) => {\n  await page.getByRole('group', { name: /^Edge from /ac }).press('Enter')\n})\n";
  const fixed = "import { test } from '@playwright/test'\ntest('pill', async ({ page }) => {\n  await page.getByRole('group', { name: /^Edge from /i }).first().press('Enter')\n})\n";
  const { deps: d, bodyPrompts } = deps({
    tree: [...BASE_TREE, ".devasign.yml"],
    files: { ".devasign.yml": BOOT_YML },
    diff: UI_DIFF,
    responses: [{ tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts" })] }],
    bodies: { "e2e/pill.spec.ts": [{ path: "e2e/pill.spec.ts", content: broken }, { path: "e2e/pill.spec.ts", content: fixed }] },
  });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(bodyPrompts.length, 2, "exactly one repair pass");
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    const attempts = (log.meta as any).attempts.bodies[`${GENERATED_TEST_PREFIX}/e2e/pill.spec.ts`];
    assert.match(attempts[0].reason, /it does not parse — .*at line 3: await page\.getByRole\('group', \{ name: \/\^Edge from \/ac \}\)/);
    assert.equal(attempts[1].kind, "repair");
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.tests[0].content, fixed);
    assert.deepEqual(plan.unverifiable, []);
  } finally {
    s.cleanup();
  }
});

test("a browser spec that clicks a line is sent back once with how to select it, and ships if the author insists", async () => {
  const clicks = "import { test } from '@playwright/test'\ntest('pill', async ({ page }) => {\n  await page.getByRole('group', { name: 'Edge from a to b' }).click()\n})\n";
  const presses = clicks.replace(".click()", ".press('Enter')");
  for (const second of [presses, clicks]) {
    const s = seed([crit("1", "ui")]);
    const { deps: d, bodyPrompts } = deps({
      tree: [...BASE_TREE, ".devasign.yml"],
      files: { ".devasign.yml": BOOT_YML, "package.json": PKG({ "@xyflow/react": "^12.8.2" }) },
      diff: UI_DIFF,
      responses: [{ tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts" })] }],
      bodies: { "e2e/pill.spec.ts": [{ path: "e2e/pill.spec.ts", content: clicks }, { path: "e2e/pill.spec.ts", content: second }] },
    });
    try {
      await runVerifyPlan(s.run.id, d);
      assert.equal(bodyPrompts.length, 2, "exactly one repair pass");
      const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
      assert.match((log.meta as any).attempts.bodies[`${GENERATED_TEST_PREFIX}/e2e/pill.spec.ts`][0].reason, /clicks a React Flow line .*press\('Enter'\)/);
      const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
      // Told once: a pattern check is a nudge, never a reason to drop a spec that may be right.
      assert.equal(plan.tests.find((t) => t.level === "e2e")?.content, second);
    } finally {
      s.cleanup();
    }
  }
});

test("a criterion covered only by a browser test is re-asked, in the same re-plan, for a fallback below e2e", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const { deps: d, prompts } = deps({
    tree: [...BASE_TREE, ".devasign.yml"],
    files: { ".devasign.yml": BOOT_YML },
    diff: UI_DIFF,
    responses: [
      { tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts" }), gen("2", "unit")] },
      // The fallback, plus a repeat of the browser test the criterion already has.
      { tests: [gen("1", "unit", { path: "pill.logic.test.ts" }), gen("1", "e2e", { path: "e2e/pill-again.spec.ts" })] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Re-plan ONLY these criteria/);
    assert.match(prompts[1], /\[1\]: covered only by a browser test/);
    assert.doesNotMatch(prompts[1], /^- \[2\] /m, "a criterion that has a cheap test is not re-asked");
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(
      plan.tests.filter((t) => t.criterionIds.includes("1")).map((t) => [t.level, t.path]),
      [["e2e", ".devasign/tests/e2e/pill.spec.ts"], ["unit", ".devasign/tests/pill.logic.test.ts"]],
      "the fallback ships beside the browser test; the repeated browser test does not"
    );
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.deepEqual((log.meta as any).fallback, ["1"]);
  } finally {
    s.cleanup();
  }
});

test("a re-plan that cites this PR's own test as a fallback gets that test written by DevAsign instead", async () => {
  const s = seed([crit("1", "ui")]);
  const { deps: d, prompts } = deps({
    tree: [...BASE_TREE, ".devasign.yml"],
    files: { ".devasign.yml": BOOT_YML },
    diff: [UI_DIFF, TEST_DIFF].join("\n"),
    responses: [
      { tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts" })] },
      // Seen live: asked for fallbacks, the model cited the tests the PR ships with.
      { tests: [{ path: "src/handler.test.ts", content: null, criterionIds: ["1"], level: "unit", levelReason: "x", origin: "existing", runner: "node-test", targetFiles: ["src/handler.ts"] }] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.match(prompts[1], /\[1\]: covered only by a browser test.*never a test file this PR adds or changes/);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => [t.level, t.origin, t.path]), [
      ["e2e", "generated", ".devasign/tests/e2e/pill.spec.ts"],
      ["unit", "generated", ".devasign/tests/src/handler.test.ts"],
    ]);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.doesNotMatch(String(log.detail), /pr_authored, re-plan/);
  } finally {
    s.cleanup();
  }
});

test("a runner the repo cannot spawn is coerced, not planned; a detected one is kept", async () => {
  const plannedRunner = async (pkg: Record<string, string> | null) => {
    const s = seed([crit("1")]);
    const files = pkg ? { "package.json": PKG(pkg) } : undefined;
    const { deps: d } = deps({ files, responses: [{ tests: [gen("1", "unit", { runner: "vitest" })] }] });
    try {
      await runVerifyPlan(s.run.id, d);
      const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
      return { runner: plan.tests[0].runner, path: plan.tests[0].path, cmd: plan.commands[0].cmd };
    } finally {
      s.cleanup();
    }
  };

  // npx --no-install vitest cannot spawn in a repo that has no vitest.
  const coerced = await plannedRunner({ jest: "^29" });
  assert.equal(coerced.runner, "jest", "coerced to what the repo actually has");
  assert.match(coerced.cmd, /jest/);
  assert.equal(coerced.path, `${GENERATED_TEST_PREFIX}/criterion-1.test.ts`, "coercion must not move the file");

  assert.equal((await plannedRunner({ vitest: "^3" })).runner, "vitest", "a detected runner is the model's to pick");
  assert.equal((await plannedRunner(null)).runner, "vitest", "no frameworks detected is a blind spot, not a veto");
});

test("runnerAvailable only judges the runners that come from the repo's own node_modules", () => {
  const setup = (names: DetectedSetup["frameworks"][number]["name"][]): DetectedSetup => ({
    languages: [], packageManager: null, monorepo: null, frameworks: names.map((name) => ({ name })), testCommands: [], envExampleVars: [], existingWorkflows: [], services: [],
  });
  assert.equal(runnerAvailable("vitest", setup(["jest"])), false);
  assert.equal(runnerAvailable("jest", setup(["jest"])), true);
  assert.equal(runnerAvailable("vitest", setup([])), true, "nothing detected — do not enforce");
  for (const r of ["playwright", "node-test", "bundled", "pytest", "go"] as const) {
    assert.equal(runnerAvailable(r, setup(["jest"])), true, `${r} does not come from the repo's node_modules`);
  }
});

test("a python test is never coerced onto a JS runner", () => {
  const setup: DetectedSetup = {
    languages: ["python"], packageManager: "pip", monorepo: null, frameworks: [{ name: "pytest" }], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [],
  };
  const raw = { tests: [{ path: "test_x.py", content: "def test_x(): pass\n", criterionIds: ["1"], level: "unit", origin: "generated", runner: "pytest", targetFiles: [] }] };
  assert.equal(normalizeRawTests(raw, new Set(["1"]), "pytest", setup)[0].runner, "pytest");
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

// The planner reads an attacker-influenceable diff, and its paths are written into
// the runner's checkout and into the "Adopt tests" commit.
test("generated test paths may never escape .devasign/tests/", () => {
  assert.equal(normalizeGeneratedPath("checkout.spec.ts", "playwright")?.path, ".devasign/tests/e2e/checkout.spec.ts");
  assert.equal(normalizeGeneratedPath("tests/total.test.ts", "node-test")?.path, ".devasign/tests/total.test.ts");
  assert.equal(normalizeGeneratedPath(".devasign/tests/e2e/x.spec.ts", "playwright")?.path, ".devasign/tests/e2e/x.spec.ts");
  // Seen live: a browser test the model placed straight under .devasign/tests/ was never found.
  assert.equal(normalizeGeneratedPath(".devasign/tests/lineShape.e2e.spec.ts", "playwright")?.path, ".devasign/tests/e2e/lineShape.e2e.spec.ts");
  assert.equal(normalizeGeneratedPath(".devasign/tests/src/lib/x.test.ts", "vitest")?.path, ".devasign/tests/src/lib/x.test.ts");
  for (const bad of ["../../.github/workflows/steal.yml", "a/../../../etc/passwd", "..", ".devasign/../x.ts", ".devasign/hooks/pre-push", "/etc/passwd/../x"]) {
    assert.equal(normalizeGeneratedPath(bad, "node-test"), null, bad);
  }
  const known = new Set(["1"]);
  const raw = { tests: [
    { path: "../../.github/workflows/steal.yml", content: "on: push", criterionIds: ["1"], origin: "generated", level: "unit", runner: "node-test" },
    { path: "good.test.ts", content: "test", criterionIds: ["1"], origin: "generated", level: "unit", runner: "node-test" },
    { path: "src/../../../outside.test.ts", criterionIds: ["1"], origin: "existing", level: "unit", runner: "node-test" },
  ] };
  assert.deepEqual(normalizeRawTests(raw, known, "node-test").map((t) => t.path), [".devasign/tests/good.test.ts"]);
});

// Seen on the first live run: the model wrote `import { orderTotal } from "./total.js"`
// for a test it placed at src/total.refunds.test.ts, the planner moved the file to
// .devasign/tests/src/, and vitest could not resolve the import — so every criterion
// came back unverifiable with nothing asserted.
test("relative imports move with the test file", () => {
  const content = [
    "// criteria: 1, 2",
    'import { describe, expect, it } from "vitest";',
    'import { orderTotal } from "./total.js";',
    'import { findOrder } from "../orders.js";',
    'import helper from "./helpers/money.js";',
    'vi.mock("./total.js", () => ({}));',
    'const late = await import("./total.js");',
    'import express from "express";',
    'import thing from "@app/thing";',
  ].join("\n");
  const out = rebaseRelativeImports(content, "src/total.refunds.test.ts", ".devasign/tests/src/total.refunds.test.ts");
  assert.match(out, /from "\.\.\/\.\.\/\.\.\/src\/total\.js"/);
  assert.match(out, /from "\.\.\/\.\.\/\.\.\/orders\.js"/);
  assert.match(out, /from "\.\.\/\.\.\/\.\.\/src\/helpers\/money\.js"/);
  assert.match(out, /vi\.mock\("\.\.\/\.\.\/\.\.\/src\/total\.js"/);
  assert.match(out, /import\("\.\.\/\.\.\/\.\.\/src\/total\.js"\)/);
  assert.match(out, /from "express"/, "bare specifiers are untouched");
  assert.match(out, /from "@app\/thing"/, "aliases are untouched");

  // Forms the first cut of the rewriter missed. A side-effect import left
  // unrebased reproduces byte-for-byte the load failure this exists to prevent.
  const forms = [
    ['import "./mocks/server.js";', 'import "../../../src/mocks/server.js";'],
    ["import './mocks/server.js';", "import '../../../src/mocks/server.js';"],
    ['vi.doMock("./total.js", () => ({}));', 'vi.doMock("../../../src/total.js", () => ({}));'],
    ['vi.unmock("./total.js");', 'vi.unmock("../../../src/total.js");'],
    ['jest.setMock("./total.js", {});', 'jest.setMock("../../../src/total.js", {});'],
    ['const a = jest.requireActual("./total.js");', 'const a = jest.requireActual("../../../src/total.js");'],
    ['const b = await vi.importActual("./total.js");', 'const b = await vi.importActual("../../../src/total.js");'],
    ['const p = require.resolve("./total.js");', 'const p = require.resolve("../../../src/total.js");'],
    ["const c = await import(`./total.js`);", "const c = await import(`../../../src/total.js`);"],
    ['import {\n  a,\n} from "./total.js";', 'import {\n  a,\n} from "../../../src/total.js";'],
    ['export { x } from "./total.js";', 'export { x } from "../../../src/total.js";'],
    ['import "./.config/setup.js";', 'import "../../../src/.config/setup.js";'],
  ];
  for (const [input, want] of forms) {
    assert.equal(rebaseRelativeImports(input, "src/x.test.ts", ".devasign/tests/src/x.test.ts"), want, input);
  }

  // A module-looking path inside a string literal is data, not an import: rewriting
  // it would silently corrupt a test's expected value.
  const literals = [
    `assert.equal(msg, 'Cannot resolve module from "./config.json"');`,
    'expect(err.message).toBe(`failed to import ./total.js`);',
    '// see the note in ./total.js about rounding',
  ];
  for (const line of literals) {
    assert.equal(rebaseRelativeImports(line, "src/x.test.ts", ".devasign/tests/src/x.test.ts"), line, line);
  }

  // An interpolated specifier is not knowable here, and one above the repo root
  // cannot be made to resolve.
  assert.equal(
    rebaseRelativeImports("await import(`./${name}.js`);", "src/x.test.ts", ".devasign/tests/src/x.test.ts"),
    "await import(`./${name}.js`);"
  );
  assert.equal(
    rebaseRelativeImports('import x from "../../../../outside.js";', "src/x.test.ts", ".devasign/tests/src/x.test.ts"),
    'import x from "../../../../outside.js";'
  );

  // A playwright spec the model put at e2e/ lands in .devasign/tests/e2e/.
  const spec = 'import { expect, test } from "@playwright/test";\nimport { seed } from "./fixtures/seed.js";';
  assert.match(
    rebaseRelativeImports(spec, "e2e/order.spec.ts", ".devasign/tests/e2e/order.spec.ts"),
    /from "\.\.\/\.\.\/\.\.\/e2e\/fixtures\/seed\.js"/
  );
  // Same directory: nothing to do.
  assert.equal(rebaseRelativeImports(spec, ".devasign/tests/e2e/x.spec.ts", ".devasign/tests/e2e/x.spec.ts"), spec);

  // The whole path, through normalizeRawTests.
  const raw = { tests: [{ path: "src/total.refunds.test.ts", content: 'import { orderTotal } from "./total.js";', criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" }] };
  const [planned] = normalizeRawTests(raw, new Set(["1"]), "vitest");
  assert.equal(planned.path, ".devasign/tests/src/total.refunds.test.ts");
  assert.equal(planned.rebaseFrom, "src/total.refunds.test.ts");
  const [rewritten] = rebaseGeneratedContent([planned]).tests;
  assert.equal(rewritten.content, 'import { orderTotal } from "../../../src/total.js";');
});

// The `from` field only earns its place when the destination diverges from the
// model's path by more than the .devasign/tests/ prefix — which is exactly what
// the `tests/` strip does. Without this case, deriving `from` back out of the
// destination passes the whole suite while reintroducing the original bug.
test("a stripped tests/ segment still resolves against where the model thought it was", () => {
  const raw = { tests: [{ path: "tests/unit/total.test.ts", content: 'import { t } from "./total.js";', criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" }] };
  const [t] = normalizeRawTests(raw, new Set(["1"]), "vitest");
  assert.equal(t.path, ".devasign/tests/unit/total.test.ts");
  // The point of the case: `from` is NOT derivable from the destination.
  assert.equal(t.rebaseFrom, "tests/unit/total.test.ts");
  const [rewritten] = rebaseGeneratedContent([t]).tests;
  assert.equal(rewritten.content, 'import { t } from "../../../tests/unit/total.js";');
});

// node:test's mock.module is its only specifier-taking mock API, and jest/vitest
// carry several more; each one left unrebased is this commit's own bug again.
test("the module-mocking APIs of every selectable runner are re-anchored", () => {
  const forms = [
    'mock.module("./total.js", {});',
    't.mock.module("./total.js", {});',
    'jest.unstable_mockModule("./total.js", () => ({}));',
    'const m = await vi.importMock("./total.js");',
    'const r = jest.requireMock("./total.js");',
    'jest.dontMock("./total.js");',
    'vi.doUnmock("./total.js");',
    'jest.createMockFromModule("./total.js");',
  ];
  for (const line of forms) {
    const out = rebaseRelativeImports(line, "src/x.test.ts", ".devasign/tests/src/x.test.ts");
    assert.equal(out, line.replace("./total.js", "../../../src/total.js"), line);
  }
});

// Two generated files from one plan move together, so a reference between them
// must follow the sibling rather than point back at a path nothing writes.
test("a reference to another generated file in the same plan follows it", () => {
  const raw = {
    tests: [
      { path: "src/total.test.ts", content: 'import { make } from "./factory.js";\nimport { orderTotal } from "./total.js";', criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" },
      { path: "src/factory.ts", content: "export const make = () => [];", criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" },
    ],
  };
  const [spec] = rebaseGeneratedContent(normalizeRawTests(raw, new Set(["1"]), "vitest")).tests;
  assert.match(spec.content!, /from "\.\/factory\.js"/, "the sibling moved alongside it, so the specifier is unchanged");
  assert.match(spec.content!, /from "\.\.\/\.\.\/\.\.\/src\/total\.js"/, "repo source is still re-anchored");
});

// adoptGeneratedTests commits the rebased bytes under its own prefix; the ../ counts
// only survive because both prefixes are the same depth.
test("the adopt prefix is the same depth as the generated-test prefix", () => {
  assert.equal(ADOPT_DIR.split("/").length, GENERATED_TEST_PREFIX.split("/").length, "adopted imports would resolve elsewhere");
});

// A specifier the rewriter declines to touch cannot load once the file moves, so
// it is reported rather than shipped as a mystery load failure.
test("interpolated and above-root specifiers are reported, and the test still ships", () => {
  const raw = {
    tests: [
      { path: "src/a.test.ts", content: 'await import(`./${name}.js`);\nimport x from "../../../../outside.js";\nimport { ok } from "./total.js";', criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" },
    ],
  };
  const { tests, unresolved } = rebaseGeneratedContent(normalizeRawTests(raw, new Set(["1"]), "vitest"));
  assert.equal(tests.length, 1, "nothing is dropped");
  assert.match(tests[0].content!, /from "\.\.\/\.\.\/\.\.\/src\/total\.js"/, "the resolvable import is still re-anchored");
  assert.match(tests[0].content!, /import\(`\.\/\$\{name\}\.js`\)/, "the interpolated one is left as written");
  assert.deepEqual(
    unresolved.map((u) => [u.path, u.specifier, u.reason]),
    [
      [".devasign/tests/src/a.test.ts", "./${name}.js", "interpolated"],
      [".devasign/tests/src/a.test.ts", "../../../../outside.js", "above_root"],
    ]
  );
});

// The code check runs first, so a specifier that is data never counts as one the
// rewriter failed to resolve.
test("a ${ } inside a string literal is not reported as an unresolved import", () => {
  const raw = { tests: [{ path: "src/a.test.ts", content: `expect(msg).toBe('import("./\${x}.js") failed');`, criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" }] };
  const { tests, unresolved } = rebaseGeneratedContent(normalizeRawTests(raw, new Set(["1"]), "vitest"));
  assert.deepEqual(unresolved, []);
  assert.equal(tests[0].content, `expect(msg).toBe('import("./\${x}.js") failed');`, "test data is untouched");
});

// Only JS/TS imports are re-anchored; a pytest file is relocated too, but its
// imports are by module name and the move does not disturb them.
test("non-JS generated content is left alone", () => {
  const raw = { tests: [{ path: "tests/test_total.py", content: "from src.total import order_total\n", criterionIds: ["1"], origin: "generated", level: "unit", runner: "pytest" }] };
  const { tests } = rebaseGeneratedContent(normalizeRawTests(raw, new Set(["1"]), "pytest"));
  assert.equal(tests[0].path, ".devasign/tests/test_total.py");
  assert.equal(tests[0].content, "from src.total import order_total\n");
});

// Two survivors claiming one origin: no redirect is knowably right.
test("an origin claimed by two survivors falls back to the plain re-anchor", () => {
  const both = [
    { path: ".devasign/tests/e2e/util.spec.ts", content: null, rebaseFrom: "src/util.ts" },
    { path: ".devasign/tests/util.ts", content: null, rebaseFrom: "src/util.ts" },
    { path: ".devasign/tests/src/a.test.ts", content: 'import { u } from "./util.js";', rebaseFrom: "src/a.test.ts" },
  ];
  const { tests } = rebaseGeneratedContent(both);
  assert.equal(tests[2].content, 'import { u } from "../../../src/util.js";');
});

// Findings 3+4 live in the ORDER of the planner's steps, so they are pinned where
// that order actually runs. DIFF touches only src/handler.ts, so a code criterion
// is capped at integration and a component-level test is dropped by policy.
const sibling = (over: Record<string, unknown> = {}) => ({
  path: "src/factory.ts", content: "export const make = () => [];", criterionIds: ["1"],
  level: "unit", levelReason: "r", origin: "generated", runner: "vitest", targetFiles: ["src/handler.ts"], ...over,
});
const referrer = (over: Record<string, unknown> = {}) => ({
  path: "src/total.test.ts", content: 'import { make } from "./factory.js";', criterionIds: ["1"],
  level: "unit", levelReason: "r", origin: "generated", runner: "vitest", targetFiles: ["src/handler.ts"], ...over,
});
const planned = (runId: string) => db.find("verifyPlans", (p) => p.runId === runId)!;

test("a sibling dropped by policy is not followed — the referrer falls back to the repo path", async () => {
  const s = seed([crit("1")]);
  // The sibling asks for component, which the API-only diff forbids.
  const { deps: d } = deps({ responses: [{ tests: [referrer(), sibling({ level: "component" })] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const tests = planned(s.run.id).tests;
    assert.deepEqual(tests.map((t) => t.path), [".devasign/tests/src/total.test.ts"], "the sibling was dropped");
    assert.equal(tests[0].content, 'import { make } from "../../../src/factory.js";', "no redirect to a file nothing writes");
  } finally {
    s.cleanup();
  }
});

test("a sibling dropped by retirement is not followed either", async () => {
  const s = seed([crit("1")]);
  const sig = testSignature("Criterion 1 holds", "unit", ["src/factory.ts"]);
  for (let i = 0; i < 3; i++) {
    recordFlakeOutcome({ repoId: s.repo.id, signature: sig, runId: `old${i}`, outcome: "flaky", strategyVersion: 1, criterionText: "Criterion 1 holds", level: "unit", targetFiles: ["src/factory.ts"] });
  }
  const { deps: d } = deps({ responses: [{ tests: [referrer(), sibling({ targetFiles: ["src/factory.ts"] })] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const tests = planned(s.run.id).tests;
    assert.deepEqual(tests.map((t) => t.path), [".devasign/tests/src/total.test.ts"]);
    assert.equal(tests[0].content, 'import { make } from "../../../src/factory.js";');
  } finally {
    s.cleanup();
  }
});

test("when the dropped sibling's path is a real repo file, the fallback now points at it", async () => {
  const s = seed([crit("1")]);
  const { deps: d } = deps({
    tree: [...BASE_TREE, "src/factory.ts"],
    responses: [{ tests: [referrer(), sibling({ level: "component" })] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(planned(s.run.id).tests[0].content, 'import { make } from "../../../src/factory.js";', "resolves to the file that exists");
  } finally {
    s.cleanup();
  }
});

// Both planner batches are written into the same checkout, so they share one
// sibling scope. Under per-call scoping this specifier would be re-anchored away.
test("a sibling generated by the re-plan batch is still followed", async () => {
  const s = seed([crit("1"), crit("2")]);
  const { deps: d } = deps({
    responses: [
      { tests: [referrer(), gen("2", "e2e")] }, // criterion 2's e2e violates the API-only cap → re-plan
      { tests: [sibling({ criterionIds: ["2"] })] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const tests = planned(s.run.id).tests;
    assert.equal(tests.length, 2, "the re-plan test survived");
    const ref = tests.find((t) => t.path.endsWith("total.test.ts"))!;
    assert.equal(ref.content, 'import { make } from "./factory.js";', "both land in .devasign/tests/src/, so the specifier stands");
  } finally {
    s.cleanup();
  }
});

// The cheapest guard against moving the rewrite and forgetting to call it.
test("the persisted plan carries rewritten content, and unresolved imports reach the log", async () => {
  const s = seed([crit("1")]);
  const { deps: d } = deps({
    responses: [{ tests: [referrer({ content: 'import { orderTotal } from "./total.js";\nimport x from "../../../../outside.js";' })] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const test0 = planned(s.run.id).tests[0];
    assert.match(test0.content!, /from "\.\.\/\.\.\/\.\.\/src\/total\.js"/, "content is rewritten on the way to the runner");
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.match(String(log.detail), /unresolved imports: .*outside\.js \(above_root\)/);
    assert.equal((log.meta?.unresolvedImports as unknown[]).length, 1);
  } finally {
    s.cleanup();
  }
});

// --- The PR's own tests are not evidence, and a browser rung stays reachable ---

const TEST_DIFF = [
  DIFF,
  "diff --git a/src/handler.test.ts b/src/handler.test.ts",
  "--- /dev/null",
  "+++ b/src/handler.test.ts",
  "@@ -0,0 +1,2 @@",
  "+import { refunds } from './handler.js';",
  "+test('refunds', () => {});",
].join("\n");

const UI_DIFF = [
  "diff --git a/src/Canvas.tsx b/src/Canvas.tsx",
  "--- a/src/Canvas.tsx",
  "+++ b/src/Canvas.tsx",
  "@@ -1 +1,2 @@",
  " export function Canvas() {}",
  "+export function menu() { return 1; }",
].join("\n");

const BOOT_YML = "verify:\n  e2e: auto\n  start: npm run dev\n  url: http://localhost:5173\n";
const bootDeps = (responses: unknown[]) =>
  deps({ tree: [...BASE_TREE, ".devasign.yml"], files: { ".devasign.yml": BOOT_YML }, diff: UI_DIFF, responses });

test("a test file this PR wrote is withheld from the prompt and cannot be cited as evidence", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = deps({
    diff: TEST_DIFF,
    responses: [
      { tests: [{ path: "src/handler.test.ts", content: null, criterionIds: ["1"], level: "unit", levelReason: "x", origin: "existing", runner: "node-test", targetFiles: [] }] },
      { tests: [gen("1", "unit")] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.tests.map((t) => [t.origin, t.path]), [["generated", ".devasign/tests/criterion-1.test.ts"]], "the criterion got a test of DevAsign's own");
    assert.deepEqual(plan.prAuthoredTests, ["src/handler.test.ts"]);
    // The path is in the tree, so it is only the PR's authorship that rejected it.
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify");
    assert.match(String(log?.detail), /src\/handler\.test\.ts \(pr_authored\)/);
    assert.ok(!prompts[0].includes("  - src/handler.test.ts"), "the PR's own test is not listed as citable");
    assert.match(prompts[0], /1 test file this PR adds or changes is withheld/);
    assert.equal(prompts.length, 2);
  } finally {
    s.cleanup();
  }
});

test("a criterion waved off as unverifiable is re-asked when a browser rung was still open", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = bootDeps([
    { tests: [], unverifiable: [{ criterionId: "1", reason: "not deterministic in the headless environment" }] },
    { tests: [gen("1", "e2e", { levelReason: "node geometry is only measured by a real browser" })] },
  ]);
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2, "the escape hatch triggered exactly one re-plan");
    assert.match(prompts[1], /Re-plan ONLY these criteria/);
    assert.match(prompts[1], /\[1\]: you marked these unverifiable/);
    assert.deepEqual(plan.unverifiable, [], "the criterion is no longer unverifiable");
    assert.deepEqual(plan.tests.map((t) => [t.level, t.runner]), [["e2e", "playwright"]], "a code criterion capped at component reached the browser");
    // Fix 4: the repo has no Playwright of its own, so the planner is told it gets one.
    assert.match(prompts[0], /Playwright: supplied by the runner/);
    assert.match(prompts[0], /may still be planned at e2e/);
  } finally {
    s.cleanup();
  }
});

test("a criterion the planner stands behind as unverifiable keeps its second reason", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = bootDeps([
    { tests: [], unverifiable: [{ criterionId: "1", reason: "first pass reason" }] },
    { unverifiable: [{ criterionId: "1", reason: "no test at any level can decide this" }] },
  ]);
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2);
    assert.deepEqual(plan.tests, []);
    assert.deepEqual(plan.unverifiable, [{ criterionId: "1", reason: "no test at any level can decide this" }]);
  } finally {
    s.cleanup();
  }
});

test("the browser rung is one justified rung of overshoot, not an open cap", () => {
  const setup = { languages: [], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] };
  const ui = planPolicy({ criteria: [crit("1")], wfE2e: "auto", yml: { start: "x", url: "y" }, setup, touched: ["src/a.tsx"] });
  assert.equal(ui.maxLevel.get("1"), "component", "the cap itself is unchanged");
  assert.equal(hasUntriedRung("1", ui), true);

  const reason = "component renders into a DOM shim that never measures the node";
  const keep = enforcePlanPolicy([gen("1", "e2e", { levelReason: reason }) as any], ui, new Set());
  assert.deepEqual(keep.kept.map((t) => t.level), ["e2e"], "a justified escalation is admitted");

  const bare = enforcePlanPolicy([gen("1", "e2e", { levelReason: "needs a browser" }) as any], ui, new Set());
  assert.deepEqual(bare.violations.map((v) => v.reason), ["level"], "an unjustified one is not");

  const twoRungs = enforcePlanPolicy([gen("1", "e2e", { levelReason: reason }) as any], { ...ui, maxLevel: new Map([["1", "unit" as const]]) }, new Set());
  assert.deepEqual(twoRungs.violations.map((v) => v.reason), ["level"], "only component may overshoot, and only by one rung");

  const api = planPolicy({ criteria: [crit("1")], wfE2e: "auto", yml: { start: "x", url: "y" }, setup, touched: ["src/a.ts"] });
  assert.equal(hasUntriedRung("1", api), false);
  const apiOnly = enforcePlanPolicy([gen("1", "e2e", { levelReason: reason }) as any], api, new Set());
  assert.deepEqual(apiOnly.violations.map((v) => v.reason), ["level"], "an API-only diff never escalates");

  const noBoot = planPolicy({ criteria: [crit("1")], wfE2e: "auto", yml: null, setup, touched: ["src/a.tsx"] });
  assert.equal(hasUntriedRung("1", noBoot), true, "no boot config still leaves the component rung open");
});

const cut = (raw = '{"tests":[{"path":"criterion-1.test.ts","criterionIds":["1"],"level":"unit","levelReason":"r","origin":"gener') => ({ __stop: "max_tokens" as const, raw });

test("a manifest cut off twice marks every criterion cut off, never a config problem", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const { deps: d, prompts, bodyPrompts, gauge } = deps({ diff: UI_DIFF, responses: [cut(), cut()] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2, "one budget bump, no repair for a cut");
    assert.deepEqual(gauge.manifestBudgets, [8_000, 16_000]);
    assert.equal(bodyPrompts.length, 0);
    assert.deepEqual(plan.tests, []);
    assert.deepEqual(plan.unverifiable, [
      { criterionId: "1", reason: PLAN_CUT_OFF_REASON },
      { criterionId: "2", reason: PLAN_CUT_OFF_REASON },
    ]);
    assert.ok(!plan.unverifiable.some((u) => u.reason === NO_BOOT_REASON || u.fixUrl), "a cut is never reported as missing boot config");
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.deepEqual(log.meta?.cutOff, ["1", "2"]);
    assert.match(String(log.detail), /cut off: manifest stopped at max_tokens after 2 attempt\(s\)/);
    assert.equal((log.meta as any).attempts.manifest.length, 2);
    assert.match((log.meta as any).attempts.manifest[0].head, /^\{"tests"/);
  } finally {
    s.cleanup();
  }
});

test("a manifest cut once is re-asked with the larger budget and then planned normally", async () => {
  const s = seed([crit("1")]);
  const { deps: d, gauge } = deps({ responses: [cut(), { tests: [gen("1", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(gauge.manifestBudgets, [8_000, 16_000]);
    assert.deepEqual(plan.unverifiable, []);
    assert.equal(plan.tests.length, 1);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.deepEqual(log.meta?.cutOff, []);
    assert.ok(!String(log.detail).includes("cut off:"));
  } finally {
    s.cleanup();
  }
});

test("an invalid manifest gets one repair pass, and a second failure is reported as unusable", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = deps({ responses: [{ tests: "nope" }, { tests: [gen("1", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2);
    assert.equal(plan.tests.length, 1);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    const attempts = (log.meta as any).attempts.manifest;
    assert.equal(attempts[0].kind, "initial");
    assert.match(attempts[0].reason, /tests is not an array/);
    assert.equal(attempts[1].kind, "repair");
  } finally {
    s.cleanup();
  }
  const s2 = seed([crit("1")]);
  const second = deps({ responses: [{ tests: "nope" }, { __stop: "end_turn", raw: "I cannot plan this." }] });
  try {
    await runVerifyPlan(s2.run.id, second.deps);
    const plan = db.find("verifyPlans", (p) => p.runId === s2.run.id)!;
    assert.deepEqual(plan.unverifiable, [{ criterionId: "1", reason: PLAN_UNUSABLE_REASON }]);
    const log = db.find("reviewLogs", (l) => l.reviewId === s2.review.id && l.kind === "verify")!;
    assert.match(String(log.detail), /unusable: manifest returned no usable plan after 2 attempt\(s\)/);
  } finally {
    s2.cleanup();
  }
});

test("a manifest that sends its lists as JSON text is read as the lists, without a repair pass", async () => {
  const s = seed([crit("1")]);
  const { deps: d, prompts } = deps({ responses: [{ tests: JSON.stringify([gen("1", "unit")]), unverifiable: "[]" }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 1, "seen live: the repair repeated the string and the whole re-plan was lost");
    assert.equal(plan.tests.length, 1);
    assert.deepEqual(plan.unverifiable, []);
  } finally {
    s.cleanup();
  }
});

test("a body cut off twice drops that file alone; its sibling still ships, rebased", async () => {
  const s = seed([crit("1"), crit("2")]);
  const { deps: d, bodyPrompts } = deps({
    responses: [{ tests: [gen("1", "unit"), gen("2", "unit", { path: "src/two.test.ts", content: 'import { one } from "./one.js";\n' })] }],
    bodies: { "criterion-1.test.ts": [cut("import"), cut("import")] },
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(bodyPrompts.length, 3, "two attempts for the cut file, one for its sibling");
    assert.deepEqual(plan.tests.map((t) => t.path), [".devasign/tests/src/two.test.ts"]);
    assert.match(plan.tests[0].content!, /from "\.\.\/\.\.\/\.\.\/src\/one\.js"/);
    assert.deepEqual(plan.unverifiable, [{ criterionId: "1", reason: PLAN_CUT_OFF_REASON }]);
    const log = db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")!;
    assert.deepEqual(log.meta?.cutOff, ["1"]);
    assert.match(String(log.detail), /body failed: \.devasign\/tests\/criterion-1\.test\.ts \(output cut at max_tokens=24000\)/);
    assert.match(bodyPrompts[0], /^- path: criterion-1\.test\.ts$/m);
    assert.match(bodyPrompts[0], /^  - \[1\] Criterion 1 holds$/m);
  } finally {
    s.cleanup();
  }
});

test("bodies are authored warm-first, then at most three at a time", async () => {
  const ids = ["1", "2", "3", "4", "5", "6", "7"];
  const s = seed(ids.map((id) => crit(id)));
  const { deps: d, bodyPrompts, gauge } = deps({ responses: [{ tests: ids.map((id) => gen(id, "unit")) }] });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.tests.length, 7);
    assert.equal(bodyPrompts.length, 7);
    assert.equal(gauge.maxInFlight, 3);
  } finally {
    s.cleanup();
  }
});

test("a retired signature costs no body call", async () => {
  const s = seed([crit("1")]);
  const sig = testSignature("Criterion 1 holds", "unit", ["src/handler.ts"]);
  for (let i = 0; i < 3; i++) recordFlakeOutcome({ repoId: s.repo.id, signature: sig, runId: `old${i}`, outcome: "flaky", strategyVersion: 1, criterionText: "Criterion 1 holds", level: "unit", targetFiles: ["src/handler.ts"] });
  const { deps: d, bodyPrompts } = deps({ responses: [{ tests: [gen("1", "unit")] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.equal(bodyPrompts.length, 0);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.deepEqual(plan.unverifiable, [{ criterionId: "1", reason: RETIRED_REASON }]);
  } finally {
    s.cleanup();
  }
});

test("a quarantined test's body request names the new strategy version", async () => {
  const s = seed([crit("1")]);
  const sig = testSignature("Criterion 1 holds", "unit", ["src/handler.ts"]);
  recordFlakeOutcome({ repoId: s.repo.id, signature: sig, runId: "old", outcome: "flaky", strategyVersion: 1, criterionText: "Criterion 1 holds", level: "unit", targetFiles: ["src/handler.ts"] });
  const { deps: d, bodyPrompts } = deps({ responses: [{ tests: [gen("1", "unit", { strategy: "assert the return value" })] }] });
  try {
    await runVerifyPlan(s.run.id, d);
    assert.match(bodyPrompts[0], /^- strategy version: 2/m);
    assert.match(bodyPrompts[0], /^- strategy: assert the return value$/m);
  } finally {
    s.cleanup();
  }
});

test("no boot config: a UI criterion waved off with the no-boot reason is re-asked for a component test", async () => {
  const s = seed([crit("1", "ui")]);
  const { deps: d, prompts } = deps({
    diff: UI_DIFF,
    responses: [
      { tests: [], unverifiable: [{ criterionId: "1", reason: "no app start / login configured" }] },
      { tests: [gen("1", "component", { runner: "vitest", targetFiles: ["src/Canvas.tsx"] })] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Re-plan ONLY these criteria/);
    assert.match(prompts[1], /\[1\]: you marked these unverifiable/);
    assert.match(prompts[1], /highest level the policy allows/);
    assert.match(prompts[0], /UI criteria remain testable at component level/);
    assert.deepEqual(plan.unverifiable, []);
    assert.deepEqual(plan.tests.map((t) => t.level), ["component"]);
  } finally {
    s.cleanup();
  }
});

test("a UI criterion the planner still ties to app start after the re-ask keeps the boot reason and its fix link", async () => {
  const s = seed([crit("1", "ui")]);
  const { deps: d, prompts } = deps({
    diff: UI_DIFF,
    responses: [
      { tests: [], unverifiable: [{ criterionId: "1", reason: "needs the app running (no app start configured)" }] },
      { tests: [], unverifiable: [{ criterionId: "1", reason: "the pill only appears once the app boots; no login is configured" }] },
    ],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(prompts.length, 2);
    assert.equal(plan.unverifiable[0].reason, NO_BOOT_REASON);
    assert.match(plan.unverifiable[0].fixUrl!, /\/workflow\?repo=/);
  } finally {
    s.cleanup();
  }
});

// --- A branch cut before onboarding still boots the app ---

test("a head with no verify block plans e2e from the base branch's and hands it to the runner", async () => {
  const s = seed([crit("1", "ui")]);
  const reads: string[] = [];
  const { deps: d, prompts } = deps({ diff: UI_DIFF, responses: [{ tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts" })] }] });
  d.readFile = async (_i, _r, path, sha) => {
    reads.push(`${path}@${sha}`);
    return path === ".devasign.yml" && sha === "d" ? BOOT_YML : null;
  };
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.ok(reads.includes(".devasign.yml@d"), "read at the review's base sha");
    assert.match(prompts[0], /Browser \(e2e\) tests: available/);
    assert.deepEqual(plan.tests.map((t) => [t.level, t.runner]), [["e2e", "playwright"]]);
    assert.deepEqual(plan.verifyConfig, { e2e: "auto", start: "npm run dev", url: "http://localhost:5173" });
    assert.equal(plan.verifyConfigFrom, "base");
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.devasignYml?.sha, "d");
    assert.match(String(db.find("reviewLogs", (l) => l.reviewId === s.review.id && l.kind === "verify")?.detail), /base branch/);
  } finally {
    s.cleanup();
  }
});

test("a browser test's author is shown the app it drives; a unit test's author, the code it calls", async () => {
  const s = seed([crit("1", "ui"), crit("2")]);
  const files = {
    ".devasign.yml": BOOT_YML,
    "index.html": '<script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": "import App from './App'\nimport { TEMPLATES } from './templates'\n",
    "src/App.tsx": "export default function App() { return <button>Templates</button> }\n",
    "src/templates.ts": "export const TEMPLATES = []\n",
    "src/handler.ts": "export function handler() { return 1 }\n",
    "package.json": PKG({ "@xyflow/react": "^12.8.2" }),
  };
  const { deps: d, bodyPrompts } = deps({
    tree: [...BASE_TREE, ...Object.keys(files)],
    files,
    diff: UI_DIFF,
    responses: [{ tests: [gen("1", "e2e", { path: "e2e/pill.spec.ts", targetFiles: ["src/App.tsx"], strategy: "drag two blocks onto the canvas and join them" }), gen("2", "unit", { strategy: "call the handler" })] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const browser = bodyPrompts.find((p) => /^- runner: playwright$/m.test(p))!;
    const unit = bodyPrompts.find((p) => /^- runner: node-test$/m.test(p))!;
    assert.match(browser, /## App source/);
    assert.match(browser, /### src\/App\.tsx\n````\nexport default function App\(\) \{ return <button>Templates<\/button> \}/);
    assert.match(browser, /### src\/main\.tsx/);
    assert.doesNotMatch(unit, /## App source/);
    assert.match(unit, /## Source under test\n.+\n### src\/handler\.ts\n````\nexport function handler\(\) \{ return 1 \}/);
    assert.doesNotMatch(browser, /## Source under test/);
    // The planner never saw the app; its setup steps would outrank what the source shows.
    assert.doesNotMatch(browser, /^- strategy:/m);
    assert.match(unit, /^- strategy: call the handler$/m);
    assert.match(browser, /## Library notes\n- Each line is an SVG group/);
    assert.doesNotMatch(unit, /## Library notes/);
    assert.match(browser, /## Ways into a populated state\n.+\n- `TEMPLATES` in src\/templates\.ts — shown by src\/main\.tsx/);
    assert.ok(browser.indexOf("## Ways into") < browser.indexOf("## App source"), "listed ahead of the source it points into");
    assert.doesNotMatch(unit, /## Ways into/);
  } finally {
    s.cleanup();
  }
});

test("a vitest author sees the Vite config vitest falls back to, then the code under test and what it imports", async () => {
  const s = seed([crit("1")]);
  const files = {
    "package.json": PKG({ vitest: "^3.2.0" }),
    "vite.config.ts": "export default defineConfig({ plugins: [react()] })\n",
    "src/handler.ts": "import { RATES } from './rates'\nexport const handler = () => RATES.green\n",
    "src/rates.ts": "export const RATES = { green: '#16a34a' }\n",
  };
  const { deps: d, bodyPrompts } = deps({
    tree: [...BASE_TREE, ...Object.keys(files)],
    files,
    responses: [{ tests: [gen("1", "unit", { runner: "vitest", targetFiles: ["src/handler.ts"] })] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const unit = bodyPrompts.find((p) => /^- runner: vitest$/m.test(p))!;
    const at = (p: string) => unit.indexOf(`### ${p}\n`);
    const section = unit.indexOf("## Source under test");
    assert.ok(section >= 0 && section < at("vite.config.ts"), "the config comes first: it says whether a DOM environment is set");
    assert.ok(at("vite.config.ts") < at("src/handler.ts") && at("src/handler.ts") < at("src/rates.ts"), "then the code under test, then what it imports");
    assert.match(unit, /export const RATES = \{ green: '#16a34a' \}/, "the values a test would otherwise guess");
  } finally {
    s.cleanup();
  }
});

test("a generated vitest test that renders is given the DOM environment its config does not set", async () => {
  const s = seed([crit("1")]);
  const files = {
    "package.json": PKG({ vitest: "^3.2.0", "happy-dom": "^20.0.0", react: "^19.0.0", "react-dom": "^19.0.0" }),
    "vite.config.ts": "export default defineConfig({ plugins: [react()] })\n",
  };
  const rendered = "// criteria: [1]\nimport { createRoot } from 'react-dom/client'\ncreateRoot(document.createElement('div'))\n";
  const { deps: d } = deps({
    tree: [...BASE_TREE, ...Object.keys(files)],
    files,
    responses: [{ tests: [gen("1", "unit", { runner: "vitest", content: rendered })] }],
  });
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.tests[0].content, `// @vitest-environment happy-dom\n${rendered}`);
  } finally {
    s.cleanup();
  }
});

test("the head's own verify block wins, and the base branch is never read", async () => {
  const s = seed([crit("1", "ui")]);
  const reads: string[] = [];
  const { deps: d } = deps({ tree: [...BASE_TREE, ".devasign.yml"], diff: UI_DIFF, responses: [{ tests: [gen("1", "e2e")] }] });
  d.readFile = async (_i, _r, path, sha) => {
    reads.push(`${path}@${sha}`);
    if (path !== ".devasign.yml") return null;
    return sha === s.run.sha ? "verify:\n  start: npm start\n  url: http://localhost:3000\n" : BOOT_YML;
  };
  try {
    await runVerifyPlan(s.run.id, d);
    const plan = db.find("verifyPlans", (p) => p.runId === s.run.id)!;
    assert.equal(plan.verifyConfigFrom, "head");
    assert.equal(plan.verifyConfig?.start, "npm start");
    assert.ok(!reads.includes(".devasign.yml@d"));
  } finally {
    s.cleanup();
  }
});
