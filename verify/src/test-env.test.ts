// A generated test is model-written from repository content: it must never hold the runner's
// credentials, sees a repo secret only when verify.env names it, and its logs leave scrubbed.
//   node --import tsx/esm --test src/test-env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { executePlan } from "./run.js";
import { ourPlaywrightDir } from "./runners/playwright.js";
import { generatedTestEnv, withoutRunnerCredentials } from "./test-env.js";
import type { DetectedSetup, PlanTest, RunnerPlan } from "./types.js";
import { Workspace } from "./workspace.js";

test("the runner's own credentials and control files never reach a generated test, even when verify.env names them", () => {
  const runnerOnly = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example.test/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    ACTIONS_RUNTIME_TOKEN: "runtime-token",
    ACTIONS_RESULTS_URL: "https://results.example.test/",
    GITHUB_TOKEN: "ghs_job_token",
    GH_TOKEN: "ghs_job_token",
    DEVASIGN_TOKEN: "devasign-jwt",
    GITHUB_ENV: "/runner/_temp/set_env",
    GITHUB_PATH: "/runner/_temp/add_path",
    GITHUB_OUTPUT: "/runner/_temp/set_output",
    GITHUB_STATE: "/runner/_temp/save_state",
    GITHUB_STEP_SUMMARY: "/runner/_temp/step_summary",
  };
  const info = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_SHA: "abc1234", GITHUB_WORKSPACE: "/runner/work/app", RUNNER_TEMP: "/runner/_temp" };
  const { env, withheld } = generatedTestEnv({ ...runnerOnly, ...info }, Object.keys(runnerOnly));
  assert.deepEqual(env, info);
  assert.deepEqual(withheld, [], "always removed, so never offered back through verify.env");
  assert.deepEqual(withoutRunnerCredentials({ ...runnerOnly, ...info, NPM_TOKEN: "npm" }), { ...info, NPM_TOKEN: "npm" }, "the narrower cut keeps repo secrets");
});

test("a secret-looking variable reaches a generated test only when verify.env names it", () => {
  const { env, withheld } = generatedTestEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_listed",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
      NPM_TOKEN: "npm-token",
      DB_PASSWORD: "hunter2",
      MYSQL_PWD: "hunter3",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      BASIC_AUTH: "user:hunter4",
      SENTRY_DSN: "https://publickey@o1.ingest.sentry.example/1",
    },
    ["STRIPE_SECRET_KEY"]
  );
  assert.deepEqual(env, { STRIPE_SECRET_KEY: "sk_test_listed" });
  assert.deepEqual(withheld, ["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "BASIC_AUTH", "DB_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS", "MYSQL_PWD", "NPM_TOKEN", "SENTRY_DSN", "SSH_AUTH_SOCK"]);
  const ordinary = { GIT_AUTHOR_NAME: "CI Bot", GIT_AUTHOR_EMAIL: "ci@example.com", XAUTHORITY: "/tmp/.Xauthority", PWDEBUG: "0", PWD: "/work", OLDPWD: "/" };
  assert.deepEqual(generatedTestEnv(ordinary).env, ordinary, "AUTH and PWD count only as whole parts of a name");
});

test("connection strings that stay on the machine pass; credentials bound anywhere else do not, whatever the name", () => {
  const local = {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
    POSTGRES_PRISMA_URL: "postgresql://postgres:postgres@127.0.0.1:5432/test",
    MYSQL_URL: "mysql://root:root@[::1]:3306/test",
    SESSION_STORE_URL: "redis://localhost:6380/?password=pw",
    DATABASE_SOCKET_URL: "postgresql:///test",
    SQLITE_DATABASE_URL: "file:./dev.db",
    NEXTAUTH_URL: "http://localhost:3000",
  };
  const remote = {
    STAGING_DATABASE_URL: "postgresql://admin:pw@db.staging.example.com:5432/app",
    CACHE: "redis://:pw@cache.example.com:6379",
    MONGO: "mongodb+srv://user:pw@cluster0.example.net/app",
    // A container job's service by name, or whatever a self-hosted runner's search domain makes of it.
    SERVICE_DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/test",
    REDIS_URL: "redis://:pw@redis:6379",
    // Shapes a URL parser rejects or reads as local must fail closed.
    MONGO_URI: "mongodb://admin:pw@db1.prod:27017,db2.prod:27017/app",
    PG_CONN: "postgres://app:pw@/app",
    DB_URL: "postgres://prod-db/app?user=a&password=pw",
    JDBC_URL: "jdbc:postgresql://prod.example.com/app?user=a&password=pw",
    SOCKET_DATABASE_URL: "postgresql:///app?host=prod-db.example.com",
    ADO_CONNECTION: "Server=prod;Database=app;User Id=sa;Password=pw;",
    LIBPQ_CONNINFO: "host=prod dbname=app password=pw",
    LOCALHOST_LOOKALIKE: "http://localhost:80@evil.example.com/?token=x",
  };
  const plain = { API_BASE: "https://api.example.com", QUEUE_URL: "amqp://rabbitmq:5672", NODE_OPTIONS: "--max-old-space-size=4096", PATH: "/usr/bin", HOME: "/home/runner", PWD: "/work", OLDPWD: "/", NODE_ENV: "test", CI: "true" };
  const { env, withheld } = generatedTestEnv({ ...local, ...remote, ...plain }, ["MONGO"]);
  assert.deepEqual(env, { ...local, MONGO: remote.MONGO, ...plain });
  assert.deepEqual(withheld, Object.keys(remote).filter((k) => k !== "MONGO").sort());
});

