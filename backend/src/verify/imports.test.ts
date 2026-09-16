// Offline: which bare specifiers a generated test may use, and the false-rejection
// guards that matter more than the rule itself.
//   node --import tsx/esm --test src/verify/imports.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportAllowList, disallowedImports, hasRenderStack, importTarget, packageRoot, unresolvedRelativeImports } from "./imports.js";
import type { DetectedSetup, TestRunner } from "./contract.js";

const setup = (over: Partial<DetectedSetup> = {}): DetectedSetup => ({
  languages: ["typescript"],
  packageManager: "npm",
  monorepo: null,
  frameworks: [{ name: "vitest" }],
  testCommands: [],
  envExampleVars: [],
  existingWorkflows: [],
  services: [],
  ...over,
});

const bad = (content: string, over: Partial<DetectedSetup> = {}, runner: TestRunner = "vitest") =>
  disallowedImports(content, buildImportAllowList(setup(over), runner));

test("packageRoot resolves a specifier to the package that must be installed", () => {
  assert.equal(packageRoot("@testing-library/jest-dom/vitest"), "@testing-library/jest-dom");
  assert.equal(packageRoot("lodash/fp"), "lodash");
  assert.equal(packageRoot("@scope/pkg"), "@scope/pkg");
  assert.equal(packageRoot("react"), "react");
  assert.equal(packageRoot("@/components/Card"), null, "a bundler alias is not a package");
  assert.equal(packageRoot("Not A Name"), null);
});

test("the reported bug: an absent package is rejected by its root, not its subpath", () => {
  assert.deepEqual(
    bad('import "@testing-library/jest-dom/vitest";\nimport { render } from "@testing-library/react";\n', { dependencies: ["vitest"] }),
    ["@testing-library/jest-dom", "@testing-library/react"]
  );
  assert.deepEqual(bad('import "@testing-library/jest-dom/vitest";', { dependencies: ["@testing-library/jest-dom"] }), [], "declared root, any subpath");
});

test("false-rejection guards: builtins, subpaths, aliases, type-only, workspace names, the runner's own module", () => {
  const content = [
    'import assert from "node:assert/strict";',
    'import { readFile } from "fs/promises";',
    'import { expect, it } from "vitest";',
    'import { format } from "date-fns/format";',
    'import { Card } from "@/components/Card";',
    'import { x } from "~/lib/x";',
    'import { y } from "#internal/y";',
    'import { db } from "@acme/db";',
    'import type { Foo } from "@absent/types";',
  ].join("\n");
  assert.deepEqual(bad(content, { dependencies: ["date-fns", "@acme/db"] }), []);
});

test("playwright and tsx resolve from the runner's own install, not the repo", () => {
  assert.deepEqual(bad('import { test, expect } from "@playwright/test";', { dependencies: [] }, "playwright"), []);
  assert.deepEqual(bad('import "tsx";', { dependencies: [] }, "node-test"), []);
});

test("enforcement is off unless we positively know the package set", () => {
  assert.deepEqual(bad('import "@absent/pkg";', {}), [], "dependencies absent → no allow-list");
  assert.deepEqual(bad('import "@absent/pkg";', { dependencies: [] }, "pytest"), [], "a python file imports by module name");
  assert.deepEqual(bad('import "@absent/pkg";', { dependencies: [] }), ["@absent/pkg"], "an empty manifest is still a known one");
});

test("a package name in a string, comment or template literal is not an import", () => {
  const content = [
    'import { expect, it } from "vitest";',
    '// import "@testing-library/react" would need a dependency',
    'const msg = `import "@absent/one"`;',
    "it(\"x\", () => expect(err).toMatch('Cannot find package \"@absent/two\"'));",
  ].join("\n");
  assert.deepEqual(bad(content, { dependencies: [] }), []);
});

test("hasRenderStack needs a DOM runner, a render library and a DOM environment — and defaults open", () => {
  assert.equal(hasRenderStack(setup()), true, "unknown dependencies must not close a rung");
  assert.equal(hasRenderStack(setup({ dependencies: ["@testing-library/react", "jsdom"] })), true);
  assert.equal(hasRenderStack(setup({ dependencies: ["@testing-library/react"] })), false, "no DOM environment");
  assert.equal(hasRenderStack(setup({ dependencies: ["jsdom"] })), false, "no render library");
  assert.equal(
    hasRenderStack(setup({ frameworks: [{ name: "node-test" }], dependencies: ["@testing-library/react", "jsdom"] })),
    false,
    "node --test has no DOM environment to render into"
  );
});

