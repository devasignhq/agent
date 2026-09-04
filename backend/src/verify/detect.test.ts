// Offline: test-setup inference from a tree, .devasign.yml parsing.
//   node --import tsx/esm --test src/verify/detect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { envVarNames, inferSetupFromTree, isFrontendPath, isTestPath } from "./detect.js";
import { hasBootConfig, parseDevasignVerify } from "./yml.js";

test("isTestPath / isFrontendPath heuristics", () => {
  for (const p of ["src/a.test.ts", "src/__tests__/b.tsx", "tests/c.py", "pkg/d_test.go", "e2e/login.spec.ts", "conftest.py"]) assert.ok(isTestPath(p), p);
  for (const p of ["src/a.ts", "README.md", "backend/src/routes/api.ts"]) assert.ok(!isTestPath(p), p);
  assert.ok(isFrontendPath("frontend/src/app.tsx"));
  assert.ok(!isFrontendPath("backend/src/api.ts"));
});

test("inferSetupFromTree: pnpm monorepo with vitest + playwright + postgres", () => {
  const setup = inferSetupFromTree(
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vitest.config.ts", "playwright.config.ts", "apps/web/package.json", "apps/web/src/a.tsx", "packages/db/package.json", "packages/db/src/x.ts", ".github/workflows/ci.yml", "prisma/schema.prisma"],
    {
      packageJson: JSON.stringify({ scripts: { test: "vitest run", "test:e2e": "playwright test" }, devDependencies: { vitest: "^2.0.0", "@playwright/test": "^1.45.0" }, engines: { node: ">=20" } }),
      envExample: "DATABASE_URL=postgres://x\nREDIS_URL=redis://y\n# comment\nAPI_KEY=\n",
    }
  );
  assert.equal(setup.packageManager, "pnpm");
  assert.deepEqual(setup.monorepo, { tool: "pnpm", packages: ["apps/web", "packages/db"] });
  assert.deepEqual(setup.frameworks.map((f) => f.name), ["vitest", "playwright"]);
  assert.equal(setup.frameworks[1].configPath, "playwright.config.ts");
  assert.equal(setup.frameworks[0].version, "2.0.0");
  assert.deepEqual(setup.services, ["postgres", "redis"]);
  assert.deepEqual(setup.envExampleVars, ["DATABASE_URL", "REDIS_URL", "API_KEY"]);
  assert.deepEqual(setup.existingWorkflows, [".github/workflows/ci.yml"]);
  assert.equal(setup.nodeVersion, ">=20");
  assert.equal(setup.testCommands.length, 2);
});

test("inferSetupFromTree: python + go + node --test, and an empty repo", () => {
  const py = inferSetupFromTree(["pyproject.toml", "app/main.py", "tests/test_main.py"]);
  assert.equal(py.packageManager, "pip");
  assert.deepEqual(py.frameworks.map((f) => f.name), ["pytest"]);
  const go = inferSetupFromTree(["go.mod", "main.go", "main_test.go"]);
  assert.deepEqual(go.frameworks.map((f) => f.name), ["go-test"]);
  const node = inferSetupFromTree(["package.json", "package-lock.json", "src/a.ts"], { packageJson: JSON.stringify({ scripts: { test: "node --import tsx/esm --test 'src/**/*.test.ts'" } }) });
  assert.deepEqual(node.frameworks.map((f) => f.name), ["node-test"]);
  const empty = inferSetupFromTree(["index.html"]);
  assert.deepEqual(empty.frameworks, []);
  assert.equal(empty.packageManager, null);
  assert.deepEqual(envVarNames(null), []);
});

test("parseDevasignVerify reads the verify block and ignores the rest", () => {
  const cfg = parseDevasignVerify(`
version: 2
family:
  name: acme
verify:
  e2e: always
  install: pnpm install
  start: pnpm dev
  url: http://localhost:3000
  ready: /healthz
  services:
    - postgres
    - { name: redis, image: redis:7 }
    - mongo
  login:
    strategy: form
    form: { url: /login, user: $E2E_USER, pass: $E2E_PASS }
  env: [DATABASE_URL, 42]
`);
  assert.ok(cfg);
  assert.equal(cfg!.e2e, "always");
  assert.equal(cfg!.start, "pnpm dev");
  assert.deepEqual(cfg!.services, [{ name: "postgres" }, { name: "redis", image: "redis:7" }]);
  assert.equal(cfg!.login?.strategy, "form");
  assert.equal(cfg!.login?.form?.user, "$E2E_USER");
  assert.deepEqual(cfg!.env, ["DATABASE_URL"]);
  assert.equal(hasBootConfig(cfg), true);
  assert.equal(hasBootConfig(parseDevasignVerify("verify:\n  e2e: never\n")), false);
  assert.equal(parseDevasignVerify("family:\n  name: x\n"), null);
  assert.equal(parseDevasignVerify(": : not yaml ["), null);
  assert.equal(parseDevasignVerify("verify:\n  e2e: sometimes\n")?.e2e, undefined);
});
