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
  // A suite that never loaded prints the same " FAIL <file>" header as a real failure.
  const unloadable = classifyAttempt(
    "vitest",
    r(1, "⎯⎯ Failed Suites 1 ⎯⎯\n FAIL  .devasign/tests/a.test.ts [ .devasign/tests/a.test.ts ]\nError: Cannot find package '@testing-library/jest-dom/vitest' imported from '/r/.devasign/tests/a.test.ts'\n Test Files  1 failed (1)\n      Tests  no tests")
  );
  assert.equal(unloadable.status, "error", "a missing package is not a failed assertion");
  assert.match(unloadable.error ?? "", /Cannot find package '@testing-library\/jest-dom\/vitest'/, "the real cause, not 'assertion failed'");
  assert.equal(classifyAttempt("vitest", r(1, " FAIL  .devasign/tests/a.test.ts\nError: Failed to resolve import \"@testing-library/react\" from \".devasign/tests/a.test.ts\". Does the file exist?")).status, "error");
  assert.equal(classifyAttempt("jest", r(1, "  ● total › formats\n    expect(received).toBe(expected)\nTests:       1 failed, 0 passed")).status, "fail");
  assert.equal(classifyAttempt("pytest", r(1, "FAILED tests/test_a.py::test_x - AssertionError\n1 failed in 0.1s")).status, "fail");
  assert.equal(classifyAttempt("pytest", r(2, "ERROR collecting tests/test_a.py\nModuleNotFoundError: No module named 'app'")).status, "error");
  assert.equal(classifyAttempt("go", r(1, "--- FAIL: TestX (0.00s)\nFAIL")).status, "fail");
  assert.equal(classifyAttempt("go", r(2, "# pkg\n./a_test.go:3: undefined: x\nFAIL pkg [build failed]")).status, "error");
  assert.equal(classifyAttempt("node-test", r(null, "", { timedOut: true })).status, "error");
  assert.equal(classifyAttempt("vitest", r(null, "", { spawnError: "spawn npx ENOENT" })).status, "error");
  assert.equal(classifyAttempt("node-test", r(1, "[31mnot ok 1 - x[39m\n  AssertionError: expected 1 to equal 2")).status, "fail", "ANSI is stripped first");
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

// Real vitest 4 output from a repro of bishopBethel/fundsflow PR 23, trimmed. Every test
// here crashed; none asserted.
const VITEST_GROUPED_HOOK_CRASH = [
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  .devasign/tests/component/MoneyEdge.persistence.test.tsx > carrying the shape key through localStorage persistence > keeps the shape when the persisted state is saved and reloaded, with no migration invoked",
  " FAIL  .devasign/tests/component/MoneyEdge.persistence.test.tsx > carrying the shape key through JSON export > keeps a sharp shape verbatim in the exported chart JSON",
  "TypeError: localStorage.clear is not a function",
  " ❯ .devasign/tests/component/MoneyEdge.persistence.test.tsx:29:16",
  "     28| beforeEach(() => {",
  "     29|   localStorage.clear()",
  "       |                ^",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯",
  "",
  " Test Files  1 failed (1)",
  "      Tests  5 failed (5)",
].join("\n");

const VITEST_HELPER_CRASH = [
  " FAIL  .devasign/tests/src/store/useFlowStore.default-shape-key.test.ts > a line at its default shape > carries no shape key in its edge data when setEdgeShape was never called",
  "TypeError: Cannot read properties of undefined (reading 'data')",
  " ❯ .devasign/tests/src/store/useFlowStore.default-shape-key.test.ts:27:23",
  "     26|   it('carries no shape key in its edge data when setEdgeShape was neve…",
  "     27|     expect(seededEdge().data).toEqual({ amount: 100 })",
  "       |                       ^",
  "     28|     expect(Object.keys(seededEdge().data!)).not.toContain('shape')",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
  "      Tests  1 failed (1)",
].join("\n");

// The test mocked @xyflow/react and handed MoneyEdge no edges, so the throw lands in repo source.
const VITEST_SOURCE_CRASH = [
  " FAIL  .devasign/tests/components/MoneyEdge.defaultShape.test.tsx > the shape a never-touched line is drawn in > draws a bezier curve when the shape field is absent, exactly as before",
  "TypeError: Cannot read properties of undefined (reading 'map')",
  " ❯ maxEdgeAmount src/lib/edgeStyle.ts:61:31",
  "     60| export function maxEdgeAmount(edges: MoneyEdge[]) {",
  "     61|   return Math.max(1, ...edges.map((e) => usableAmount(e.data?.amount)))",
  "       |                               ^",
  " ❯ src/components/MoneyEdge.tsx:103:23",
  " ❯ renderWithHooks node_modules/react-dom/cjs/react-dom-server-legacy.node.development.js:5662:16",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
].join("\n");

