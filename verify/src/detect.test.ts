// node --import tsx/esm --test src/detect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectSetup, manifestNames } from "./detect.js";

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-det-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

test("dependencies: declared names, deduped and sorted, from every workspace manifest", async () => {
  const root = repo({
    "package.json": { devDependencies: { vitest: "^3.0.0" }, workspaces: ["apps/*"] },
    "apps/web/package.json": { dependencies: { react: "^19.0.0", vitest: "^3.0.0" }, devDependencies: { "@testing-library/react": "^16.0.0" } },
    "apps/web/src/app.tsx": "export const App = () => null;",
  });
  const setup = await detectSetup(root, { probeRuntimes: false });
  assert.deepEqual(setup.dependencies, ["@testing-library/react", "react", "vitest"]);
});

test("dependencies: root-only repo, and a repo with no package.json at all", async () => {
  const solo = await detectSetup(repo({ "package.json": { dependencies: { express: "^4.0.0" } } }), { probeRuntimes: false });
  assert.deepEqual(solo.dependencies, ["express"]);

  // The root package is not symlinked into node_modules, so its own name is not importable.
  const empty = await detectSetup(repo({ "package.json": { name: "x" } }), { probeRuntimes: false });
  assert.deepEqual(empty.dependencies, [], "a manifest declaring nothing is still a known set");

  // No root manifest means no root node_modules: the set a relocated test resolves
  // against is genuinely empty, however many manifests sit in subdirectories.
  const none = await detectSetup(repo({ "main.go": "package main" }), { probeRuntimes: false });
  assert.deepEqual(none.dependencies, []);
  const subdirs = await detectSetup(repo({ "frontend/package.json": { dependencies: { react: "^18" } }, "frontend/src/a.tsx": "export const A = () => null;" }), { probeRuntimes: false });
  assert.deepEqual(subdirs.dependencies, []);

  const unreadable = await detectSetup(repo({ "package.json": "{ not json" }), { probeRuntimes: false });
  assert.equal(unreadable.dependencies, undefined, "unknown, not empty — this is what switches enforcement off");
});

test("manifestNames tolerates malformed or absent manifests", () => {
  assert.deepEqual(manifestNames(null), []);
  assert.deepEqual(manifestNames("{ not json"), []);
  assert.deepEqual(manifestNames(JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "2" } })), ["a", "b"]);
});

test("no root manifest: top-level packages are the install units; node-test is seen through them, vitest is not", async () => {
  const root = repo({
    "backend/package.json": { scripts: { test: "node --import tsx/esm --test 'src/**/*.test.ts'" }, devDependencies: { vitest: "^3.0.0" } },
    "backend/package-lock.json": "{}",
    "backend/src/a.ts": "export const a = 1;",
    "frontend/package.json": { scripts: { test: "node --test" } },
    "frontend/src/app.tsx": "export const App = () => null;",
  });
  const s = await detectSetup(root, { probeRuntimes: false });
  assert.deepEqual(s.packages, ["backend", "frontend"]);
  assert.equal(s.packageManager, "npm");
  assert.deepEqual(s.frameworks.map((f) => f.name), ["node-test"], "a package-local vitest cannot be imported from .devasign/tests");
  assert.deepEqual(s.dependencies, []);
  const rooted = await detectSetup(repo({ "package.json": { name: "x" }, "backend/package.json": { name: "b" } }), { probeRuntimes: false });
  assert.equal(rooted.packages, undefined);
});