// ---- Through executePlan, as the CLI runs them ------------------------------------------

const VALUES = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example.test/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc-request-token-5d1e",
  GITHUB_TOKEN: "ghs_fakeGithubTokenValue123",
  DV_LISTED_SECRET: "listed-secret-7c2a91",
  DV_LISTED_PLAIN: "listed-plain-a91f3c",
  DV_UNLISTED_SECRET: "unlisted-secret-4b8e03",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
  DV_PLAIN: "plain-value",
  DV_MONGO_URI: "mongodb://admin:pw-9e1c77@db1.prod:27017,db2.prod:27017/app",
  DV_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
};
const LISTED = ["DV_LISTED_SECRET", "DV_LISTED_PLAIN"];
// A multi-line value leaves a line at a time, so each line is what must not survive.
const SECRETS = [VALUES.ACTIONS_ID_TOKEN_REQUEST_TOKEN, VALUES.GITHUB_TOKEN, VALUES.DV_LISTED_SECRET, VALUES.DV_LISTED_PLAIN, VALUES.DV_UNLISTED_SECRET, VALUES.DV_MONGO_URI, ...VALUES.DV_PRIVATE_KEY.split("\n")];

function withEnv(extra: Record<string, string> = {}): () => void {
  const vars = { ...VALUES, ...extra };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const planTest = (t: Partial<PlanTest> & Pick<PlanTest, "id" | "path">): PlanTest => ({
  content: null,
  criterionIds: ["1"],
  level: "unit",
  levelReason: "",
  origin: "generated",
  runner: "node-test",
  testSignature: t.id,
  strategyVersion: 1,
  targetFiles: [],
  ...t,
});

const planOf = (tests: PlanTest[]): RunnerPlan => ({
  planId: "plan-env",
  criteriaRevision: 1,
  criteria: [{ id: "1", text: "env", kind: "code" }],
  tests,
  commands: [],
  playwright: { record: true, configFrom: null, installBrowsers: false },
  retries: { generated: 0, existing: 0 },
  uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 20 },
});