test("vitest: a generated test that crashes is broken, not failed — even when the throw lands in repo source", () => {
  assert.deepEqual(classifyAttempt("vitest", r(1, VITEST_GROUPED_HOOK_CRASH)), {
    status: "error",
    error: "TypeError: localStorage.clear is not a function (at .devasign/tests/component/MoneyEdge.persistence.test.tsx:29:16)",
  });
  // The source excerpt quotes the test's expect() calls; that is not evidence either.
  assert.deepEqual(classifyAttempt("vitest", r(1, VITEST_HELPER_CRASH)), {
    status: "error",
    error: "TypeError: Cannot read properties of undefined (reading 'data') (at .devasign/tests/src/store/useFlowStore.default-shape-key.test.ts:27:23)",
  });
  assert.deepEqual(classifyAttempt("vitest", r(1, VITEST_SOURCE_CRASH)), {
    status: "error",
    error: "TypeError: Cannot read properties of undefined (reading 'map') (at src/lib/edgeStyle.ts:61:31)",
  });
  const dom = " FAIL  .devasign/tests/dom.test.ts > renders a node\nReferenceError: document is not defined\n ❯ .devasign/tests/dom.test.ts:3:14";
  assert.equal(classifyAttempt("vitest", r(1, dom)).status, "error", "a missing DOM global is the environment, not the PR");
});

test("vitest: real assertion failures still fail, and one among crashes is enough", () => {
  const failed = (message: string) => classifyAttempt("vitest", r(1, ` FAIL  .devasign/tests/a.test.ts > a\n${message}\n ❯ .devasign/tests/a.test.ts:3:17`));
  assert.deepEqual(failed("AssertionError: expected 2 to be 3 // Object.is equality"), { status: "fail", error: "AssertionError: expected 2 to be 3 // Object.is equality" });
  assert.equal(failed("AssertionError: expected { amount: 100, shape: 'sharp' } to deeply equal { amount: 100 }").status, "fail");
  assert.equal(failed('AssertionError: promise resolved "1" instead of rejecting').status, "fail");
  assert.equal(failed("Error: expected number of assertions to be 1, but got 0").status, "fail", "expect.assertions is an assertion");
  const mixed = [
    " FAIL  .devasign/tests/mixed.test.ts > crashes",
    "TypeError: Cannot read properties of undefined (reading 'y')",
    " ❯ .devasign/tests/mixed.test.ts:4:12",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
    " FAIL  .devasign/tests/mixed.test.ts > asserts",
    "AssertionError: expected 'curved' to be 'sharp' // Object.is equality",
  ].join("\n");
  assert.deepEqual(classifyAttempt("vitest", r(1, mixed)), { status: "fail", error: "AssertionError: expected 'curved' to be 'sharp' // Object.is equality" });
  const coloured = "[41m[1m FAIL [22m[49m .devasign/tests/a.test.ts > a\n[31mAssertionError[39m: expected 1 to be 2";
  assert.equal(classifyAttempt("vitest", r(1, coloured)).status, "fail", "colour codes are stripped before parsing");
});

test("vitest: a throw that escapes an otherwise passing test is an error", () => {
  const out = [
    "⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯",
    "",
    "Vitest caught 1 unhandled error during the test run.",
    "",
    "⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯",
    "Error: late failure",
    " ❯ Timeout._onTimeout .devasign/tests/unhandled.test.ts:3:28",
    " ❯ listOnTimeout node:internal/timers:605:17",
    "",
    "      Tests  1 passed (1)",
    "     Errors  1 error",
  ].join("\n");
  assert.deepEqual(classifyAttempt("vitest", r(1, out)), { status: "error", error: "Error: late failure (at .devasign/tests/unhandled.test.ts:3:28)" });
});

// Real jest 29 output, trimmed.
const JEST_CRASH = [
  "FAIL ./crash.test.js",
  "  a line at its default shape",
  "    ✕ carries no shape key (1 ms)",
  "",
  "  ● a line at its default shape › carries no shape key",
  "",
  "    TypeError: Cannot read properties of undefined (reading 'data')",
  "",
  "      3 |   test('carries no shape key', () => {",
  "    > 4 |     expect(seeded().data).toEqual({ amount: 100 })",
  "        |                    ^",
  "",
  "      at Object.<anonymous> (crash.test.js:4:20)",
  "",
  "Tests:       1 failed, 1 total",
].join("\n");

