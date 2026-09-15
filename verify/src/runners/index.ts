// Non-Playwright runners: one process per test file, retries for generated
// tests only, a log artifact per attempt.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { aggregateAttempts, classifyAttempt } from "../classify.js";
import { packageDirOf } from "../detect.js";
import { runCommand } from "../exec.js";
import { log } from "../log.js";
import type { LocalArtifact, PlanTest, RunnerAttempt, RunnerResult, TestRunner } from "../types.js";
import type { Workspace } from "../workspace.js";

const require = createRequire(import.meta.url);

export function tsxLoader(): string {
  return require.resolve("tsx/esm");
}

function bin(roots: string | string[], name: string): string | null {
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    const p = path.join(root, "node_modules", ".bin", name);
    if (existsSync(p)) return p;
  }
  return null;
}

// `roots`: where a framework binary may live — the package the test exercises
// first, then the repo root.
export function commandForFile(runner: TestRunner, file: string, roots: string | string[]): { cmd: string; args: string[] } {
  switch (runner) {
    case "vitest":
      return { cmd: bin(roots, "vitest") ?? "npx", args: [...(bin(roots, "vitest") ? [] : ["--no-install", "vitest"]), "run", "--reporter=default", file] };
    case "jest":
      return { cmd: bin(roots, "jest") ?? "npx", args: [...(bin(roots, "jest") ? [] : ["--no-install", "jest"]), "--runTestsByPath", file] };
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
  fileOf?: (t: PlanTest) => string;
}): Promise<RunnerResult[]> {
  const results: RunnerResult[] = [];
  for (const t of args.tests) {
    const max = Math.max(1, args.maxAttempts(t));
    const attempts: RunnerAttempt[] = [];
    const attemptRefs: string[][] = [];
    const file = args.fileOf?.(t) ?? t.path;
    log.group(`${t.origin} ${t.level} ${t.path}${file !== t.path ? ` → ${file}` : ""} (${t.runner})`);
    // A framework binary lives with the package the test exercises, not at a root
    // that may carry no manifest at all.
    const pkgDir = t.targetFiles?.[0] ? packageDirOf(args.ws.root, t.targetFiles[0]) : null;
    const binRoots = pkgDir && pkgDir !== "." ? [path.join(args.ws.root, pkgDir), args.ws.root] : args.ws.root;
    for (let n = 1; n <= max; n++) {
      const { cmd, args: argv } = commandForFile(t.runner, file, binRoots);
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
      if (c.status === "error" && max > 1 && n === 1 && /could not start|ENOENT|Cannot find module|Cannot find package|Failed to (?:load url|resolve import)/.test(c.error || "")) break; // infra, retrying won't help
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
