// A branch cut before onboarding has no .devasign.yml; the runner boots from the plan's copy.
//   node --import tsx/esm --test src/run-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./run.js";
import { staticTokenSource } from "./oidc.js";
import type { ResolveRequest, RunnerPlan, RunnerResults } from "./types.js";

const MISSING = "DEVASIGN_RUN_CONFIG_TEST_UNSET";

const plan = (verifyConfig?: RunnerPlan["verifyConfig"]): RunnerPlan => ({
  planId: "plan-boot",
  criteriaRevision: 1,
  criteria: [{ id: "1", text: "The pill offers a shape toggle", kind: "ui" }],
  tests: [
    {
      id: "t1",
      path: ".devasign/tests/e2e/pill.spec.ts",
      content: 'import { test } from "@playwright/test";\ntest("pill", async () => {});\n',
      criterionIds: ["1"],
      level: "e2e",
      levelReason: "",
      origin: "generated",
      runner: "playwright",
      testSignature: "s",
      strategyVersion: 1,
      targetFiles: [],
    },
  ],
  commands: [],
  playwright: { record: true, configFrom: null, installBrowsers: true },
  retries: { generated: 0, existing: 0 },
  uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 10 },
  unverifiable: [],
  ...(verifyConfig ? { verifyConfig } : {}),
});

async function doctorFor(p: RunnerPlan): Promise<RunnerResults["doctor"]> {
  const dir = mkdtempSync(path.join(tmpdir(), "dv-boot-"));
  writeFileSync(path.join(dir, "index.html"), "<main></main>\n");
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(p));
  const out = path.join(dir, "results.json");
  try {
    const code = await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 30_000, keep: false, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out });
    assert.equal(code, 0);
    return JSON.parse(readFileSync(out, "utf8")).doctor;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a checkout without a verify block boots the app from the one the plan carries", async () => {
  delete process.env[MISSING];
  // An env var the job lacks stops preflight before any browser spawns, and it can only
  // come from the plan's block — so the diagnosis says which block the runner used.
  const doctor = await doctorFor(plan({ start: "npm run dev", url: "http://localhost:5173", env: [MISSING] }));
  assert.equal(doctor?.code, "missing_secret");
  assert.deepEqual(doctor?.missingSecrets, [MISSING]);
});

