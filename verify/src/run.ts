// The run: token → resolve → write tests → run → upload → results → summary.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiClient, ApiError, runArtifacts } from "./api.js";
import { resolveArtifactRefs, uploadArtifacts } from "./artifacts.js";
import { bootManaged, cleanupAuth, redact, redactFile, type StorageState } from "./boot.js";
import { runBootProbe } from "./boot-probe.js";
import { readContext, type RunContext } from "./context.js";
import { detectSetup, readDevasignVerify, repoHasPlaywright } from "./detect.js";
import { diagnoseMissingDependencies, diagnosePlaywrightOutput, preflight } from "./doctor.js";
import { log, setOutput } from "./log.js";
import type { TokenSource } from "./oidc.js";
import { onDiskPath, writeModuleTypeShims } from "./module-type.js";
import { runFileTests } from "./runners/index.js";
import { ensureBrowsers, runPlaywright } from "./runners/playwright.js";
import { CLI_COMMIT, CLI_VERSION, type DoctorDiagnosis, type FailOn, type LocalArtifact, type ResolveResponse, type RunnerPlan, type RunnerResult, type RunnerResults } from "./types.js";
import { redactTrace } from "./trace-redact.js";
import { Workspace } from "./workspace.js";
import { mergeBootConfig, needsManagedBoot } from "./yml.js";