const nodeTest = (body: string) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`;

test("a generated unit test runs without the runner's credentials or unlisted secrets; the repo's own test keeps them; every log and error leaves scrubbed", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dv-env-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  mkdirSync(path.join(root, "test"));
  writeFileSync(
    path.join(root, "test/own.test.mjs"),
    nodeTest(`test("own", () => {
  console.log("existing saw " + process.env.DV_UNLISTED_SECRET + " " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN + " " + process.env.GITHUB_TOKEN + " " + process.env.DV_MONGO_URI);
  console.log(process.env.DV_PRIVATE_KEY);
  assert.equal(process.env.DV_UNLISTED_SECRET, ${JSON.stringify(VALUES.DV_UNLISTED_SECRET)});
  assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, ${JSON.stringify(VALUES.ACTIONS_ID_TOKEN_REQUEST_TOKEN)});
  assert.equal(process.env.GITHUB_TOKEN, ${JSON.stringify(VALUES.GITHUB_TOKEN)});
});`)
  );
  const generated = nodeTest(`test("generated", () => {
  console.log("generated saw " + process.env.DV_LISTED_SECRET + " " + process.env.DV_LISTED_PLAIN);
  for (const k of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN", "DV_UNLISTED_SECRET", "DV_MONGO_URI"]) assert.equal(process.env[k], undefined, k);
  assert.equal(process.env.DV_LISTED_SECRET, ${JSON.stringify(VALUES.DV_LISTED_SECRET)});
  assert.equal(process.env.DATABASE_URL, ${JSON.stringify(VALUES.DATABASE_URL)});
  assert.equal(process.env.DV_PLAIN, "plain-value");
});`);
  const leaky = nodeTest(`test("leaky", () => { assert.equal(process.env.DV_LISTED_SECRET, "something else"); });`);
  const needy = nodeTest(`test("needy", () => { if (!process.env.DV_UNLISTED_SECRET) throw new Error("DV_UNLISTED_SECRET is not set"); });`);
  const restore = withEnv();
  const ws = new Workspace(root);
  const printed: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  let out: Awaited<ReturnType<typeof executePlan>>;
  try {
    out = await executePlan(
      planOf([
        planTest({ id: "gen", path: ".devasign/tests/env.test.mjs", content: generated }),
        planTest({ id: "leak", path: ".devasign/tests/leak.test.mjs", content: leaky }),
        planTest({ id: "needy", path: ".devasign/tests/needy.test.mjs", content: needy }),
        planTest({ id: "own", path: "test/own.test.mjs", origin: "existing" }),
      ]),
      ws,
      { yml: { env: LISTED }, testTimeoutMs: 30_000, setup: undefined }
    );
  } finally {
    Object.assign(console, saved);
    restore();
  }
  try {
    const byId = new Map(out.results.map((r) => [r.testId, r]));
    const why = JSON.stringify(out.results.map((r) => [r.testId, r.status, r.error]));
    assert.equal(byId.get("gen")?.status, "pass", why);
    assert.equal(byId.get("own")?.status, "pass", why);
    assert.equal(byId.get("leak")?.status, "fail", why);
    assert.match(byId.get("leak")!.error!, /\[redacted\]/, "the failure still says what it compared");
    assert.equal(byId.get("needy")?.status, "error", why);
    assert.match(byId.get("needy")!.error!, /\(withheld from generated tests: DV_UNLISTED_SECRET; list under verify\.env to pass through\)$/, "a test that died for a withheld variable says so in its own error");
    assert.doesNotMatch(byId.get("leak")!.error!, /withheld from generated tests/, "only a failure that names a withheld variable gets the note");

    const logs = out.artifacts.filter((a) => a.kind === "log").map((a) => [a.testId, readFileSync(a.path, "utf8")] as const);
    assert.deepEqual(logs.map(([id]) => id).sort(), ["gen", "leak", "needy", "own"]);
    const jobLog = printed.join("\n");
    for (const secret of SECRETS) {
      for (const [id, text] of logs) assert.ok(!text.includes(secret), `${id}'s log artifact holds ${secret}:\n${text}`);
      assert.ok(!jobLog.includes(secret), `the job log holds ${secret}`);
      assert.ok(!JSON.stringify(out.results).includes(secret), `a result holds ${secret}`);
    }
    assert.match(new Map(logs).get("gen")!, /generated saw \[redacted\] \[redacted\]/);
    assert.match(new Map(logs).get("own")!, /existing saw \[redacted\] \[redacted\] \[redacted\] \[redacted\]/, "a credential URL is scrubbed whatever its name");
    assert.match(jobLog, /generated saw \[redacted\] \[redacted\]/, "the job log is scrubbed line by line");

    const notice = /withheld from generated tests: (.*) — list a name under verify\.env/.exec(jobLog);
    assert.ok(notice, jobLog);
    const names = notice[1].split(", ");
    assert.ok(names.includes("DV_UNLISTED_SECRET"), notice[0]);
    for (const n of ["DV_LISTED_SECRET", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN", "DATABASE_URL"]) assert.ok(!names.includes(n), `${n} is not a withheld repo secret: ${notice[0]}`);
  } finally {
    ws.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const SETUP: DetectedSetup = { languages: ["typescript"], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] };

// The app writes which of the job's variables it started with, one JSON line per start.
async function browserRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "dv-env-pw-"));
  const [appPort, apiPort] = [await freePort(), await freePort()];
  const seenFile = path.join(root, "app-env.jsonl");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  // The repo's own specs resolve @playwright/test from its node_modules; ours is the same package.
  mkdirSync(path.join(root, "node_modules/@playwright"), { recursive: true });
  symlinkSync(ourPlaywrightDir(), path.join(root, "node_modules/@playwright/test"), "junction");
  const record = `require("fs").appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ oidc: "ACTIONS_ID_TOKEN_REQUEST_TOKEN" in process.env, unlisted: "DV_UNLISTED_SECRET" in process.env, listed: "DV_LISTED_SECRET" in process.env }) + "\\n");`;
  writeFileSync(path.join(root, "app.cjs"), `${record}\nrequire("http").createServer((q, s) => s.end("ok")).listen(${appPort}, "127.0.0.1");\n`);
  writeFileSync(path.join(root, "api.cjs"), `require("http").createServer((q, s) => s.end("api")).listen(${apiPort}, "127.0.0.1");\n`);
  mkdirSync(path.join(root, "e2e"));
  writeFileSync(
    path.join(root, "e2e/own.spec.ts"),
    `import { test, expect } from "@playwright/test";\ntest("own", async () => {\n  expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(${JSON.stringify(VALUES.ACTIONS_ID_TOKEN_REQUEST_TOKEN)});\n  expect(process.env.DV_UNLISTED_SECRET).toBe(${JSON.stringify(VALUES.DV_UNLISTED_SECRET)});\n});\n`
  );
  const node = (file: string) => `node ${JSON.stringify(path.join(root, file))}`;
  const app = { start: node("app.cjs"), url: `http://127.0.0.1:${appPort}` };
  const api = { name: "api", start: node("api.cjs"), url: `http://127.0.0.1:${apiPort}` };
  const launches = () => readFileSync(seenFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { root, app, api, launches };
}