test("jest: the error a test died of decides, not the expect() calls its source excerpt quotes", () => {
  assert.deepEqual(classifyAttempt("jest", r(1, JEST_CRASH)), { status: "error", error: "TypeError: Cannot read properties of undefined (reading 'data') (at crash.test.js:4:20)" });
  const dom = [
    "  ● renders a node",
    "",
    "    The error below may be caused by using the wrong test environment, see https://jestjs.io/docs/configuration#testenvironment-string.",
    '    Consider using the "jsdom" test environment.',
    "",
    "    ReferenceError: document is not defined",
    "",
    "    > 2 |   const el = document.createElement('div')",
    "",
    "      at Object.document (dom.test.js:2:14)",
  ].join("\n");
  assert.deepEqual(classifyAttempt("jest", r(1, dom)), { status: "error", error: "ReferenceError: document is not defined (at dom.test.js:2:14)" });
  const unloadable = [
    "  ● Test suite failed to run",
    "",
    "    Cannot find module './missing' from 'unloadable.test.js'",
    "",
    "    > 1 | const { total } = require('./missing')",
    "",
    "      at Resolver._throwModNotFoundError (../../node_modules/jest-resolve/build/resolver.js:427:11)",
    "      at Object.require (unloadable.test.js:1:19)",
  ].join("\n");
  // The runner stops retrying on "Cannot find module", so the message must keep it.
  assert.deepEqual(classifyAttempt("jest", r(1, unloadable)), { status: "error", error: "Cannot find module './missing' from 'unloadable.test.js' (at unloadable.test.js:1:19)" });
  const asserted = (header: string) => classifyAttempt("jest", r(1, `  ● adds\n\n    ${header}\n\n    Expected: 3\n    Received: 2\n\n      at Object.toBe (assert.test.js:2:17)`));
  assert.deepEqual(asserted("expect(received).toBe(expected) // Object.is equality"), { status: "fail", error: "expect(received).toBe(expected) // Object.is equality" });
  assert.equal(asserted("assert.strictEqual(received, expected)").status, "fail", "jest rewrites a node:assert failure into its own header");
  const mixed = ["  ● crashes", "", "    TypeError: Cannot read properties of undefined (reading 'y')", "", "      at Object.y (mixed.test.js:3:12)", "", "  ● asserts", "", "    expect(received).toBe(expected) // Object.is equality"].join("\n");
  assert.equal(classifyAttempt("jest", r(1, mixed)).status, "fail");
});

// Real `node --test --test-reporter=tap` output from Node 25, trimmed, paths made repo-like.
const tap = (...blocks: string[]) => ["TAP version 13", ...blocks, "1..1", "# tests 1", "# fail 1"].join("\n");
const TAP_CRASH = [
  "# Subtest: reads the seeded edge",
  "not ok 1 - reads the seeded edge",
  "  ---",
  "  duration_ms: 0.420667",
  "  failureType: 'testCodeFailure'",
  "  error: \"Cannot read properties of undefined (reading 'data')\"",
  "  code: 'ERR_TEST_FAILURE'",
  "  name: 'TypeError'",
  "  stack: |-",
  "    TestContext.<anonymous> (/repo/.devasign/tests/crash.test.ts:5:27)",
  "    Test.runInAsyncScope (node:async_hooks:213:14)",
  "  ...",
].join("\n");
const TAP_ASSERT = [
  "# Subtest: adds",
  "not ok 2 - adds",
  "  ---",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "    ",
  "    2 !== 3",
  "    ",
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  operator: 'strictEqual'",
  "  stack: |-",
  "    TestContext.<anonymous> (/repo/.devasign/tests/assert.test.ts:4:10)",
  "  ...",
].join("\n");
const TAP_HOOK = [
  "# Subtest: store",
  "    # Subtest: starts empty",
  "    not ok 1 - starts empty",
  "      ---",
  "      failureType: 'hookFailed'",
  "      error: \"Cannot read properties of undefined (reading 'reset')\"",
  "      code: 'ERR_TEST_FAILURE'",
  "      name: 'TypeError'",
  "      stack: |-",
  "        TestContext.<anonymous> (/repo/.devasign/tests/hook.test.ts:5:24)",
  "        TestHook.runInAsyncScope (node:async_hooks:213:14)",
  "      ...",
  "    1..1",
  "not ok 1 - store",
  "  ---",
  "  type: 'suite'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
].join("\n");

test("node --test: the YAML block names the error; a suite's roll-up of its children is skipped", () => {
  assert.deepEqual(classifyAttempt("node-test", r(1, tap(TAP_CRASH))), { status: "error", error: "TypeError: Cannot read properties of undefined (reading 'data') (at .devasign/tests/crash.test.ts:5:27)" });
  assert.deepEqual(classifyAttempt("node-test", r(1, tap(TAP_ASSERT))), { status: "fail", error: "AssertionError: Expected values to be strictly equal: 2 !== 3" });
  assert.deepEqual(classifyAttempt("bundled", r(1, tap(TAP_HOOK))), { status: "error", error: "TypeError: Cannot read properties of undefined (reading 'reset') (at .devasign/tests/hook.test.ts:5:24)" });
  assert.equal(classifyAttempt("node-test", r(1, tap(TAP_CRASH, TAP_ASSERT))).status, "fail", "one real assertion among crashes is a failure");
  assert.equal(classifyAttempt("node-test", r(1, "TAP version 13\nnot ok 1 - x\n# fail 1")).status, "error", "a bare not ok says only that something failed");
});
