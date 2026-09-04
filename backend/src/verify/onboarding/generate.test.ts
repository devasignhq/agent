// Offline: the onboarding generators against the five sample stacks, the
// extend-existing-workflow edit, .devasign.yml merging, expected secrets, and
// mechanical doctor patches. A generated workflow that fails on its first run
// is the fastest way to lose a user, so every output is parsed back.
//   node --import tsx/esm --test src/verify/onboarding/generate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { inferSetupFromTree } from "../detect.js";
import {
  ACTION_REF,
  connectionEnv,
  expectedSecrets,
  extendWorkflow,
  generateDevasignYml,
  generateWorkflow,
  guessVerifyConfig,
  patchWorkflowForDoctor,
  prBody,
  stackHints,
} from "./generate.js";

type Stack = { name: string; paths: string[]; packageJson?: object; files?: Record<string, string> };

const STACKS: Stack[] = [
  {
    name: "Next.js + Prisma + Postgres",
    paths: ["package.json", "package-lock.json", "next.config.js", "prisma/schema.prisma", "app/page.tsx", ".env.example", "tests/home.spec.ts", "playwright.config.ts"],
    packageJson: { scripts: { dev: "next dev", build: "next build", start: "next start", test: "vitest run" }, dependencies: { next: "15.0.0", "@prisma/client": "5.0.0", react: "19" }, devDependencies: { vitest: "2.0.0", prisma: "5.0.0", "@playwright/test": "1.55.0" }, engines: { node: ">=20" } },
    files: { ".env.example": "DATABASE_URL=postgres://x\nNEXTAUTH_SECRET=\nSTRIPE_KEY=\nNODE_ENV=development\n" },
  },
  {
    name: "plain Node API with Jest",
    paths: ["package.json", "package-lock.json", "src/server.js", "src/server.test.js", "jest.config.js", ".env.example"],
    packageJson: { scripts: { start: "node src/server.js", test: "jest" }, dependencies: { express: "4" }, devDependencies: { jest: "29" } },
    files: { ".env.example": "PORT=3000\nAPI_KEY=\n" },
  },
  {
    name: "Python FastAPI with pytest",
    paths: ["requirements.txt", "app/main.py", "tests/test_main.py", "pyproject.toml", ".github/workflows/lint.yml"],
    files: { "requirements.txt": "fastapi\nuvicorn\npytest\n", "pyproject.toml": '[project]\nrequires-python = ">=3.11"\n', ".github/workflows/lint.yml": "name: lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    env:\n      TOKEN: ${{ secrets.LINT_TOKEN }}\n    steps:\n      - uses: actions/checkout@v4\n" },
  },
  {
    name: "pnpm monorepo",
    paths: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json", "apps/web/src/app.tsx", "packages/db/package.json", "vitest.config.ts", ".nvmrc"],
    packageJson: { scripts: { test: "vitest run" }, devDependencies: { vitest: "2" }, packageManager: "pnpm@9" },
    files: { ".nvmrc": "22\n" },
  },
  { name: "no tests, no CI", paths: ["index.html", "server.mjs", "src/total.mjs"] },
];

function build(stack: Stack) {
  const files = stack.files || {};
  const pkgText = stack.packageJson ? JSON.stringify(stack.packageJson) : null;
  const setup = inferSetupFromTree(stack.paths, { packageJson: pkgText, envExample: files[".env.example"] ?? null });
  const pkg = stack.packageJson ? (stack.packageJson as any) : null;
  const hints = stackHints(setup, stack.paths, pkg, files);
  const workflows = stack.paths.filter((p) => p.startsWith(".github/workflows/")).map((p) => files[p] || "");
  const secrets = expectedSecrets(setup, workflows);
  const workflow = generateWorkflow(setup, hints, secrets, stack.paths);
  const verify = guessVerifyConfig(setup, hints, pkg, secrets);
  const yml = generateDevasignYml(null, verify);
  return { setup, hints, secrets, workflow, verify, yml, parsed: parse(workflow) as any };
}

