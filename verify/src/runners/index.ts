// Non-Playwright runners: one process per test file, retries for generated
// tests only, a log artifact per attempt.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { aggregateAttempts, classifyAttempt } from "../classify.js";
import { runCommand } from "../exec.js";
import { log } from "../log.js";
import type { LocalArtifact, PlanTest, RunnerAttempt, RunnerResult, TestRunner } from "../types.js";
import type { Workspace } from "../workspace.js";

const require = createRequire(import.meta.url);

export function tsxLoader(): string {
  return require.resolve("tsx/esm");
}

function bin(root: string, name: string): string | null {
  const p = path.join(root, "node_modules", ".bin", name);
  return existsSync(p) ? p : null;
}

export function commandForFile(runner: TestRunner, file: string, root: string): { cmd: string; args: string[] } {
  switch (runner) {
    case "vitest":
      return { cmd: bin(root, "vitest") ?? "npx", args: [...(bin(root, "vitest") ? [] : ["--no-install", "vitest"]), "run", "--reporter=default", file] };
    case "jest":
      return { cmd: bin(root, "jest") ?? "npx", args: [...(bin(root, "jest") ? [] : ["--no-install", "jest"]), "--runTestsByPath", file] };
    case "pytest":
      return { cmd: "python3", args: ["-m", "pytest", "-q", "-p", "no:cacheprovider", file] };
    case "go":
      return { cmd: "go", args: ["test", "./" + path.posix.dirname(file) + "/", "-run", ".", "-count=1"] };
    case "node-test":
    case "bundled":
    default:
      return { cmd: process.execPath, args: ["--import", tsxLoader(), "--test", "--test-reporter=tap", file] };
  }
}

export async function runFileTests(args: {
  tests: PlanTest[];
  ws: Workspace;
  maxAttempts: (t: PlanTest) => number;
  timeoutMs: number;
  artifacts: LocalArtifact[];
}): Promise<RunnerResult[]> {
  const results: RunnerResult[] = [];
  for (const t of args.tests) {
    const max = Math.max(1, args.maxAttempts(t));
    const attempts: RunnerAttempt[] = [];
    const attemptRefs: string[][] = [];
    log.group(`${t.origin} ${t.level} ${t.path} (${t.runner})`);
    for (let n = 1; n <= max; n++) {
      const { cmd, args: argv } = commandForFile(t.runner, t.path, args.ws.root);
      const logFile = path.join(args.ws.artifactsDir, "logs", `${t.id}-${n}.log`);
      const r = await runCommand({ cmd, args: argv, cwd: args.ws.root, timeoutMs: args.timeoutMs, logFile, onLine: (l) => console.log(`  ${l}`) });
      const c = classifyAttempt(t.runner, r);
      const ref = `log:${t.id}:${n}`;
      args.artifacts.push({ clientRef: ref, kind: "log", path: logFile, displayPath: args.ws.relative(logFile), contentType: "text/plain", testId: t.id, criterionIds: t.criterionIds, attempt: n });
      attempts.push({ n, status: c.status, durationMs: r.durationMs, error: c.error, artifactIds: [] });
      attemptRefs.push([ref]);
      log.info(`attempt ${n}/${max}: ${c.status}${c.error ? ` — ${c.error}` : ""}`);
      if (c.status === "pass" && n === 1) break;
      if (c.status === "pass" && n > 1) break; // pass after a failure: flaky, stop here
      if (c.status === "error" && max > 1 && n === 1 && /could not start|ENOENT|Cannot find module/.test(c.error || "")) break; // infra, retrying won't help
    }
    log.endGroup();
    const status = aggregateAttempts(attempts.map((a) => a.status));
    const last = attempts[attempts.length - 1];
    results.push({
      id: `r-${t.id}`,
      testId: t.id,
      criterionIds: t.criterionIds,
      test: t.path,
      runner: t.runner,
      level: t.level,
      origin: t.origin,
      status,
      attempts: attempts.map((a, i) => ({ ...a, artifactIds: attemptRefs[i] })), // refs → ids after upload
      durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
      error: status === "pass" ? undefined : last?.error,
      artifactIds: [],
    });
  }
  return results;
}