export type RunOptions = {
  apiUrl: string;
  token: TokenSource;
  // Unset: the plan's server-side default, then "never".
  failOn?: FailOn;
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

export const MIN_SERVER_DEADLINE_MS = 30_000;

/**
 * The server knows how long planning really takes, so let it shorten our wait — but never
 * extend it, or a stuck backend could pin a CI job open for its whole timeout.
 */
export function serverDeadline(current: number, startedAt: number, hintMs: number | undefined): number {
  if (typeof hintMs !== "number" || !Number.isFinite(hintMs) || hintMs <= 0) return current;
  return Math.min(current, startedAt + Math.max(hintMs, MIN_SERVER_DEADLINE_MS));
}

export async function resolvePlan(api: ApiClient, ctx: RunContext, setup: RunnerResults["setup"], timeoutMs: number): Promise<ResolveResponse> {
  const startedAt = Date.now();
  let deadline = startedAt + timeoutMs;
  let polls = 0;
  let finalPoll = false;
  for (;;) {
    const res = await api.resolve({
      sha: ctx.sha,
      pr: ctx.pr,
      event: ctx.event as any,
      attempt: ctx.runAttempt,
      setup: polls === 0 ? setup : undefined,
      actions: { runId: ctx.runId, jobUrl: ctx.jobUrl, runnerOs: ctx.runnerOs },
      cliVersion: CLI_VERSION,
      capabilities: ["managed_boot", "boot_probe"],
      // Tells the server this job is leaving, so a plan landing later re-dispatches CI
      // instead of stranding the run until it times out.
      ...(finalPoll ? { giveUp: true } : {}),
    });
    polls += 1;
    if (res.status !== "pending") return res;
    if (finalPoll) return res;
    deadline = serverDeadline(deadline, startedAt, res.giveUpAfterMs);
    const wait = Math.min(Math.max(res.retryAfterMs || 5_000, 2_000), 30_000);
    if (polls === 1 || polls % 6 === 0) log.info(`waiting for DevAsign to plan the tests${res.runId ? ` (run ${res.runId})` : ""}…`);
    await sleep(wait);
    if (Date.now() >= deadline) finalPoll = true;
  }
}

export async function executePlan(plan: RunnerPlan, ws: Workspace, opts: { yml: ReturnType<typeof readDevasignVerify>; testTimeoutMs: number; setup: RunnerResults["setup"] }): Promise<{ results: RunnerResult[]; artifacts: LocalArtifact[]; doctor: DoctorDiagnosis | null; doctorLogRef?: string }> {
  const artifacts: LocalArtifact[] = [];
  const results: RunnerResult[] = [];
  let doctor: DoctorDiagnosis | null = null;
  let doctorLogRef: string | undefined;

  // Generated files go under .devasign/ only; their content is evidence too.
  const disk = new Map(plan.tests.map((t) => [t.id, onDiskPath(t)]));
  for (const t of plan.tests) {
    if (t.origin !== "generated" || !t.content) continue;
    const file = disk.get(t.id) ?? t.path;
    const full = ws.write(file, t.content);
    if (file !== t.path) log.info(`${t.path}: written as ${path.posix.basename(file)} so it loads as the ${/\.m[jt]s$/.test(file) ? "ES module" : "CommonJS module"} it is written in`);
    artifacts.push({ clientRef: `test_file:${t.id}`, kind: "test_file", path: full, displayPath: t.path, contentType: "text/plain", testId: t.id, criterionIds: t.criterionIds });
  }
  for (const s of writeModuleTypeShims(ws, plan.tests.map((t) => ({ ...t, path: disk.get(t.id) ?? t.path })))) {
    log.info(`${s.dir}: declared "type": "${s.type}" so the tests relocated there load as they were written`);
  }
  for (const t of plan.tests) {
    if (t.origin === "existing" && !existsSync(path.resolve(ws.root, t.path))) {
      results.push({ id: `r-${t.id}`, testId: t.id, criterionIds: t.criterionIds, test: t.path, runner: t.runner, level: t.level, origin: t.origin, status: "error", attempts: [], durationMs: 0, error: "existing test not found in the checkout", artifactIds: [] });
    }
  }
  const runnable = plan.tests.filter((t) => !(t.origin === "existing" && !existsSync(path.resolve(ws.root, t.path))));
  const pw = runnable.filter((t) => t.runner === "playwright");
  const others = runnable.filter((t) => t.runner !== "playwright");

  results.push(...(await runFileTests({ tests: others, ws, fileOf: (t) => disk.get(t.id) ?? t.path, maxAttempts: (t) => (t.origin === "generated" ? 1 + plan.retries.generated : 1), timeoutMs: opts.testTimeoutMs, artifacts })));
  doctor = diagnoseMissingDependencies(results, ws.root);
  if (doctor) log.warn(`setup needs attention: ${doctor.message}`);

  if (pw.length) {
    const repoCfg = opts.setup?.frameworks.find((f) => f.name === "playwright")?.configPath ?? null;
    const managed = needsManagedBoot(opts.yml) && plan.managedBoot !== false;
    const errorAll = (message: string) => {
      for (const t of pw) results.push({ id: `r-${t.id}`, testId: t.id, criterionIds: t.criterionIds, test: t.path, runner: "playwright", level: t.level, origin: t.origin, status: "error", attempts: [], durationMs: 0, error: message, artifactIds: [] });
    };
    // A managed boot ignores the repo's webServer, so only start/url can say how the app starts.
    doctor = doctor ?? preflight({ tests: pw, setup: opts.setup!, yml: opts.yml, repoHasPlaywrightConfig: !!repoCfg && !managed, env: process.env, nodeVersion: process.version });
    if (doctor) {
      log.warn(`setup needs attention: ${doctor.message}`);
      errorAll(doctor.message);
    } else {
      if (plan.playwright?.installBrowsers || !repoHasPlaywright(ws.root)) {
        const inst = await ensureBrowsers(ws.root, ws);
        if (!inst.ok) log.warn("Chromium install reported a failure; continuing — the run will tell us if the browser is missing");
        else setOutput("browsers", "true");
      }
      const generated = pw.filter((t) => t.origin === "generated");
      const existing = pw.filter((t) => t.origin === "existing");
      let state: StorageState | null = null;
      const scrub = (text: string) => redact(text, { envNames: opts.yml?.env, state });
      const logFiles: string[] = [];
      let boot: Awaited<ReturnType<typeof bootManaged>> | null = null;
      try {
        let booted: { baseUrl: string; storageState?: string } | null = null;
        if (managed) {
          const servers = opts.yml!.servers?.length ?? 0;
          log.info(`starting ${servers ? `${servers} server(s), then the app` : "the app"}${opts.yml!.login?.script ? ", then signing in" : ""}`);
          boot = await bootManaged(opts.yml!, ws);
          for (const f of boot.handle?.logFiles ?? []) {
            const ref = `log:boot:${path.basename(f, ".log").replace(/^boot-/, "")}`;
            logFiles.push(f);
            artifacts.push({ clientRef: ref, kind: "log", path: f, displayPath: ws.relative(f), contentType: "text/plain", criterionIds: [] });
            if (!boot.ok) doctorLogRef = ref;
          }
          if (boot.ok) {
            state = boot.state;
            booted = { baseUrl: boot.baseUrl, ...(boot.storageStatePath ? { storageState: boot.storageStatePath } : {}) };
            log.info(`app is up at ${boot.baseUrl}${boot.storageStatePath ? `, signed in (session ${boot.sessionChecked ? "checked" : "not checked"})` : ""}`);
          } else {
            doctor = boot.diagnosis;
            log.warn(`setup needs attention: ${doctor.message}`);
            errorAll(doctor.message);
          }
        }
        if (!managed || booted) {
          let combinedOutput = "";
          const runs = [
            { tests: generated, retries: plan.retries.generated, configName: "playwright.config.ts" },
            { tests: existing, retries: plan.retries.existing, configName: "playwright.existing.config.ts" },
          ];
          for (const r of runs.filter((x) => x.tests.length)) {
            logFiles.push(path.join(ws.artifactsDir, "logs", `${r.configName}.log`));
            const out = await runPlaywright({ ...r, ws, baseConfigRel: repoCfg, yml: opts.yml, timeoutMs: opts.testTimeoutMs * 2, artifacts, booted, scrub });
            results.push(...out.results);
            combinedOutput += out.output;
          }
          const allErrored = results.filter((r) => r.runner === "playwright").every((r) => r.status === "error");
          if (allErrored) doctor = diagnosePlaywrightOutput(combinedOutput, booted?.baseUrl ?? null);
        }
      } finally {
        if (boot?.handle) await boot.handle.stop();
        if (managed) cleanupAuth(ws);
        // Every log that leaves this job is scrubbed of secrets and the session first, and so is a signed-in trace.
        for (const f of logFiles) redactFile(f, { envNames: opts.yml?.env, state });
        if (state) for (const f of new Set(artifacts.filter((a) => a.kind === "trace").map((a) => a.path))) redactTrace(f, { envNames: opts.yml?.env, state });
      }
    }
  }
  return { results, artifacts, doctor, ...(doctorLogRef ? { doctorLogRef } : {}) };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

// Every criterion gets a row, so a plan with no runnable test still says why.
export function summaryTable(plan: RunnerPlan, results: RunnerResult[]): string {
  const unverifiable = new Map((plan.unverifiable ?? []).map((u) => [u.criterionId, u]));
  const rows = plan.criteria.map((c) => {
    const mine = results.filter((r) => r.criterionIds.includes(c.id));
    const u = unverifiable.get(c.id);
    if (mine.length) {
      const tests = mine.map((r) => `${r.level} ${r.origin} \`${cell(r.test)}\``).join("<br>");
      // Playwright's list spans the file's test() blocks; those are results, not retries.
      const outcome = mine.map((r) => `${r.status} (${r.attempts.length} ${r.runner === "playwright" ? "result" : "attempt"}${r.attempts.length === 1 ? "" : "s"})`).join("<br>");
      return `| ${c.id}. ${cell(c.text)} | ${tests} | ${outcome} | |`;
    }
    const note = u ? `${cell(u.reason)}${u.fixUrl ? ` — [configure app start](${u.fixUrl})` : ""}` : "no test planned";
    return `| ${c.id}. ${cell(c.text)} | — | unverifiable | ${note} |`;
  });
  return ["| Criterion | Test | Outcome | Notes |", "|---|---|---|---|", ...rows].join("\n");
}

export function announceUnverifiable(plan: RunnerPlan): void {
  for (const u of plan.unverifiable ?? []) {
    log.warn(`criterion ${u.criterionId} is unverifiable: ${u.reason}${u.fixUrl ? ` — fix: ${u.fixUrl}` : ""}`);
  }
  if (plan.tests.length === 0) log.warn("no tests could be planned for this PR; every criterion will be reported as unverifiable");
}

export async function run(opts: RunOptions): Promise<number> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ws = new Workspace(opts.cwd);
  const yml = readDevasignVerify(ws.root);
  const setup = await detectSetup(ws.root);
  log.info(`@devasign/verify ${CLI_VERSION}${CLI_COMMIT ? ` (${CLI_COMMIT})` : ""} — ${setup.frameworks.map((f) => f.name).join(", ") || "no test framework detected (bundled runner)"}`);

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
      // The App's own setup PR: nothing to judge, but the boot config it proposes is worth trying.
      if (resolved.probe) return runBootProbe({ api, probe: resolved.probe, ws, yml, setup, sha: ctx.sha, keep: opts.keep, testTimeoutMs: opts.testTimeoutMs, fetchImpl });
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
    setOutput("run-id", runId);
  }
  announceUnverifiable(plan);
  const failOn: FailOn = opts.failOn ?? plan.failOn ?? "never";
  // A branch cut before onboarding has no verify block of its own; boot from the plan's.
  const bootYml = mergeBootConfig(yml, plan.verifyConfig);
  if (!yml && plan.verifyConfig) log.info("no verify block in this checkout's .devasign.yml; starting the app with the one the plan was made from");
  else if (yml && bootYml !== yml) log.info("this checkout's verify block has no start; starting the app the way the plan's block does");

  try {
    const { results, artifacts, doctor, doctorLogRef } = await executePlan(plan, ws, { yml: bootYml, testTimeoutMs: opts.testTimeoutMs, setup });
    let finalResults = results;
    if (api && ctx) {
      const ids = await uploadArtifacts(api, runArtifacts(runId), artifacts, plan.uploadLimits, fetchImpl);
      finalResults = resolveArtifactRefs(results, ids);
      if (doctor && doctor.logArtifactId === undefined) {
        const logId = doctorLogRef ? ids.get(doctorLogRef) : [...ids.entries()].find(([ref]) => ref.startsWith("log:pw:"))?.[1];
        if (logId) doctor.logArtifactId = logId;
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
    const unplanned = plan.unverifiable?.length ?? 0;
    const outcome = `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no tests ran"}${unplanned ? `, ${unplanned} unverifiable by plan` : ""}`;
    log.info(`outcome: ${outcome}${doctor ? ` · setup needs attention: ${doctor.code}` : ""}`);
    setOutput("outcome", outcome);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## DevAsign verification\n\n${doctor ? `> Setup needs attention: ${doctor.message}\n\n` : ""}${summaryTable(plan, finalResults)}\n\nVerdicts are judged by DevAsign and posted on the PR (check run "DevAsign · Verify").\n`);
      } catch {
        // best-effort
      }
    }
    if (failOn !== "never" && api) {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const view = await api.getRun(runId);
        if (view.terminal) {
          const fails = view.run.verdicts.filter((v) => v.verdict === "fail");
          const unverified = failOn === "unverifiable" ? view.run.verdicts.filter((v) => v.verdict === "unverifiable") : [];
          for (const v of unverified) log.error(`criterion ${v.criterionId} could not be verified: ${v.reason}${v.fixUrl ? ` — fix: ${v.fixUrl}` : ""}`);
          if (fails.length) log.error(`${fails.length} criteria failed verification: ${fails.map((f) => f.criterionId).join(", ")}`);
          return fails.length || unverified.length ? 1 : 0;
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
