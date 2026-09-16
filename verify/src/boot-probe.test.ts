// The pure parts of the setup PR's boot check. Run:
//   node --import tsx/esm --test src/boot-probe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootAndLoad, bootSpecSource, loginReport, readyUrlOf, stageForPage, stageForStep, summaryMarkdown } from "./boot-probe.js";
import type { BootStepResult } from "./boot.js";
import { Workspace } from "./workspace.js";
import type { BootReport, DetectedSetup, DevasignVerifyConfig } from "./types.js";

const servers: BootStepResult[] = [
  { name: "api", kind: "server", ok: false, exitCode: 1 },
  { name: "install", kind: "setup", ok: true },
];

const report = (over: Partial<BootReport> = {}): BootReport => ({
  sha: "a".repeat(40),
  ok: true,
  stage: "done",
  durationMs: 4_100,
  cliVersion: "1.7.0",
  servers: [],
  ...over,
});

// The shape bootManaged returns, narrowed to what loginReport reads.
const boot = (over: Record<string, unknown>) => over as Awaited<ReturnType<typeof import("./boot.js").bootManaged>>;

test("stageForStep tells a fixed step from a server the maintainer named", () => {
  assert.equal(stageForStep(null, servers), "config");
  assert.equal(stageForStep("install", servers), "install");
  assert.equal(stageForStep("build", servers), "install");
  assert.equal(stageForStep("seed", servers), "install");
  assert.equal(stageForStep("app", servers), "start");
  assert.equal(stageForStep("login", servers), "login");
  assert.equal(stageForStep("api", servers), "servers");
  assert.equal(stageForStep("web", servers), "start", "a step this boot never had is not a server");
});

test("DevAsign's own browser install failing is not the repo's page failing", () => {
  assert.equal(stageForPage(true, null), "done");
  assert.equal(stageForPage(false, { stage: "start", code: "app_not_ready", message: "x" }), "page");
  assert.equal(stageForPage(false, null), "page");
  assert.equal(stageForPage(false, { stage: "browsers", code: "browser_install_failed", message: "Playwright's Chromium is not installed on this runner" }), "browsers");
});

test("readyUrlOf resolves ready against the app url, and survives a url it cannot parse", () => {
  assert.equal(readyUrlOf({ url: "http://localhost:3001", ready: "/health" } as DevasignVerifyConfig), "http://localhost:3001/health");
  assert.equal(readyUrlOf({ url: "http://localhost:3001/app" } as DevasignVerifyConfig), "http://localhost:3001/");
  assert.equal(readyUrlOf({ url: "http://localhost:3001", ready: "http://other.test/up" } as DevasignVerifyConfig), "http://other.test/up");
  assert.equal(readyUrlOf({ url: "not a url", ready: "/health" } as DevasignVerifyConfig), "not a url");
});

test("the boot spec JSON-escapes every path it writes into the generated test", () => {
  const src = bootSpecSource({ url: 'http://localhost:3001/a"b', pageFile: 'C:\\tmp\\page".json', shotFile: "/tmp/shot.png" });
  assert.match(src, /page\.goto\("http:\/\/localhost:3001\/a\\"b"/);
  assert.match(src, /writeFileSync\("C:\\\\tmp\\\\page\\"\.json"/);
  assert.match(src, /path: "\/tmp\/shot\.png"/);
});

test("a login that never ran is absent from the report, not reported as failed", () => {
  const yml = { login: { script: "node login.mjs" } } as DevasignVerifyConfig;
  // The api server died first: the login script was never executed.
  assert.equal(loginReport(yml, boot({ ok: false, failedStep: "api", check: null })), undefined);
  assert.equal(loginReport({} as DevasignVerifyConfig, boot({ ok: true, check: null })), undefined, "no script, nothing to say");
  assert.deepEqual(loginReport(yml, boot({ ok: false, failedStep: "login", check: { status: 401 } })), { ran: true, checked: true, ok: false, checkStatus: 401 });
  assert.deepEqual(loginReport(yml, boot({ ok: true, check: null })), { ran: true, checked: false, ok: true });
});

test("the step summary blames the login script only when it ran", () => {
  const stopped = summaryMarkdown(report({ ok: false, stage: "servers", failedServer: "api", diagnosis: { stage: "start", code: "app_not_ready", message: "the api server exited before it was ready" } }), null);
  assert.match(stopped, /stopped at `servers\/api`/);
  assert.doesNotMatch(stopped, /login script/, "a login that never ran is not what went wrong");

  const failed = summaryMarkdown(report({ ok: false, stage: "login", login: { ran: true, checked: false, ok: false } }), "http://localhost:3001");
  assert.match(failed, /The app came up in 4\.1s, but signing in did not work\./);
  assert.match(failed, /The login script did not produce a usable session\./);

  const checked = summaryMarkdown(report({ ok: false, stage: "login", login: { ran: true, checked: true, ok: false, checkStatus: 401 } }), null);
  assert.match(checked, /The session check answered 401\./);
  assert.doesNotMatch(checked, /did not produce a usable session/, "the script worked; the check did not");
});

test("a boot that never comes up does not pay for a Chromium download first", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-probe-unit-"));
  const ws = new Workspace(root);
  const setup: DetectedSetup = { languages: ["ts"], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] };
  let installs = 0;
  try {
    const collected = await bootAndLoad({
      api: {} as never,
      probe: { probeId: "p1", uploadLimits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1 } },
      ws,
      // The api server exits before it is ready, so the page step is unreachable.
      yml: { start: "exit 0", url: "http://127.0.0.1:59999", timeout: 5, servers: [{ name: "api", start: "exit 3", url: "http://127.0.0.1:59998" }] } as DevasignVerifyConfig,
      setup,
      sha: "b".repeat(40),
      keep: false,
      testTimeoutMs: 5_000,
      ensureBrowsersImpl: async () => {
        installs += 1;
        return { ok: true, log: "" };
      },
    });
    assert.equal(collected.report.ok, false);
    assert.equal(collected.report.stage, "servers");
    assert.equal(installs, 0, "the browser is only needed by the page step, which this boot never reaches");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the step summary does not say the app failed to start when it started", () => {
  const page = summaryMarkdown(report({ ok: false, stage: "page", page: { status: 500 } }), "http://localhost:3001");
  assert.match(page, /The app came up in 4\.1s, but the page did not load\./);
  assert.match(page, /The page answered 500\./);
  assert.doesNotMatch(page, /did not come up/);

  const browsers = summaryMarkdown(report({ ok: false, stage: "browsers", page: { status: null }, diagnosis: { stage: "browsers", code: "browser_install_failed", message: "Playwright's Chromium is not installed on this runner" } }), null);
  assert.match(browsers, /DevAsign could not install its own browser/);
  assert.doesNotMatch(browsers, /did not come up/, "DevAsign's own install is not the repo's boot config");

  const up = summaryMarkdown(report({ login: { ran: true, checked: true, ok: true, checkStatus: 200 } }), "http://localhost:3001");
  assert.match(up, /The app came up at http:\/\/localhost:3001 in 4\.1s\./);
  assert.match(up, /Signed in \(session check answered 200\)\./);
});