test("with no verify block anywhere, the runner still reports that nothing tells it how to start the app", async () => {
  const doctor = await doctorFor(plan());
  assert.equal(doctor?.code, "no_start_command");
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function canBind(port: number): Promise<boolean> {
  const srv = net.createServer();
  return new Promise((resolve) => {
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

const node = (file: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;

// Servers a regression failed to stop would keep this file's event loop alive; kill them so a failure reports instead of hanging.
const killLeftovers = (dir: string) => spawnSync("pkill", ["-KILL", "-f", dir]);
const SECRET_NAME = "DV_RUN_CONFIG_TEST_TOKEN";
const SECRET = "tok-9f8e7d6c5b4a39281706";

// A cached "browser" keeps ensureBrowsers offline; none of these tests opens a page.
function withBootEnv(): () => void {
  const saved = { browsers: process.env.PLAYWRIGHT_BROWSERS_PATH, secret: process.env[SECRET_NAME] };
  const browsers = mkdtempSync(path.join(tmpdir(), "dv-browsers-"));
  mkdirSync(path.join(browsers, "chromium-1"));
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  process.env[SECRET_NAME] = SECRET;
  return () => {
    for (const [k, v] of [["PLAYWRIGHT_BROWSERS_PATH", saved.browsers], [SECRET_NAME, saved.secret]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(browsers, { recursive: true, force: true });
  };
}

test("a managed boot whose server exits is an app_not_ready diagnosis: browser tests error, logs upload redacted, the job exits 0", async () => {
  const restore = withBootEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "dv-managed-fail-"));
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const p = plan({
    start: `echo app should never start; exit 1`,
    url: `http://127.0.0.1:${appPort}`,
    servers: [{ name: "api", start: `echo "api token=$${SECRET_NAME}"; exit 3`, url: `http://127.0.0.1:${apiPort}` }],
  });
  const resolves: ResolveRequest[] = [];
  const puts = new Map<string, string>();
  let posted: RunnerResults | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/runs/resolve") {
      resolves.push(JSON.parse(String(init?.body)));
      return json({ ok: true, status: "ready", runId: "run-1", plan: p });
    }
    if (url.pathname === "/v1/runs/run-1/artifacts") {
      const files: Array<{ clientRef: string }> = JSON.parse(String(init?.body)).files;
      return json({ ok: true, rejected: [], uploads: files.map((f) => ({ clientRef: f.clientRef, artifactId: `art:${f.clientRef}`, putUrl: `http://fake/put/${encodeURIComponent(f.clientRef)}`, headers: {}, urlExpiresAt: 0, retentionExpiresAt: 0 })) });
    }
    if (url.pathname.startsWith("/put/")) {
      puts.set(decodeURIComponent(url.pathname.slice(5)), Buffer.from(init?.body as Uint8Array).toString("utf8"));
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/v1/runs/run-1/results") {
      posted = JSON.parse(String(init?.body));
      return json({ ok: true, runId: "run-1", status: "judging" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const code = await run({ apiUrl: "http://fake", token: staticTokenSource("t"), resolveTimeoutMs: 5_000, testTimeoutMs: 30_000, keep: false, cwd: dir, pr: 7, sha: "abc1234", fetchImpl });
    assert.equal(code, 0);
    assert.ok(resolves.length > 0);
    for (const r of resolves) assert.deepEqual(r.capabilities, ["managed_boot"], "every resolve says this runner can boot servers and sign in");
    const results = posted as RunnerResults | null;
    assert.ok(results, "results were posted");
    assert.equal(results.doctor?.code, "app_not_ready");
    assert.equal(results.doctor?.stage, "start");
    assert.match(results.doctor!.message, /the api server exited before it was ready/);
    assert.equal(results.doctor?.logArtifactId, "art:log:boot:api", "the diagnosis links the failed server's log");
    assert.equal(results.results.length, 1);
    assert.equal(results.results[0].status, "error");
    assert.equal(results.results[0].error, results.doctor!.message);
    const apiLog = puts.get("log:boot:api");
    assert.ok(apiLog, "the failed server's log was uploaded");
    assert.match(apiLog, /api token=\[redacted\]/);
    assert.ok(![...puts.values()].some((body) => body.includes(SECRET)), "no uploaded log carries the secret");
    assert.equal(puts.has("log:boot:app"), false, "the app never started after its api failed");
    assert.equal(existsSync(path.join(dir, ".devasign")), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managedBoot: false keeps Playwright's webServer, whose output reaches the Playwright log redacted", async () => {
  const restore = withBootEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "dv-managed-off-"));
  const [apiPort, appPort] = [await freePort(), await freePort()];
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    ...plan({
      start: `echo "legacy boot token=$${SECRET_NAME}"; exit 1`,
      url: `http://127.0.0.1:${appPort}`,
      servers: [{ name: "api", start: "exit 3", url: `http://127.0.0.1:${apiPort}` }],
      login: { script: "exit 1" },
    }),
    managedBoot: false,
  }));
  const out = path.join(dir, "results.json");
  try {
    const code = await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 60_000, keep: true, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out });
    assert.equal(code, 0);
    const results = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(results.doctor?.code, "app_not_ready");
    assert.doesNotMatch(results.doctor.message, /api server|login/, "the managed boot never ran");
    assert.equal(results.artifacts.some((a: any) => a.clientRef.startsWith("log:boot:")), false);
    assert.equal(existsSync(path.join(dir, ".devasign/artifacts/logs/boot-api.log")), false);
    const pwLog = readFileSync(path.join(dir, ".devasign/artifacts/logs/playwright.config.ts.log"), "utf8");
    assert.match(pwLog, /legacy boot token=\[redacted\]/, "the webServer's stdout is piped into the log");
    assert.ok(!pwLog.includes(SECRET));
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a managed boot starts every server, signs in, and runs generated tests against it with the session, not the repo's webServer", async () => {
  const restore = withBootEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "dv-managed-ok-"));
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const session = "sess-0a1b2c3d4e5f60718293";
  writeFileSync(path.join(dir, "api.cjs"), `require("http").createServer((q, s) => s.end("api")).listen(${apiPort}, "127.0.0.1");\n`);
  writeFileSync(
    path.join(dir, "app.cjs"),
    `require("http").createServer((q, s) => { if (q.url === "/me") { s.statusCode = (q.headers.cookie || "").includes("sid=${session}") ? 200 : 401; return s.end(); } s.end("<main>app</main>"); }).listen(${appPort}, "127.0.0.1");\n`
  );
  writeFileSync(
    path.join(dir, "login.cjs"),
    `require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: "${session}", domain: "127.0.0.1", path: "/" }], origins: [] }));\n`
  );
  // Spreading this webServer into the generated config would fail the run before any test.
  writeFileSync(path.join(dir, "playwright.config.ts"), `export default { webServer: { command: "exit 7", url: "http://127.0.0.1:${appPort}" } };\n`);
  const base = plan({
    start: node(path.join(dir, "app.cjs")),
    url: `http://127.0.0.1:${appPort}`,
    servers: [{ name: "api", start: node(path.join(dir, "api.cjs")), url: `http://127.0.0.1:${apiPort}` }],
    login: { script: node(path.join(dir, "login.cjs")), check: "/me" },
  });
  base.tests[0].content = [
    'import { test, expect } from "@playwright/test";',
    'import { readFileSync } from "node:fs";',
    'test("signed in", async ({ baseURL, storageState }) => {',
    `  expect(baseURL).toBe("http://127.0.0.1:${appPort}");`,
    '  const sid = JSON.parse(readFileSync(String(storageState), "utf8")).cookies[0].value;',
    '  console.log("session cookie " + sid);',
    '  expect((await fetch(baseURL + "/me", { headers: { cookie: "sid=" + sid } })).status).toBe(200);',
    `  expect(await (await fetch("http://127.0.0.1:${apiPort}/")).text()).toBe("api");`,
    "});",
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(base));
  const out = path.join(dir, "results.json");
  try {
    const code = await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 60_000, keep: true, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out });
    assert.equal(code, 0);
    const results = JSON.parse(readFileSync(out, "utf8"));
    const pwLog = readFileSync(path.join(dir, ".devasign/artifacts/logs/playwright.config.ts.log"), "utf8");
    assert.equal(results.doctor, null, pwLog);
    assert.equal(results.results[0].status, "pass", pwLog);
    assert.deepEqual(results.artifacts.filter((a: any) => a.clientRef.startsWith("log:boot:")).map((a: any) => a.clientRef).sort(), ["log:boot:api", "log:boot:app", "log:boot:login"]);
    assert.match(pwLog, /session cookie \[redacted\]/, "the test did print the session");
    assert.ok(!pwLog.includes(session), "the Playwright log is scrubbed of the session before upload");
    assert.equal(existsSync(path.join(dir, ".devasign/auth")), false, "the saved session is deleted even with --keep");
    assert.ok(await canBind(apiPort), "the api server was stopped");
    assert.ok(await canBind(appPort), "the app was stopped");
  } finally {
    killLeftovers(dir);
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout block without start boots with the plan's boot keys, and keeps its own other keys", async () => {
  const restore = withBootEnv();
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const planBlock = { start: "exit 1", url: `http://127.0.0.1:${appPort}`, servers: [{ name: "api", start: "exit 3", url: `http://127.0.0.1:${apiPort}` }] };
  const doctorWith = async (yml: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "dv-merge-"));
    writeFileSync(path.join(dir, ".devasign.yml"), yml);
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan(planBlock)));
    const out = path.join(dir, "results.json");
    try {
      assert.equal(await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 30_000, keep: false, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out }), 0);
      return JSON.parse(readFileSync(out, "utf8")).doctor as RunnerResults["doctor"];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    // Only the plan's servers could have produced this; the checkout block alone says no_start_command.
    const booted = await doctorWith("verify:\n  e2e: auto\n");
    assert.equal(booted?.code, "app_not_ready");
    assert.equal(booted?.message, "the api server exited before it was ready");
    delete process.env[MISSING];
    const ownEnv = await doctorWith(`verify:\n  e2e: auto\n  env: [${MISSING}]\n`);
    assert.equal(ownEnv?.code, "missing_secret", "env is not a boot key, so the checkout's own list applies");
    assert.deepEqual(ownEnv?.missingSecrets, [MISSING]);
  } finally {
    restore();
  }
});

