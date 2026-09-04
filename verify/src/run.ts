// The run: token → resolve → write tests → run → upload → results → summary.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiClient, ApiError } from "./api.js";
import { resolveArtifactRefs, uploadArtifacts } from "./artifacts.js";
import { readContext, type RunContext } from "./context.js";
import { detectSetup, readDevasignVerify, repoHasPlaywright } from "./detect.js";
import { diagnosePlaywrightOutput, preflight } from "./doctor.js";
import { log } from "./log.js";
import type { TokenSource } from "./oidc.js";
import { runFileTests } from "./runners/index.js";
import { ensureBrowsers, runPlaywright } from "./runners/playwright.js";
import { CLI_VERSION, type DoctorDiagnosis, type LocalArtifact, type ResolveResponse, type RunnerPlan, type RunnerResult, type RunnerResults } from "./types.js";
import { Workspace } from "./workspace.js";

export type RunOptions = {
  apiUrl: string;
  token: TokenSource;
  failOn: "never" | "verdict";
  resolveTimeoutMs: number;
  testTimeoutMs: number;
  keep: boolean;
  cwd: string;
  pr?: number;
  sha?: string;
  planFile?: string; // offline: skip resolve, run this plan
  resultsOut?: string; // offline: write results JSON here instead of uploading
  fetchImpl?: typeof fetch;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolvePlan(api: ApiClient, ctx: RunContext, setup: RunnerResults["setup"], timeoutMs: number): Promise<ResolveResponse> {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  for (;;) {
    const res = await api.resolve({
      sha: ctx.sha,
      pr: ctx.pr,
      event: ctx.event as any,
      attempt: ctx.runAttempt,
      setup: polls === 0 ? setup : undefined,
      actions: { runId: ctx.runId, jobUrl: ctx.jobUrl, runnerOs: ctx.runnerOs },
      cliVersion: CLI_VERSION,
    });
    polls += 1;
    if (res.status !== "pending") return res;
    if (Date.now() > deadline) return res;
    const wait = Math.min(Math.max(res.retryAfterMs || 5_000, 2_000), 30_000);
    if (polls === 1 || polls % 6 === 0) log.info(`waiting for DevAsign to plan the tests${res.runId ? ` (run ${res.runId})` : ""}…`);
    await sleep(wait);
  }
}

export async function executePlan(plan: RunnerPlan, ws: Workspace, opts: { yml: ReturnType<typeof readDevasignVerify>; testTimeoutMs: number; setup: RunnerResults["setup"] }): Promise<{ results: RunnerResult[]; artifacts: LocalArtifact[]; doctor: DoctorDiagnosis | null }> {
  const artifacts: LocalArtifact[] = [];
  const results: RunnerResult[] = [];
  let doctor: DoctorDiagnosis | null = null;

  // Generated files go under .devasign/ only; their content is evidence too.
  for (const t of plan.tests) {
    if (t.origin !== "generated" || !t.content) continue;
    const full = ws.write(t.path, t.content);
    artifacts.push({ clientRef: `test_file:${t.id}`, kind: "test_file", path: full, displayPath: t.path, contentType: "text/plain", testId: t.id, criterionIds: t.criterionIds });
  }
  for (const t of plan.tests) {
    if (t.origin === "existing" && !existsSync(path.resolve(ws.root, t.path))) {
      results.push({ id: `r-${t.id}`, testId: t.id, criterionIds: t.criterionIds, test: t.path, runner: t.runner, level: t.level, origin: t.origin, status: "error", attempts: [], durationMs: 0, error: "existing test not found in the checkout", artifactIds: [] });
    }
  }
  const runnable = plan.tests.filter((t) => !(t.origin === "existing" && !existsSync(path.resolve(ws.root, t.path))));
  const pw = runnable.filter((t) => t.runner === "playwright");
  const others = runnable.filter((t) => t.runner !== "playwright");

  results.push(...(await runFileTests({ tests: others, ws, maxAttempts: (t) => (t.origin === "generated" ? 1 + plan.retries.generated : 1), timeoutMs: opts.testTimeoutMs, artifacts })));

  if (pw.length) {
    const repoCfg = opts.setup?.frameworks.find((f) => f.name === "playwright")?.configPath ?? null;
    doctor = preflight({ tests: pw, setup: opts.setup!, yml: opts.yml, repoHasPlaywrightConfig: !!repoCfg, env: process.env, nodeVersion: process.version });
    if (doctor) {
      log.warn(`setup needs attention: ${doctor.message}`);
      for (const t of pw) results.push({ id: `r-${t.id}`, testId: t.id, criterionIds: t.criterionIds, test: t.path, runner: "playwright", level: t.level, origin: t.origin, status: "error", attempts: [], durationMs: 0, error: doctor.message, artifactIds: [] });
    } else {
      if (plan.playwright?.installBrowsers || !repoHasPlaywright(ws.root)) {
        const inst = await ensureBrowsers(ws.root, ws);
        if (!inst.ok) log.warn("Chromium install reported a failure; continuing — the run will tell us if the browser is missing");
      }
      const generated = pw.filter((t) => t.origin === "generated");
      const existing = pw.filter((t) => t.origin === "existing");
      let combinedOutput = "";
      if (generated.length) {
        const r = await runPlaywright({ tests: generated, ws, baseConfigRel: repoCfg, retries: plan.retries.generated, yml: opts.yml, timeoutMs: opts.testTimeoutMs * 2, artifacts, configName: "playwright.config.ts" });
        results.push(...r.results);
        combinedOutput += r.output;
      }
      if (existing.length) {
        const r = await runPlaywright({ tests: existing, ws, baseConfigRel: repoCfg, retries: plan.retries.existing, yml: opts.yml, timeoutMs: opts.testTimeoutMs * 2, artifacts, configName: "playwright.existing.config.ts" });
        results.push(...r.results);
        combinedOutput += r.output;
      }
      const allErrored = results.filter((r) => r.runner === "playwright").every((r) => r.status === "error");
      if (allErrored) doctor = diagnosePlaywrightOutput(combinedOutput);
    }
  }
  return { results, artifacts, doctor };
}

function summaryTable(results: RunnerResult[], plan: RunnerPlan): string {
  const byId = new Map(plan.criteria.map((c) => [c.id, c]));
  const rows = results.map((r) => `| ${r.criterionIds.map((id) => `${id}. ${byId.get(id)?.text ?? ""}`).join("<br>")} | ${r.status} | ${r.level} ${r.origin} \`${r.test}\` | ${r.attempts.length} |`);
  return ["| Criterion | Test outcome | Test | Attempts |", "|---|---|---|---|", ...rows].join("\n");
}

export async function run(opts: RunOptions): Promise<number> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ws = new Workspace(opts.cwd);
  const yml = readDevasignVerify(ws.root);
  const setup = await detectSetup(ws.root);
  log.info(`@devasign/verify ${CLI_VERSION} — ${setup.frameworks.map((f) => f.name).join(", ") || "no test framework detected (bundled runner)"}`);

  let plan: RunnerPlan;
  let runId: string;
  let api: ApiClient | null = null;
  let ctx: RunContext | null = null;
  if (opts.planFile) {
    plan = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(opts.planFile!, "utf8")));
    runId = "offline";
  } else {
    ctx = readContext({ cwd: ws.root, pr: opts.pr, sha: opts.sha });
    api = new ApiClient(opts.apiUrl, opts.token, fetchImpl);
    let resolved: ResolveResponse;
    try {
      resolved = await resolvePlan(api, ctx, setup, opts.resolveTimeoutMs);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && (err.body as any)?.error === "unknown_repository") {
        log.warn("this repository is not connected to DevAsign yet — install the GitHub App, then re-run. Nothing to verify.");
        return 0;
      }
      throw err;
    }
    if (resolved.status === "pending") {
      log.warn("DevAsign did not produce a plan in time; the review will report verification as pending. Nothing to run.");
      return 0;
    }
    if (resolved.status === "empty") {
      log.info(`nothing to verify: ${resolved.reason}`);
      return 0;
    }
    if (resolved.status === "setup") {
      log.warn(`verification is not set up for this repository yet${resolved.onboardingPr ? ` — merge #${resolved.onboardingPr} to enable` : ""}.`);
      return 0;
    }
    plan = resolved.plan;
    runId = resolved.runId;
    log.info(`plan ${plan.planId}: ${plan.tests.length} test(s) for ${plan.criteria.length} criteria (run ${runId})`);
  }

  try {
    const { results, artifacts, doctor } = await executePlan(plan, ws, { yml, testTimeoutMs: opts.testTimeoutMs, setup });
    let finalResults = results;
    if (api && ctx) {
      const ids = await uploadArtifacts(api, runId, artifacts, plan.uploadLimits, fetchImpl);
      finalResults = resolveArtifactRefs(results, ids);
      if (doctor?.logArtifactId === undefined) {
        const pwLog = [...ids.entries()].find(([ref]) => ref.startsWith("log:pw:"))?.[1];
        if (doctor && pwLog) doctor.logArtifactId = pwLog;
      }
    }
    const payload: RunnerResults = {
      runId,
      sha: ctx?.sha ?? opts.sha ?? "offline",
      planId: plan.planId,
      cliVersion: CLI_VERSION,
      results: finalResults,
      existingTestsTouchingDiff: [],
      setup,
      doctor,
      timings: { startedAt: started, finishedAt: Date.now() },
    };
    if (opts.resultsOut) {
      writeFileSync(opts.resultsOut, JSON.stringify({ ...payload, artifacts: artifacts.map((a) => ({ ...a })) }, null, 2));
      log.info(`results written to ${opts.resultsOut}`);
    }
    if (api) {
      await api.results(runId, payload);
      log.info("results uploaded — DevAsign is judging; the PR check run and comment will update");
    }
    const counts = finalResults.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {} as Record<string, number>);
    log.info(`outcome: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no tests"}${doctor ? ` · setup needs attention: ${doctor.code}` : ""}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## DevAsign verification\n\n${doctor ? `> Setup needs attention: ${doctor.message}\n\n` : ""}${summaryTable(finalResults, plan)}\n\nVerdicts are judged by DevAsign and posted on the PR (check run "DevAsign · Verify").\n`);
      } catch {
        // best-effort
      }
    }
    if (opts.failOn === "verdict" && api) {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const view = await api.getRun(runId);
        if (view.terminal) {
          const fails = view.run.verdicts.filter((v) => v.verdict === "fail");
          if (fails.length) {
            log.error(`${fails.length} criteria failed verification: ${fails.map((f) => f.criterionId).join(", ")}`);
            return 1;
          }
          return 0;
        }
        await sleep(5_000);
      }
      log.warn("verdict not available within 10 minutes; not failing the job");
    }
    return 0;
  } finally {
    if (!opts.keep) ws.cleanup();
    else log.info(`kept ${ws.dir}`);
  }
}
