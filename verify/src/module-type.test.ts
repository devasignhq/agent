// node --import tsx/esm --test src/module-type.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";
import { detectModuleSyntax, inheritedModuleType, planModuleTypeShims, writeModuleTypeShims } from "./module-type.js";
import { executePlan } from "./run.js";
import { commandForFile } from "./runners/index.js";
import type { PlanTest } from "./types.js";
import { Workspace } from "./workspace.js";

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-mt-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

const planTest = (t: Partial<PlanTest> & { path: string }): PlanTest => ({
  id: "t1",
  content: null,
  criterionIds: ["1"],
  level: "integration",
  levelReason: "",
  origin: "generated",
  runner: "node-test",
  testSignature: "sig",
  strategyVersion: 1,
  targetFiles: [],
  ...t,
});

test("detectModuleSyntax reads the file's own top-level syntax", () => {
  for (const esm of [
    'import test from "node:test";',
    'import { plan } from "../../backend/src/verify/plan.js";',
    'import * as fs from "node:fs";',
    'import type { Plan } from "./plan.js";',
    'import "./side-effect.js";',
    'import{test}from"node:test";',
    "export const x = 1;",
    "export default function () {}",
    'export * from "./x.js";',
  ]) {
    assert.equal(detectModuleSyntax(`// criteria 1\n${esm}\ntest("x", () => {});\n`), "module", esm);
  }

  for (const cjs of [
    'const test = require("node:test");',
    'require("./register.js");',
    "module.exports = { x: 1 };",
    "exports.total = total;",
  ]) {
    assert.equal(detectModuleSyntax(`// criteria 1\n${cjs}\n`), "commonjs", cjs);
  }

  assert.equal(detectModuleSyntax("const x = 1;\nif (x) console.log(x);\n"), null, "neither form: both scopes load it");
});

test("detectModuleSyntax: dynamic import is not ESM, and ESM wins over a createRequire", () => {
  assert.equal(detectModuleSyntax('const load = () => import("./plan.js");\n'), null);
  assert.equal(detectModuleSyntax('exports.x = 1;\nconst m = import("./x.js");\n'), "commonjs");
  // createRequire is how an ESM file reads a CJS one; the imports still decide.
  assert.equal(detectModuleSyntax('import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n'), "module");
});

test("detectModuleSyntax: an await outside every async function is module syntax", () => {
  for (const topLevel of [
    'const { test } = await import("node:test");',
    'const {\n  plan,\n} = await import("./plan.js");',
    "assert.equal(await total(), 3);",
    "for await (const row of rows()) console.log(row);",
    "if (process.env.CI) {\n  await seed();\n}",
    "const ping = async (): Promise<void> => {\n  await fetch(url);\n};\nawait ping();",
    "const ping = async () => await fetch(url);\nawait ping();",
  ]) {
    assert.equal(detectModuleSyntax(`// criteria 1\n${topLevel}\n`), "module", topLevel);
  }

  for (const nested of [
    'test("x", async () => {\n  const { plan } = await import("./plan.js");\n});',
    'test("x", async () => await run());',
    'test("x", async (t) => {\n  await t.test("y", async () => {\n    await run();\n  });\n});',
    'describe("x", () => {\n  it("y", async function () {\n    await ping();\n  });\n});',
    "async function setup(): Promise<{ ok: boolean }> {\n  return { ok: await ping() };\n}",
    "const api = {\n  async load() {\n    await ping();\n  },\n};",
    "class Suite {\n  async run(): Promise<void> {\n    await ping();\n  }\n}",
    "const settle = async <T,>(p: Promise<T>): Promise<T> => await p;",
    "const id = async x => await x;",
    'const note = "await import(x)"; // then await it',
  ]) {
    assert.equal(detectModuleSyntax(`// criteria 1\n${nested}\n`), null, nested);
  }

  assert.equal(detectModuleSyntax('const { total } = require("./total.js");\nconst re = /await total/;\n'), "commonjs", "a real require outranks an await the scan misreads");
});