// Checked at load too: Playwright imports spec files in its own process to list them, before any worker.
const generatedSpec = (unlisted: string | null) =>
  [
    'import { test, expect } from "@playwright/test";',
    "const loaded = { oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? null, unlisted: process.env.DV_UNLISTED_SECRET ?? null };",
    'test("generated", async ({ baseURL }) => {',
    `  expect(loaded).toEqual({ oidc: null, unlisted: ${JSON.stringify(unlisted)} });`,
    '  for (const k of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN"]) expect(process.env[k], k).toBeUndefined();',
    `  expect(process.env.DV_UNLISTED_SECRET ?? null).toBe(${JSON.stringify(unlisted)});`,
    `  expect(process.env.DV_LISTED_SECRET).toBe(${JSON.stringify(VALUES.DV_LISTED_SECRET)});`,
    '  expect(await (await fetch(baseURL + "/")).text()).toBe("ok");',
    "});",
    "",
  ].join("\n");

async function runBrowserPlan(root: string, tests: PlanTest[], yml: NonNullable<Parameters<typeof executePlan>[2]["yml"]>) {
  const restore = withEnv();
  const ws = new Workspace(root);
  try {
    const out = await executePlan(planOf(tests), ws, { yml, testTimeoutMs: 60_000, setup: SETUP });
    const logs = out.artifacts.filter((a) => a.kind === "log").map((a) => readFileSync(a.path, "utf8")).join("\n");
    return { out, logs, byId: new Map(out.results.map((r) => [r.testId, r])) };
  } finally {
    restore();
    ws.cleanup();
  }
}

test("when Playwright starts the app, generated specs lose only the runner's credentials, the app keeps its secrets, and the repo's own specs keep everything", { timeout: 120_000 }, async () => {
  const repo = await browserRepo();
  try {
    const { out, logs, byId } = await runBrowserPlan(
      repo.root,
      [
        planTest({ id: "gen", path: ".devasign/tests/e2e/env.spec.ts", content: generatedSpec(VALUES.DV_UNLISTED_SECRET), runner: "playwright", level: "e2e" }),
        planTest({ id: "own", path: "e2e/own.spec.ts", origin: "existing", runner: "playwright", level: "e2e" }),
      ],
      { ...repo.app, env: LISTED }
    );
    assert.equal(out.doctor, null, logs);
    assert.equal(byId.get("gen")?.status, "pass", logs);
    assert.equal(byId.get("own")?.status, "pass", logs);
    assert.deepEqual(repo.launches(), [
      { oidc: false, unlisted: true, listed: true },
      { oidc: true, unlisted: true, listed: true },
    ]);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("under a managed boot the runner starts the app with the job's environment, and generated specs get only what verify.env names", { timeout: 120_000 }, async () => {
  const repo = await browserRepo();
  try {
    const { out, logs, byId } = await runBrowserPlan(
      repo.root,
      [planTest({ id: "gen", path: ".devasign/tests/e2e/env.spec.ts", content: generatedSpec(null), runner: "playwright", level: "e2e" })],
      { ...repo.app, servers: [repo.api], env: LISTED }
    );
    assert.equal(out.doctor, null, logs);
    assert.equal(byId.get("gen")?.status, "pass", logs);
    assert.deepEqual(repo.launches(), [{ oidc: true, unlisted: true, listed: true }]);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
