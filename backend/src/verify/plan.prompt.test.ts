// Offline: what a browser test's author is told, and what a non-browser one is not.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/plan.prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestFilePrompt, type PlanContext, type RawPlanTest } from "./plan.js";
import type { SourceFile } from "./app-source.js";
import type { TestRunner } from "./contract.js";

const ctx = (): PlanContext =>
  ({
    run: { prNumber: 7 },
    repo: { owner: "acme", name: "w" },
    criteria: [{ id: "C1", text: "Saving a workflow shows it saved" }],
    treePaths: new Set<string>(["frontend/src/app.tsx", "frontend/src/routes.ts"]),
    setup: { languages: ["typescript"], frameworks: [], dependencies: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] },
    prTitle: "Add refunds",
  }) as unknown as PlanContext;

const spec = (runner: TestRunner): RawPlanTest => ({
  path: "tests/workflow.spec.ts",
  content: null,
  criterionIds: ["C1"],
  level: runner === "playwright" ? "e2e" : "unit",
  levelReason: "",
  origin: "generated",
  runner,
  targetFiles: ["frontend/src/screen-workflow.tsx"],
});

const file = (path: string, content: string): SourceFile => ({ path, content, truncated: false });

const ROUTED: SourceFile[] = [
  file(
    "frontend/src/app.tsx",
    `<Routes>
  <Route path={ROUTE_PATHS.workflow} element={<WorkflowPage />} />
  <Route path={ROUTE_PATHS.root} element={<Navigate to={DEFAULT_ROUTE} replace />} />
</Routes>`
  ),
  file("frontend/src/routes.ts", `export const ROUTE_PATHS = { agent: "/agent", workflow: "/workflow", root: "/" } as const;\nexport const DEFAULT_ROUTE = ROUTE_PATHS.agent;\n`),
];

const PLAIN: SourceFile[] = [file("frontend/src/screen-workflow.tsx", "export function WorkflowPage() { return <button>Save</button>; }")];

// The nine timeouts: the author held app.tsx, which spells the URL `ROUTE_PATHS.workflow`, so
// the spec opened "/" — a redirect — and waited out the clock on the wrong screen.
test("a browser test is given the app's URLs, with the literal the source never spells", () => {
  const p = buildTestFilePrompt(ctx(), spec("playwright"), ROUTED);
  assert.match(p, /## URLs in this app/);
  assert.match(p, /- \/workflow — renders WorkflowPage/);
  assert.match(p, /- \/ — redirects to \/agent/);
  assert.ok(p.indexOf("## URLs in this app") < p.indexOf("## App source"), "the URL map comes before the source it was read from");
});

// plan.ts hands the whole repo tree to routeLines, so a Vite app's src/pages folder yields a URL
// per file — /BillingSettings for a screen served at /settings/billing. Say it was guessed.
test("a URL map taken from the file tree is offered as a guess, not as the app's route table", () => {
  const p = buildTestFilePrompt({ ...ctx(), treePaths: new Set(["src/pages/index.tsx", "src/pages/BillingSettings.tsx"]) }, spec("playwright"), PLAIN);
  assert.match(p, /## URLs in this app/);
  assert.match(p, /Guessed from the file tree/);
  assert.doesNotMatch(p, /Read off the app's own route table/);
});

test("a browser test carries the standing guidance", () => {
  const p = buildTestFilePrompt(ctx(), spec("playwright"), ROUTED);
  assert.match(p, /## Writing the spec/);
  assert.match(p, /`\/` is often a redirect/);
  assert.match(p, /Never invent an entity name/);
});

test("a non-browser runner gets neither the URL map nor the browser guidance", () => {
  for (const runner of ["node-test", "vitest"] as const) {
    const p = buildTestFilePrompt(ctx(), spec(runner), ROUTED);
    assert.doesNotMatch(p, /## URLs in this app/, runner);
    assert.doesNotMatch(p, /## Writing the spec/, runner);
    assert.doesNotMatch(p, /redirects to/, runner);
    assert.match(p, /## Source under test/, runner);
  }
});

test("a browser test whose source has no routes still reads as a whole prompt", () => {
  const p = buildTestFilePrompt(ctx(), spec("playwright"), PLAIN);
  assert.doesNotMatch(p, /## URLs in this app/);
  assert.match(p, /## App source/);
  assert.match(p, /### frontend\/src\/screen-workflow.tsx/);
  assert.match(p, /## Writing the spec/);
  assert.match(p, /submit it with/);
  assert.doesNotMatch(p, /\n\n\n/, "an absent URL map leaves no hole behind");
});

test("a browser test with no source at all still asks for a file", () => {
  const p = buildTestFilePrompt(ctx(), spec("playwright"));
  assert.doesNotMatch(p, /## URLs in this app/);
  assert.doesNotMatch(p, /## App source/);
  assert.match(p, /## Writing the spec/);
  assert.match(p, /submit it with/);
});