test("every sample stack produces a parseable workflow with checkout → setup → verify, OIDC permission, and both triggers", () => {
  for (const stack of STACKS) {
    const b = build(stack);
    const w = b.parsed;
    assert.equal(w.name, "DevAsign verify", stack.name);
    assert.deepEqual(w.on.pull_request.types, ["opened", "synchronize", "reopened"], stack.name);
    assert.deepEqual(w.on.repository_dispatch.types, ["devasign-verify"], stack.name);
    assert.equal(w.permissions["id-token"], "write", stack.name);
    assert.equal(w.permissions.contents, "read", stack.name);
    const steps = w.jobs.verify.steps as Array<{ uses?: string; run?: string; name?: string }>;
    assert.equal(steps[0].uses, "actions/checkout@v4", stack.name);
    assert.match(String((steps[0] as any).with.ref), /pull_request\.head\.sha/, "checks out the PR head, not the merge ref");
    assert.equal(steps[steps.length - 1].uses, ACTION_REF, stack.name);
    assert.ok(steps.some((s) => s.uses?.startsWith("actions/setup-node@")), `${stack.name}: the runner is a Node CLI, so setup-node is always present`);
    assert.ok(parse(b.yml).verify, `${stack.name}: .devasign.yml has a verify block`);
    assert.equal(parse(b.yml).verify.e2e, "auto");
  }
});

test("Next.js + Prisma + Postgres: service container, DATABASE_URL points at it, secrets mapped, prisma prepared, boot config guessed", () => {
  const b = build(STACKS[0]);
  const job = b.parsed.jobs.verify;
  assert.equal(job.services.postgres.image, "postgres:16");
  assert.match(job.services.postgres.options, /pg_isready/);
  assert.equal(job.env.DATABASE_URL, "postgresql://postgres:postgres@localhost:5432/test");
  assert.equal(job.env.NEXTAUTH_SECRET, "${{ secrets.NEXTAUTH_SECRET }}");
  assert.equal(job.env.STRIPE_KEY, "${{ secrets.STRIPE_KEY }}");
  assert.equal(job.env.NODE_ENV, undefined, "wiring vars are not secrets");
  assert.deepEqual(b.secrets, ["NEXTAUTH_SECRET", "STRIPE_KEY"]);
  const steps = job.steps.map((s: any) => s.uses || s.run);
  assert.ok(steps.includes("npm ci"));
  assert.ok(steps.some((s: string) => /prisma migrate deploy/.test(s)));
  assert.equal(job.steps.find((s: any) => s.uses?.startsWith("actions/setup-node")).with["node-version"], "20");
  assert.equal(b.verify.start, "npm run dev");
  assert.equal(b.verify.url, "http://localhost:3000");
  assert.deepEqual(b.verify.services, [{ name: "postgres" }]);
  assert.deepEqual(b.verify.env, ["NEXTAUTH_SECRET", "STRIPE_KEY"]);
  assert.match(b.verify.seed!, /prisma db seed/);
});

test("Node + Jest: no services, secrets from .env.example minus PORT; FastAPI: setup-python + pip, secret from the existing workflow; pnpm monorepo: pnpm setup + frozen lockfile + Node 22; no-CI repo: just node + the action", () => {
  const jest = build(STACKS[1]);
  assert.equal(jest.parsed.jobs.verify.services, undefined);
  assert.deepEqual(jest.secrets, ["API_KEY"]);
  assert.equal(jest.verify.start, "npm start");

  const py = build(STACKS[2]);
  const pySteps = py.parsed.jobs.verify.steps;
  const setupPy = pySteps.find((s: any) => s.uses?.startsWith("actions/setup-python"));
  assert.equal(setupPy.with["python-version"], "3.11");
  assert.ok(pySteps.some((s: any) => s.run === "pip install -r requirements.txt"));
  assert.deepEqual(py.secrets, ["LINT_TOKEN"], "secrets referenced by existing workflows are expected too");
  assert.match(py.verify.start!, /uvicorn/);
  assert.equal(py.verify.url, "http://localhost:8000");

  const mono = build(STACKS[3]);
  const monoSteps = mono.parsed.jobs.verify.steps;
  assert.equal(monoSteps[1].uses, "pnpm/action-setup@v4");
  assert.equal(monoSteps.find((s: any) => s.uses?.startsWith("actions/setup-node")).with["node-version"], "22");
  assert.ok(monoSteps.some((s: any) => s.run === "pnpm install --frozen-lockfile"));

  const none = build(STACKS[4]);
  const steps = none.parsed.jobs.verify.steps;
  assert.deepEqual(steps.map((s: any) => s.uses || s.run), ["actions/checkout@v4", "actions/setup-node@v4", ACTION_REF]);
  assert.equal(none.verify.start, undefined, "no boot command is invented");
  assert.equal(none.secrets.length, 0);
  assert.deepEqual(connectionEnv(none.setup), {});
});

