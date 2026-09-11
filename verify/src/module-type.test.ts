// node --import tsx/esm --test src/module-type.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";
import { detectModuleSyntax, inheritedModuleType, planModuleTypeShims, writeModuleTypeShims } from "./module-type.js";
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
  assert.equal(detectModuleSyntax('const { plan } = await import("./plan.js");\n'), null);
  assert.equal(detectModuleSyntax('exports.x = 1;\nconst m = import("./x.js");\n'), "commonjs");
  // createRequire is how an ESM file reads a CJS one; the imports still decide.
  assert.equal(detectModuleSyntax('import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n'), "module");
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
test("a relocated ESM test runs against an ESM package the repo root does not declare", async () => {
  const root = repo({
    // No root package.json — devasignhq/agent has none, so .devasign/tests/ is a CommonJS scope.
    "backend/package.json": { type: "module" },
    "backend/src/plan.ts": 'import { judge } from "./judge.js";\nexport const plan = () => `planned:${typeof judge}`;\n',
    "backend/src/judge.ts": 'import { plan } from "./plan.js";\nexport const judge = () => `judged:${typeof plan}`;\n',
  });
  const rel = ".devasign/tests/backend/src/plan.test.ts";
  const content = [
    "// criteria 1",
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { plan } from "../../../../backend/src/plan.js";',
    'test("plan", () => assert.match(plan(), /^planned:/));',
    "",
  ].join("\n");
  const ws = new Workspace(root);
  ws.write(rel, content);
  const { cmd, args } = commandForFile("node-test", rel, root);

  const before = await runCommand({ cmd, args, cwd: root, timeoutMs: 60_000 });
  assert.notEqual(before.code, 0, "without a declared scope Node loads the test as CommonJS and it never reaches an assertion");

  writeModuleTypeShims(ws, [planTest({ path: rel, content })]);
  const after = await runCommand({ cmd, args, cwd: root, timeoutMs: 60_000 });
  assert.equal(after.code, 0, `${after.stdout}\n${after.stderr}`);
  assert.match(after.stdout, /# pass 1/);
  ws.cleanup();
});