test("when Playwright throws after a managed boot, the servers still stop, the session is deleted and the logs are scrubbed", async () => {
  const restore = withBootEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "dv-managed-throw-"));
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const session = "sess-throw-5f60718293a4b5c6";
  writeFileSync(path.join(dir, "api.cjs"), `require("http").createServer((q, s) => s.end("api")).listen(${apiPort}, "127.0.0.1");\n`);
  writeFileSync(path.join(dir, "app.cjs"), `require("http").createServer((q, s) => s.end("app")).listen(${appPort}, "127.0.0.1");\n`);
  // Signs in, then leaves a directory where the generated Playwright config must be written, so writing it throws.
  writeFileSync(
    path.join(dir, "login.cjs"),
    `const fs = require("fs");\nfs.mkdirSync(".devasign/playwright.config.ts", { recursive: true });\nconsole.log("signed in with ${session}");\nfs.writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: "${session}", domain: "127.0.0.1", path: "/" }], origins: [] }));\n`
  );
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan({
    start: `${node(path.join(dir, "app.cjs"))}; true`,
    url: `http://127.0.0.1:${appPort}`,
    servers: [{ name: "api", start: `${node(path.join(dir, "api.cjs"))}; true`, url: `http://127.0.0.1:${apiPort}` }],
    login: { script: node(path.join(dir, "login.cjs")) },
  })));
  try {
    await assert.rejects(
      run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 30_000, keep: true, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: path.join(dir, "results.json") }),
      /EISDIR|illegal operation on a directory/
    );
    assert.ok(await canBind(apiPort), "the api server was stopped from finally");
    assert.ok(await canBind(appPort), "the app was stopped from finally");
    assert.equal(existsSync(path.join(dir, ".devasign/auth")), false, "the saved session is deleted");
    const loginLog = readFileSync(path.join(dir, ".devasign/artifacts/logs/boot-login.log"), "utf8");
    assert.match(loginLog, /signed in with \[redacted\]/);
  } finally {
    killLeftovers(dir);
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