test("extendWorkflow appends the step to the test job, grants id-token, adds the dispatch trigger, and keeps comments", () => {
  const existing = [
    "# my CI",
    "name: CI",
    "on:",
    "  pull_request:",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm run lint",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    services:",
    "      postgres: { image: postgres:16 }",
    "    steps:",
    "      - uses: actions/checkout@v4 # keep me",
    "      - run: npm test",
    "",
  ].join("\n");
  const out = extendWorkflow(existing);
  assert.ok("text" in out, JSON.stringify(out));
  if ("text" in out) {
    assert.equal(out.job, "test");
    assert.match(out.text, /# my CI/);
    assert.match(out.text, /# keep me/);
    const w = parse(out.text);
    const steps = w.jobs.test.steps;
    assert.deepEqual(steps[steps.length - 1], { name: "DevAsign verify", uses: ACTION_REF });
    assert.equal(w.jobs.lint.steps.length, 1, "other jobs untouched");
    assert.equal(w.jobs.test.permissions["id-token"], "write");
    assert.equal(w.jobs.test.permissions.contents, "read");
    assert.deepEqual(w.on.repository_dispatch.types, ["devasign-verify"]);
    assert.equal(w.jobs.test.services.postgres.image, "postgres:16", "their services are reused");
    const again = extendWorkflow(out.text);
    assert.ok("error" in again && /already/.test(again.error));
  }
  assert.ok("error" in extendWorkflow("name: x\n"));
  const picked = extendWorkflow("on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n", { job: "deploy" });
  assert.ok("text" in picked && picked.job === "deploy");
});

test("generateDevasignYml merges into an existing file without touching other blocks and never overwrites a customer's verify block", () => {
  const existing = "# repo config\nversion: 2\nfamily:\n  name: acme # keep\n  sisters:\n    - acme/other\n";
  const merged = generateDevasignYml(existing, { e2e: "auto", start: "npm run dev", url: "http://localhost:3000" });
  assert.match(merged, /# repo config/);
  assert.match(merged, /name: acme # keep/);
  const doc = parse(merged);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.family.sisters, ["acme/other"]);
  assert.equal(doc.verify.start, "npm run dev");
  const theirs = "verify:\n  e2e: never\n";
  assert.equal(generateDevasignYml(theirs, { e2e: "auto" }), theirs);
  const fresh = generateDevasignYml(null, { e2e: "auto" });
  assert.match(fresh, /^# \.devasign\.yml/);
});

test("prBody lists expected secrets and flags the missing ones; patchWorkflowForDoctor fixes runtime + browsers only", () => {
  const b = build(STACKS[0]);
  const body = prBody({ mode: "separate", workflowPath: ".github/workflows/devasign-verify.yml", hints: b.hints, setup: b.setup, verify: b.verify, expected: b.secrets, missing: ["STRIPE_KEY"] });
  assert.match(body, /`NEXTAUTH_SECRET` — present/);
  assert.match(body, /`STRIPE_KEY` — \*\*not found/);
  assert.match(body, /Add the missing secret under Settings/);
  assert.match(body, /detected: Next\.js, Prisma, Postgres/);
  const unreadable = prBody({ mode: "separate", workflowPath: "x", hints: b.hints, setup: b.setup, verify: b.verify, expected: b.secrets, missing: null });
  assert.match(unreadable, /could not read this repository's secret names/);
  const ext = prBody({ mode: "extend", workflowPath: ".github/workflows/ci.yml", hints: b.hints, setup: b.setup, verify: b.verify, expected: [], missing: [], extendedJob: "test" });
  assert.match(ext, /appended to the `test` job in `\.github\/workflows\/ci\.yml`/);

  const patched = patchWorkflowForDoctor(b.workflow, { stage: "install", code: "wrong_runtime_version", message: "the repository wants Node >=22 but the runner has v20.1.0" });
  assert.ok(patched);
  assert.equal(parse(patched!).jobs.verify.steps.find((s: any) => s.uses?.startsWith("actions/setup-node")).with["node-version"], "22");
  const browsers = patchWorkflowForDoctor(b.workflow, { stage: "browsers", code: "browser_install_failed", message: "no chromium" });
  assert.ok(browsers);
  const steps = parse(browsers!).jobs.verify.steps;
  assert.equal(steps[steps.length - 2].run, "npx playwright install --with-deps chromium");
  assert.equal(steps[steps.length - 1].uses, ACTION_REF);
  assert.equal(patchWorkflowForDoctor(b.workflow, { stage: "start", code: "no_start_command", message: "x" }), null, "needs a human");
});