test("detectModuleSyntax ignores module syntax quoted inside the test", () => {
  // The verifier's own suite asserts on module source, at column 0 inside a template literal.
  const src = ['const fixture = `', 'import x from "./x.js";', 'export const y = 1;', '`;', 'module.exports = { fixture };'].join("\n");
  assert.equal(detectModuleSyntax(src), "commonjs");
  assert.equal(detectModuleSyntax('/*\nimport a from "a";\n*/\nexports.x = 1;\n'), "commonjs");
  assert.equal(detectModuleSyntax('// import a from "a";\nexports.x = 1;\n'), "commonjs");
});

test("inheritedModuleType stops at the nearest package.json, like Node", () => {
  const root = repo({
    "package.json": { type: "module" },
    "packages/legacy/package.json": { name: "legacy" },
    "packages/modern/package.json": { type: "module" },
  });
  assert.equal(inheritedModuleType(root, "packages/modern/src"), "module");
  assert.equal(inheritedModuleType(root, "packages/legacy/src"), "commonjs", "no type field means CommonJS, and the walk stops there");
  assert.equal(inheritedModuleType(root, "src"), "module");
  assert.equal(inheritedModuleType(repo({ "backend/package.json": { type: "module" } }), ".devasign/tests"), "commonjs", "no manifest above it at all");
});

test("the live failure: a repo with no root manifest gets the scope its relocated tests need", () => {
  const root = repo({ "backend/package.json": { type: "module" }, "verify/package.json": { type: "module" } });
  const shims = planModuleTypeShims(root, [
    planTest({ id: "a", path: ".devasign/tests/backend/src/verify/plan.test.ts", content: 'import test from "node:test";\n' }),
    planTest({ id: "b", path: ".devasign/tests/backend/src/verify/judge.test.ts", content: 'import test from "node:test";\n' }),
    planTest({ id: "c", path: ".devasign/tests/verify-package-version.test.ts", content: 'import test from "node:test";\n' }),
  ]);
  assert.deepEqual(shims, [
    { dir: ".devasign/tests", type: "module" },
    // Covered by the shim above it, which is why the shallow one is decided first.
  ]);
});

test("no shim where the repo's own scope already loads the test as written", () => {
  const esm = repo({ "package.json": { type: "module" } });
  assert.deepEqual(planModuleTypeShims(esm, [planTest({ path: ".devasign/tests/total.test.ts", content: 'import test from "node:test";\n' })]), []);

  const cjs = repo({ "package.json": { name: "app" } });
  assert.deepEqual(planModuleTypeShims(cjs, [planTest({ path: ".devasign/tests/total.test.js", content: 'const test = require("node:test");\n' })]), []);
  assert.deepEqual(
    planModuleTypeShims(cjs, [planTest({ path: ".devasign/tests/total.test.js", content: 'import test from "node:test";\n' })]),
    [{ dir: ".devasign/tests", type: "module" }]
  );
});

test("a CommonJS test under an ESM root is declared too", () => {
  const root = repo({ "package.json": { type: "module" }, "legacy/package.json": { name: "legacy" } });
  assert.deepEqual(
    planModuleTypeShims(root, [planTest({ path: ".devasign/tests/legacy/total.test.js", content: 'const { total } = require("../../../legacy/total.js");\n' })]),
    [{ dir: ".devasign/tests/legacy", type: "commonjs" }]
  );
});

test("nothing is declared for files whose scope cannot move them", () => {
  const root = repo({ "backend/package.json": { type: "module" } });
  assert.deepEqual(
    planModuleTypeShims(root, [
      planTest({ path: ".devasign/tests/test_total.py", runner: "pytest", content: "import pytest\n" }),
      planTest({ path: ".devasign/tests/total_test.go", runner: "go", content: 'import "testing"\n' }),
      planTest({ path: ".devasign/tests/total.test.mts", content: 'import test from "node:test";\n' }),
      planTest({ path: "src/total.test.ts", origin: "existing", content: null }),
    ]),
    []
  );
});

test("a Playwright spec keeps the scope it had when a sibling shim would have moved it", () => {
  const root = repo({ "backend/package.json": { type: "module" } });
  const shims = planModuleTypeShims(root, [
    planTest({ id: "a", path: ".devasign/tests/api.test.ts", content: 'import test from "node:test";\n' }),
    planTest({ id: "b", path: ".devasign/tests/e2e/checkout.spec.ts", runner: "playwright", content: 'import { test } from "@playwright/test";\n' }),
  ]);
  assert.deepEqual(shims, [
    { dir: ".devasign/tests", type: "module" },
    { dir: ".devasign/tests/e2e", type: "commonjs" },
  ]);
});

