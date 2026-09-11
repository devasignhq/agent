// A test that broke is not a PR that is wrong. `fail` needs assertion evidence;
// anything else that exits nonzero is `error`. Attempts aggregate to
// pass | fail | flaky | error.
import type { AttemptStatus, ResultStatus, TestRunner } from "./types.js";
import type { ExecResult } from "./exec.js";

// Fallback for output no failure parser recognised. A " FAIL " header, ×, ✕, "not ok" or
// "N failed" only says that something failed, never that an assertion did.
const ASSERTION: Record<string, RegExp> = {
  "node-test": /AssertionError|ERR_ASSERTION/,
  bundled: /AssertionError|ERR_ASSERTION/,
  vitest: /^AssertionError\b/m,
  jest: /^\s+(?:expect|assert)[.(]|AssertionError/m,
  pytest: /^FAILED\b|\b\d+ failed\b|AssertionError|assert /m,
  go: /^--- FAIL\b|^FAIL\b/m,
  playwright: /expect\(|Timed out .* expect|toBeVisible|toHaveText|toContainText|toHaveURL|toBeChecked|toHaveValue|toHaveCount|Expected:|Received:/m,
};

// Vite/vitest say "Cannot find package" and "Failed to resolve import" where node says
// "Cannot find module"; without them a suite that never loaded reads as a failed assertion.
const INFRA: RegExp =
  /Cannot find module|Cannot find package|Failed to load url|Failed to resolve import|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError|ImportError|ModuleNotFoundError|command not found|ENOENT|no test files|no tests found|No tests found|collected 0 items|\[build failed\]|Executable doesn't exist|browserType\.launch|net::ERR_|ECONNREFUSED|Process from config\.webServer|Timed out waiting .* from config\.webServer/i;

type Failure = { message: string; assertion: boolean; frame?: string };

const FRAME_SKIP = /node_modules\/|^node:/;
const shortPath = (p: string) => p.replace(/^file:\/\//, "").replace(/^.*?\/(?=\.devasign\/)/, "");

function firstFrame(lines: string[], from: number, frame: RegExp, stop: RegExp): string | undefined {
  for (let k = from; k < lines.length && !stop.test(lines[k]); k++) {
    const p = frame.exec(lines[k])?.[1];
    if (p && !FRAME_SKIP.test(p)) return shortPath(p);
  }
  return undefined;
}

// vitest --reporter=default: " FAIL  <file> > <test>", the error's first line, then "❯" frames.
const VITEST_FAIL = /^ FAIL {2}\S/;
const VITEST_HEADER = new RegExp(`${VITEST_FAIL.source}|⎯ (?:Uncaught Exception|Unhandled Rejection|Unhandled Error) ⎯`);
const VITEST_FRAME = /^\s*❯ (?:\S+ )?(\S+:\d+:\d+)$/;
const VITEST_ASSERTION = /^(?:AssertionError\b|Error: expected (?:number of assertions|any number of assertion)|Error: Snapshot .* mismatched)/;

function vitestFailures(lines: string[]): Failure[] {
  const out: Failure[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!VITEST_HEADER.test(lines[i])) continue;
    // Tests that died of the same error share one block, their headers stacked above it.
    let j = i + 1;
    while (j < lines.length && (VITEST_FAIL.test(lines[j]) || !lines[j].trim())) j++;
    const message = (lines[j] ?? "").trim();
    if (!message || message.startsWith("⎯")) continue;
    out.push({ message, assertion: VITEST_ASSERTION.test(message), frame: firstFrame(lines, j + 1, VITEST_FRAME, /^(?:⎯| FAIL {2})/) });
    i = j;
  }
  return out;
}

// jest: "● <title>", maybe jest's own environment hint, the error's first line, then the
// source excerpt (which quotes the test's expect() calls) and "at" frames.
const JEST_TITLE = /^\s*● /;
const JEST_HINT = /wrong test environment|Consider using the "jsdom" test environment/;
const JEST_FRAME = /^\s+at (?:.*? \()?([^()\s]+:\d+:\d+)\)?$/;
const JEST_ASSERTION = /^(?:expect|assert)[.(]|^(?:Jest)?AssertionError\b/;

function jestFailures(lines: string[]): Failure[] {
  const out: Failure[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!JEST_TITLE.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || JEST_HINT.test(lines[j]))) j++;
    const message = (lines[j] ?? "").trim();
    if (!message || JEST_TITLE.test(lines[j])) continue;
    out.push({ message, assertion: JEST_ASSERTION.test(message), frame: firstFrame(lines, j + 1, JEST_FRAME, JEST_TITLE) });
  }
  return out;
}

// node --test --test-reporter=tap: "not ok N - <name>" and a YAML block naming the error.
const TAP_NOT_OK = /^\s*not ok \d+ - /;
const TAP_END = /^\s*(?:\.\.\.$|#|(?:not )?ok \d+ )/;
const TAP_FRAME = /\(?((?:file:\/\/)?[^()\s]+:\d+:\d+)\)?$/;

function tapFailures(lines: string[]): Failure[] {
  const out: Failure[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TAP_NOT_OK.test(lines[i])) continue;
    const block: string[] = [];
    for (let k = i + 1; k < lines.length && !TAP_END.test(lines[k]); k++) block.push(lines[k]);
    const yaml = block.join("\n");
    // A suite's own entry only rolls up the children reported above it.
    if (/failureType: 'subtestsFailed'/.test(yaml)) continue;
    const name = /^\s*name: '([^']+)'/m.exec(yaml)?.[1];
    const error = tapError(block);
    const stack = block.findIndex((l) => /^\s*stack: /.test(l));
    out.push({
      message: name && !error.startsWith(name) ? `${name}: ${error}` : error,
      assertion: /code: 'ERR_ASSERTION'|\bAssertionError\b/.test(yaml),
      frame: stack < 0 ? undefined : firstFrame(block, stack + 1, TAP_FRAME, /^\s*\w+: /),
    });
  }
  return out;
}

