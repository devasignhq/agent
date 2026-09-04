// node --import tsx/esm --test src/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateAttempts, classifyAttempt, classifyPlaywrightError } from "./classify.js";

const r = (code: number | null, output: string, extra: Partial<{ timedOut: boolean; spawnError: string }> = {}) => ({ code, timedOut: false, output, ...extra });

test("assertion evidence → fail; infrastructure failures → error; exit 0 → pass", () => {
  assert.equal(classifyAttempt("node-test", r(1, "TAP version 13\nnot ok 1 - refunds\n  AssertionError: expected 1 to equal 2\n# fail 1")).status, "fail");
  assert.equal(classifyAttempt("node-test", r(1, "node:internal/modules/esm/resolve\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '../src/x.js'")).status, "error");
  assert.equal(classifyAttempt("node-test", r(0, "TAP version 13\n# tests 1\n# pass 1")).status, "pass");
  assert.equal(classifyAttempt("node-test", r(0, "TAP version 13\n# tests 0\n# pass 0")).status, "error", "zero tests is not a pass");
  assert.equal(classifyAttempt("vitest", r(1, " FAIL  src/a.test.ts > total\nAssertionError: expected '$1' to be '$2'\n Tests  1 failed | 0 passed")).status, "fail");
  assert.equal(classifyAttempt("jest", r(1, "  ● total › formats\n    expect(received).toBe(expected)\nTests:       1 failed, 0 passed")).status, "fail");
  assert.equal(classifyAttempt("pytest", r(1, "FAILED tests/test_a.py::test_x - AssertionError\n1 failed in 0.1s")).status, "fail");
  assert.equal(classifyAttempt("pytest", r(2, "ERROR collecting tests/test_a.py\nModuleNotFoundError: No module named 'app'")).status, "error");
  assert.equal(classifyAttempt("go", r(1, "--- FAIL: TestX (0.00s)\nFAIL")).status, "fail");
  assert.equal(classifyAttempt("go", r(2, "# pkg\n./a_test.go:3: undefined: x\nFAIL pkg [build failed]")).status, "error");
  assert.equal(classifyAttempt("node-test", r(null, "", { timedOut: true })).status, "error");
  assert.equal(classifyAttempt("vitest", r(null, "", { spawnError: "spawn npx ENOENT" })).status, "error");
  assert.equal(classifyAttempt("node-test", r(1, "[31mnot ok 1 - x[39m")).status, "fail", "ANSI is stripped first");
});

test("Playwright: expect timeouts are assertion failures; action/boot errors are not", () => {
  assert.equal(classifyPlaywrightError("Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('refunds')\nExpected: visible\nTimeout: 2000ms"), "fail");
  assert.equal(classifyPlaywrightError("Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/"), "error");
  assert.equal(classifyPlaywrightError("Error: Process from config.webServer was not able to start. Exit code: 1"), "error");
  assert.equal(classifyPlaywrightError("browserType.launch: Executable doesn't exist at /ms-playwright/chromium"), "error");
  assert.equal(classifyPlaywrightError("Error: Test timeout of 30000ms exceeded."), "error");
});

test("aggregate: pass-after-retry → flaky, fail every attempt → fail, error only → error", () => {
  assert.equal(aggregateAttempts(["pass"]), "pass");
  assert.equal(aggregateAttempts(["fail", "pass"]), "flaky");
  assert.equal(aggregateAttempts(["error", "pass"]), "flaky");
  assert.equal(aggregateAttempts(["fail", "fail", "fail"]), "fail");
  assert.equal(aggregateAttempts(["fail", "error"]), "fail");
  assert.equal(aggregateAttempts(["error", "error"]), "error");
  assert.equal(aggregateAttempts([]), "error");
});
