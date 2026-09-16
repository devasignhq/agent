// node --import tsx/esm --test src/doctor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseMissingDependencies, diagnosePlaywrightOutput, preflight } from "./doctor.js";
import type { PlanTest, RunnerResult } from "./types.js";

const pw = { runner: "playwright" } as PlanTest;
const setup = { languages: [], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] as never[] };

test("missing secrets are reported by name only; no start command; runtime mismatch", () => {
  const missing = preflight({ tests: [pw], setup, yml: { env: ["DATABASE_URL", "API_KEY"], start: "x", url: "http://y" }, repoHasPlaywrightConfig: false, env: { API_KEY: "s3cret-value" }, nodeVersion: "v20.1.0" });
  assert.equal(missing?.code, "missing_secret");
  assert.deepEqual(missing?.missingSecrets, ["DATABASE_URL"]);
  assert.doesNotMatch(JSON.stringify(missing), /s3cret-value/, "values never leave the runner");
  const noStart = preflight({ tests: [pw], setup, yml: null, repoHasPlaywrightConfig: false, env: {}, nodeVersion: "v20.1.0" });
  assert.equal(noStart?.code, "no_start_command");
  assert.match(noStart!.suggestedFix!.patch!, /verify:\n  start:/);
  assert.equal(preflight({ tests: [pw], setup, yml: null, repoHasPlaywrightConfig: true, env: {}, nodeVersion: "v20.1.0" }), null, "a playwright.config implies boot config");
  assert.equal(preflight({ tests: [], setup, yml: null, repoHasPlaywrightConfig: false, env: {}, nodeVersion: "v20.1.0" }), null, "no e2e planned, nothing to diagnose");
  const rt = preflight({ tests: [pw], setup: { ...setup, nodeVersion: ">=22" }, yml: { start: "x", url: "http://y" }, repoHasPlaywrightConfig: false, env: {}, nodeVersion: "v20.11.0" });
  assert.equal(rt?.code, "wrong_runtime_version");
  assert.equal(preflight({ tests: [pw], setup: { ...setup, nodeVersion: ">=20" }, yml: { start: "x", url: "http://y" }, repoHasPlaywrightConfig: false, env: {}, nodeVersion: "v22.1.0" }), null);
});

test("Playwright output maps to browser/boot diagnoses", () => {
  assert.equal(diagnosePlaywrightOutput("browserType.launch: Executable doesn't exist at /x")?.code, "browser_install_failed");
  assert.equal(diagnosePlaywrightOutput("Error: Process from config.webServer was not able to start. Exit code: 1")?.code, "app_not_ready");
  assert.equal(diagnosePlaywrightOutput("page.goto: net::ERR_CONNECTION_REFUSED")?.code, "app_not_ready");
  assert.equal(diagnosePlaywrightOutput("1 failed"), null);
});

test("once the runner has booted the app, only a refusal at the app's own address blames the boot", () => {
  const app = "http://localhost:3001";
  const at = (url: string) => `page.goto: net::ERR_CONNECTION_REFUSED at ${url}\n`;
  assert.equal(diagnosePlaywrightOutput(at("http://localhost:3001/dashboard"), app)?.code, "app_not_ready");
  assert.equal(diagnosePlaywrightOutput(at("http://127.0.0.1:3001/"), app)?.code, "app_not_ready", "the loopback name changes, the port does not");
  assert.equal(diagnosePlaywrightOutput(at("http://localhost:4000/api/orders"), app), null, "another service the tests reached for is not the app");
  assert.equal(diagnosePlaywrightOutput("apiRequest: connect ECONNREFUSED 127.0.0.1:5432\n", app), null, "and neither is a database socket");
  assert.equal(diagnosePlaywrightOutput(`${at("http://localhost:4000/api")}${at("http://localhost:3001/")}`, app)?.code, "app_not_ready", "one refusal at the app is enough");
  assert.equal(diagnosePlaywrightOutput("page.goto: net::ERR_CONNECTION_REFUSED", app)?.code, "app_not_ready", "a refusal that names no address could be the app's");
  assert.equal(diagnosePlaywrightOutput(at("http://localhost:4000/api"))?.code, "app_not_ready", "without a booted app there is nothing to compare against");
});

function errored(error: string): RunnerResult {
  return { id: "r-1", testId: "1", criterionIds: ["1"], test: ".devasign/tests/a.test.ts", runner: "node-test", level: "unit", origin: "generated", status: "error", attempts: [{ n: 1, status: "error", durationMs: 1, error, artifactIds: [] }], durationMs: 1, error, artifactIds: [] };
}

test("a test that died loading a bare package from a package whose node_modules is absent is a missing_dependencies diagnosis", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-doc-"));
  for (const rel of ["backend/package.json", "backend/package-lock.json", "frontend/package.json"]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "{}");
  }
  const node = errored(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dotenv' imported from ${path.join(root, "backend/src/config.ts")}`);
  const jest = errored("Cannot find module '@anthropic-ai/sdk/core' from 'frontend/src/api.ts'");
  const d = diagnoseMissingDependencies([node, jest], root)!;
  assert.equal(d.code, "missing_dependencies");
  assert.equal(d.stage, "install");
  assert.deepEqual(d.packages, [{ dir: "backend", install: "npm ci --prefix backend" }, { dir: "frontend", install: "npm install --prefix frontend" }]);
  assert.match(d.message, /backend\/ \(dotenv\); frontend\/ \(@anthropic-ai\/sdk\)/);
  assert.match(d.suggestedFix!.instructions, /`npm ci --prefix backend`, `npm install --prefix frontend`/);

  // A relative import of nothing is a wrong test, not a missing install; an installed package dir is fine.
  assert.equal(diagnoseMissingDependencies([errored(`Cannot find module '${path.join(root, ".devasign/tests/tests-view.ts")}' imported from ${path.join(root, ".devasign/tests/a.test.ts")}`)], root), null);
  mkdirSync(path.join(root, "backend/node_modules"));
  assert.equal(diagnoseMissingDependencies([node], root), null);
  assert.equal(diagnoseMissingDependencies([errored("AssertionError: 1 !== 2")], root), null);
});
