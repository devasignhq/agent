// node --import tsx/esm --test src/doctor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosePlaywrightOutput, preflight } from "./doctor.js";
import type { PlanTest } from "./types.js";

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