test("the framework's own renderer counts: react-dom and happy-dom render components with no testing library", () => {
  assert.equal(hasRenderStack(setup({ dependencies: ["happy-dom", "react", "react-dom", "vitest"] })), true);
  assert.equal(hasRenderStack(setup({ dependencies: ["jsdom", "preact"] })), true);
  assert.equal(hasRenderStack(setup({ dependencies: ["react", "react-dom"] })), false, "still needs a DOM environment");
});

test("unresolvedRelativeImports: names relative specifiers that reach no repository file, as written from the test's location", () => {
  const tree = new Set(["src/handler.ts", "src/util/index.ts", "src/data.json", "tests/fixture.ts"]);
  const exists = (p: string) => tree.has(p);
  const content = [
    'import { handler } from "../src/handler.js";', // .js → .ts is how ESM TypeScript spells it
    'import util from "../src/util";', // directory index
    'import data from "../src/data.json";',
    'import { fx } from "./fixture.ts";',
    'import type { T } from "./types-only.ts";', // erased before load
    'import { helper } from "./helper.ts";', // nothing there
    'const lazy = await import("./lazy.js");',
    'import { test } from "node:test";',
  ].join("\n");
  assert.deepEqual(unresolvedRelativeImports(content, "tests/x.test.ts", exists), ["./helper.ts", "./lazy.js"]);
  // A sibling the model believes it wrote beside the test, at the root it named.
  assert.deepEqual(unresolvedRelativeImports('import { a } from "./tests-view.ts";', ".devasign/tests/ledger.test.ts", exists), ["./tests-view.ts"]);
  // A climb past the root is a miscount the move will correct, so it is judged on where it
  // lands — not left to a rewrite step that used to decline it and report it to nobody.
  assert.deepEqual(unresolvedRelativeImports('import { a } from "../../src/handler.ts";', "tests/x.test.ts", exists), [], "clamps onto src/handler.ts, which is there");
  assert.deepEqual(unresolvedRelativeImports('import { a } from "../../nope/gone.ts";', "tests/x.test.ts", exists), ["../../nope/gone.ts"], "clamps onto nothing, so it leaves the repository");
  // A generated sibling is as real as a tree path once the plan writes it.
  const siblings = new Map([["src/factory", ".devasign/tests/src/factory.ts"]]);
  const withSibling = (p: string) => exists(p) || p === ".devasign/tests/src/factory.ts";
  assert.deepEqual(unresolvedRelativeImports('import { m } from "../../src/factory.js";', "tests/x.test.ts", withSibling, siblings), [], "it follows the sibling to where the plan writes it");
});

test("importTarget: the repository file a specifier lands on once its test has moved", () => {
  const tree = new Set(["frontend/src/verify-setup-view.ts"]);
  const exists = (p: string) => tree.has(p);
  // The run-35094936934 specifier, from the directory the model believed it was writing in.
  assert.deepEqual(importTarget("../../frontend/src/verify-setup-view.ts", "frontend", { exists }), { target: "frontend/src/verify-setup-view.ts" });
  assert.deepEqual(importTarget("../../../../frontend/src/verify-setup-view.js", "frontend", { exists }), { target: "frontend/src/verify-setup-view.js" }, "the model's own extension is kept");
  assert.deepEqual(importTarget("../../elsewhere/thing.ts", "frontend", { exists }), { reason: "above_root" });
  assert.deepEqual(importTarget("../../frontend/src/verify-setup-view.ts", "frontend", {}), { reason: "above_root" }, "nothing to gate the guess on");
  assert.deepEqual(importTarget("./${name}.js", "frontend", { exists }), { reason: "interpolated" });
  assert.deepEqual(importTarget("../..", "frontend/src", { exists }), { target: "." }, "the repository root is still inside it");
  assert.deepEqual(importTarget("../../..", "frontend/src", { exists }), { reason: "above_root" }, "a bare climb clamps to nothing");
  // In-root and simply wrong is not a miscounted climb: it is left where it points.
  assert.deepEqual(importTarget("../frontend/src/verify-setup-view.ts", "backend/src", { exists }), { target: "backend/frontend/src/verify-setup-view.ts" });
});