// The YAML `error:` field, inline or as a |- block; hand-written TAP has only a bare line.
function tapError(block: string[]): string {
  const at = block.findIndex((l) => /^\s*error: /.test(l));
  if (at < 0) return block.find((l) => l.trim() && l.trim() !== "---")?.trim() ?? "test failed";
  const inline = /^\s*error: (?:'(.*)'|"(.*)"|([^|>].*))$/.exec(block[at]);
  if (inline) return (inline[1]?.replace(/''/g, "'") ?? inline[2] ?? inline[3]).trim();
  const indent = /^\s*/.exec(block[at])![0].length;
  const body: string[] = [];
  for (let k = at + 1; k < block.length && (!block[k].trim() || /^\s*/.exec(block[k])![0].length > indent); k++) {
    if (block[k].trim()) body.push(block[k].trim());
  }
  return body.join(" ");
}

const PARSERS: Partial<Record<TestRunner, (lines: string[]) => Failure[]>> = {
  vitest: vitestFailures,
  jest: jestFailures,
  "node-test": tapFailures,
  bundled: tapFailures,
};

export function classifyAttempt(runner: TestRunner, r: Pick<ExecResult, "code" | "timedOut" | "spawnError" | "output">): { status: AttemptStatus; error?: string } {
  r = { ...r, output: (r.output || "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n") };
  if (r.spawnError) return { status: "error", error: `could not start test runner: ${r.spawnError}` };
  if (r.timedOut) return { status: "error", error: "test run timed out" };
  const out = r.output || "";
  if (r.code === 0) {
    if ((runner === "node-test" || runner === "bundled") && /^# tests 0\b/m.test(out)) return { status: "error", error: "no tests ran" };
    return { status: "pass" };
  }
  const failures = PARSERS[runner]?.(out.split("\n")) ?? [];
  if (failures.length) {
    const asserted = failures.find((f) => f.assertion);
    if (asserted) return { status: "fail", error: asserted.message.slice(0, 500) };
    // A throw is never assertion evidence, even from repo source: a generated test's mocks and
    // fixtures crash repo code far more often than a PR does. The frame only goes in the message.
    const [crash] = failures;
    return { status: "error", error: `${crash.message}${crash.frame ? ` (at ${crash.frame})` : ""}`.slice(0, 500) };
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