test("one directory, one format: a mixture resolves to the format that cannot fall back", () => {
  const root = repo({ "package.json": { name: "app" } });
  assert.deepEqual(
    planModuleTypeShims(root, [
      planTest({ id: "a", path: ".devasign/tests/a.test.ts", content: 'import test from "node:test";\n' }),
      planTest({ id: "b", path: ".devasign/tests/b.test.js", content: 'const test = require("node:test");\n' }),
    ]),
    [{ dir: ".devasign/tests", type: "module" }]
  );
});

test("writeModuleTypeShims writes through the workspace, so cleanup takes them away again", () => {
  const root = repo({ "backend/package.json": { type: "module" } });
  const ws = new Workspace(root);
  const shims = writeModuleTypeShims(ws, [planTest({ path: ".devasign/tests/backend/src/plan.test.ts", content: 'import test from "node:test";\n' })]);
  assert.deepEqual(shims, [{ dir: ".devasign/tests/backend/src", type: "module" }]);
  const written = path.join(root, ".devasign", "tests", "backend", "src", "package.json");
  assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), { type: "module" });
  ws.cleanup();
  assert.equal(existsSync(written), false);
});

// The regression itself: on the runner this threw ERR_REQUIRE_CYCLE_MODULE on every
// generated test, before a single assertion ran.
test("relocated ESM tests run against an ESM package the repo root does not declare", async () => {
  const root = repo({
    // No root package.json — devasignhq/agent has none, so .devasign/tests/ is a CommonJS scope.
    "backend/package.json": { type: "module" },
    "backend/src/plan.ts": 'import { judge } from "./judge.js";\nexport const plan = () => `planned:${typeof judge}`;\n',
    "backend/src/judge.ts": 'import { plan } from "./plan.js";\nexport const judge = () => `judged:${typeof plan}`;\n',
  });
  const tests = [
    planTest({
      id: "imports",
      path: ".devasign/tests/backend/src/plan.test.ts",
      content: [
        "// criteria 1",
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { plan } from "../../../../backend/src/plan.js";',
        'test("plan", () => assert.match(plan(), /^planned:/));',
        "",
      ].join("\n"),
    }),
    // Its only module syntax is a top-level await, and no other test shares its directory.
    planTest({
      id: "awaits",
      path: ".devasign/tests/loaded/plan.test.ts",
      content: [
        "// criteria 1",
        'const { test } = await import("node:test");',
        'const { default: assert } = await import("node:assert/strict");',
        'const { plan } = await import("../../../backend/src/plan.js");',
        'test("plan", () => assert.match(plan(), /^planned:/));',
        "",
      ].join("\n"),
    }),
  ];
  const ws = new Workspace(root);
  for (const t of tests) {
    ws.write(t.path, t.content!);
    const { cmd, args } = commandForFile("node-test", t.path, root);
    const before = await runCommand({ cmd, args, cwd: root, timeoutMs: 60_000 });
    assert.notEqual(before.code, 0, `${t.id}: without a declared scope Node loads the test as CommonJS and it never reaches an assertion`);
  }

  // Through executePlan, as the CLI runs them, so the shims have to be wired in and not only planned.
  const { results } = await executePlan(
    {
      planId: "plan-mt",
      criteriaRevision: 1,
      criteria: [{ id: "1", text: "The plan loads", kind: "code" }],
      tests,
      commands: [],
      playwright: null,
      retries: { generated: 0, existing: 0 },
      uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 10 },
    },
    ws,
    { yml: null, testTimeoutMs: 60_000, setup: undefined }
  );
  assert.deepEqual(results.map((r) => [r.testId, r.status]), [["imports", "pass"], ["awaits", "pass"]], JSON.stringify(results.map((r) => r.error)));
  for (const dir of [".devasign/tests/backend/src", ".devasign/tests/loaded"]) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")), { type: "module" }, dir);
  }
  ws.cleanup();
});
