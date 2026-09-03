// A test that broke is not a PR that is wrong. `fail` needs assertion evidence;
// anything else that exits nonzero is `error`. Attempts aggregate to
// pass | fail | flaky | error.
import type { AttemptStatus, ResultStatus, TestRunner } from "./types.js";
import type { ExecResult } from "./exec.js";

const ASSERTION: Record<string, RegExp> = {
  "node-test": /^not ok\b|AssertionError|# fail [1-9]/m,
  bundled: /^not ok\b|AssertionError|# fail [1-9]/m,
  vitest: /AssertionError|Tests\s+\d+ failed|\bFAIL\b.*\.[jt]sx?|✖|×|expected .* to /m,
  jest: /Tests:\s+\d+ failed|✕|expect\(|toBe|toEqual|toHaveBeenCalled/m,
  pytest: /^FAILED\b|\b\d+ failed\b|AssertionError|assert /m,
  go: /^--- FAIL\b|^FAIL\b/m,
  playwright: /expect\(|Timed out .* expect|toBeVisible|toHaveText|toContainText|toHaveURL|toBeChecked|toHaveValue|toHaveCount|Expected:|Received:/m,
};

const INFRA: RegExp =
  /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError|ImportError|ModuleNotFoundError|command not found|ENOENT|no test files|no tests found|No tests found|collected 0 items|\[build failed\]|Executable doesn't exist|browserType\.launch|net::ERR_|ECONNREFUSED|Process from config\.webServer|Timed out waiting .* from config\.webServer/i;

export function classifyAttempt(runner: TestRunner, r: Pick<ExecResult, "code" | "timedOut" | "spawnError" | "output">): { status: AttemptStatus; error?: string } {
  r = { ...r, output: (r.output || "").replace(/\u001b\[[0-9;]*m/g, "") };
  if (r.spawnError) return { status: "error", error: `could not start test runner: ${r.spawnError}` };
  if (r.timedOut) return { status: "error", error: "test run timed out" };
  const out = r.output || "";
  if (r.code === 0) {
    if ((runner === "node-test" || runner === "bundled") && /^# tests 0\b/m.test(out)) return { status: "error", error: "no tests ran" };
    return { status: "pass" };
  }
  const assertion = ASSERTION[runner] ?? ASSERTION["node-test"];
  const infra = INFRA.test(out);
  if (assertion.test(out) && !(infra && !/^not ok|AssertionError|FAILED|--- FAIL/m.test(out))) return { status: "fail", error: firstFailureLine(out) };
  return { status: "error", error: firstErrorLine(out) || `exit code ${r.code}` };
}

/** Playwright reports its own per-attempt status; only the error text needs classifying. */
export function classifyPlaywrightError(message: string | undefined): AttemptStatus {
  const m = message || "";
  if (!m) return "fail";
  if (ASSERTION.playwright.test(m) && !/Process from config\.webServer|net::ERR_|ECONNREFUSED|Executable doesn't exist/i.test(m)) return "fail";
  return "error";
}

export function aggregateAttempts(statuses: AttemptStatus[]): ResultStatus {
  if (!statuses.length) return "error";
  const passes = statuses.filter((s) => s === "pass").length;
  const fails = statuses.filter((s) => s === "fail").length;
  if (passes === statuses.length) return "pass";
  if (passes > 0) return "flaky";
  if (fails > 0) return "fail";
  return "error";
}

function firstFailureLine(out: string): string {
  const m = /^(not ok .*|.*AssertionError.*|FAILED .*|--- FAIL.*|.*Tests:\s+\d+ failed.*|.*✖.*|.*✕.*)$/m.exec(out);
  return (m?.[1] || "assertion failed").trim().slice(0, 500);
}

function firstErrorLine(out: string): string {
  const m = INFRA.exec(out);
  if (!m) return "";
  const idx = out.lastIndexOf("\n", m.index) + 1;
  const end = out.indexOf("\n", m.index);
  return out.slice(idx, end < 0 ? undefined : end).trim().slice(0, 500);
}
