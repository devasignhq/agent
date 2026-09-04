// Offline: the planner enforces what the model may not decide — existing tests
// must exist, levels obey the ladder policy, e2e:never wins, flaky signatures are
// regenerated at a new strategy or retired.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { buildCommands, enforcePlanPolicy, NO_BOOT_REASON, GENERATED_TEST_PREFIX, normalizeGeneratedPath, normalizeRawTests, rebaseRelativeImports, planPolicy, RETIRED_REASON, runVerifyPlan, type PlannerDeps } from "./plan.js";
import { recordFlakeOutcome, testSignature } from "./flake.js";
import { createVerifyRun, snapshotCriteriaRevision } from "./runs.js";
import type { Criterion } from "../types.js";
import type { PlanTest } from "./contract.js";
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

// The planner reads an attacker-influenceable diff, and its paths are written into
// the runner's checkout and into the "Adopt tests" commit.
test("generated test paths may never escape .devasign/tests/", () => {
  assert.equal(normalizeGeneratedPath("checkout.spec.ts", "playwright")?.path, ".devasign/tests/e2e/checkout.spec.ts");
  assert.equal(normalizeGeneratedPath("tests/total.test.ts", "node-test")?.path, ".devasign/tests/total.test.ts");
  assert.equal(normalizeGeneratedPath(".devasign/tests/e2e/x.spec.ts", "playwright")?.path, ".devasign/tests/e2e/x.spec.ts");
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
  assert.equal(planned.content, 'import { orderTotal } from "../../../src/total.js";');
});

// The `from` field only earns its place when the destination diverges from the
// model's path by more than the .devasign/tests/ prefix — which is exactly what
// the `tests/` strip does. Without this case, deriving `from` back out of the
// destination passes the whole suite while reintroducing the original bug.
test("a stripped tests/ segment still resolves against where the model thought it was", () => {
  const raw = { tests: [{ path: "tests/unit/total.test.ts", content: 'import { t } from "./total.js";', criterionIds: ["1"], origin: "generated", level: "unit", runner: "vitest" }] };
  const [t] = normalizeRawTests(raw, new Set(["1"]), "vitest");
  assert.equal(t.path, ".devasign/tests/unit/total.test.ts");
  assert.equal(t.content, 'import { t } from "../../../tests/unit/total.js";');
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
  const [spec] = normalizeRawTests(raw, new Set(["1"]), "vitest");
  assert.match(spec.content!, /from "\.\/factory\.js"/, "the sibling moved alongside it, so the specifier is unchanged");
  assert.match(spec.content!, /from "\.\.\/\.\.\/\.\.\/src\/total\.js"/, "repo source is still re-anchored");
});

// adoptGeneratedTests commits the rebased bytes under its own prefix; the ../ counts
// only survive because both prefixes are the same depth.
test("the adopt prefix is the same depth as the generated-test prefix", () => {
  assert.equal(ADOPT_DIR.split("/").length, GENERATED_TEST_PREFIX.split("/").length, "adopted imports would resolve elsewhere");
});
