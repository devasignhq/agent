// Test planner: the cheapest test that can prove each criterion. The model
// proposes; the code enforces what it may not decide — existing tests must
// exist, levels obey the ladder policy, flaky signatures are regenerated or
// retired, and generated files live under .devasign/.
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { completeWithMeta, currentUsageByModel, withModel, withUsage } from "../llm.js";
import { modelForPlan } from "../billing/plans.js";
import { ghText } from "../github/app.js";
import { fetchTree, type TreeEntry } from "../review/indexer.js";
import { extractJSON } from "../review/parse.js";
import { testPlannerSystemPrompt } from "../review/prompts.js";
import { withMaintainerInstructions } from "../review/decisions.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { formatRawDiff, truncateDiffAtHunkBoundary } from "../review/diff-format.js";
import type { Criterion, Installation, Repository, VerifyPlan, VerifyRun, VerifyStageUsage } from "../types.js";
import type { DetectedSetup, DevasignVerifyConfig, PlanCommand, PlanTest, TestLevel, TestRunner } from "./contract.js";
import { inferSetupFromTree, isFrontendPath, isTestPath } from "./detect.js";
import { flakeRowsForCriterion, flakeRow, isQuarantined, isRetired, latestStrategyVersion, testSignature } from "./flake.js";
import { rerenderReport } from "./report.js";
import { criteriaForRun, updateRun } from "./runs.js";
import { hasBootConfig, parseDevasignVerify } from "./yml.js";

export const LEVELS: TestLevel[] = ["unit", "integration", "component", "e2e"];
const LEVEL_RANK: Record<TestLevel, number> = { unit: 0, integration: 1, component: 2, e2e: 3 };
const RUNNERS: ReadonlySet<string> = new Set<TestRunner>(["vitest", "jest", "pytest", "playwright", "go", "node-test", "bundled"]);
const DIFF_CAP = 60_000;
const MAX_EXISTING_LISTED = 150;
export const NO_BOOT_REASON = "no app start / login configured";
export const NO_LEVEL_REASON = "planner could not produce a test at an allowed level";
export const RETIRED_REASON = "could not produce a stable test (retired after repeated flakes)";

export type PlannerLLM = (args: { system: string; user: string; maxTokens: number }) => Promise<{ text: string; stopReason: string | null }>;

export type PlannerDeps = {
  llm?: PlannerLLM;
  // Feedback re-runs plan only the criteria a comment changed; the rest inherit verdicts.
  onlyCriteriaIds?: string[];
  fetchTree?: (repo: Repository, install: Installation, sha: string) => Promise<TreeEntry[]>;
  readFile?: (install: Installation, repo: Repository, path: string, sha: string) => Promise<string | null>;
  fetchDiff?: (install: Installation, repo: Repository, prNumber: number) => Promise<string>;
};

export type PlanPolicy = {
  e2ePolicy: "auto" | "always" | "never";
  e2eAllowed: boolean;
  bootConfigured: boolean;
  apiOnly: boolean;
  maxLevel: Map<string, TestLevel>;
};

export type RawPlanTest = {
  path: string;
  content: string | null;
  criterionIds: string[];
  level: TestLevel;
  levelReason: string;
  origin: "existing" | "generated";
  runner: TestRunner;
  targetFiles: string[];
};

export function usageByProvider(): VerifyStageUsage {
  const byModel = currentUsageByModel();
  const out: VerifyStageUsage = {};
  for (const [model, u] of Object.entries(byModel || {})) {
    const provider = /gemini/i.test(model) ? "gemini" : "anthropic";
    const prev = out[provider] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    out[provider] = {
      inputTokens: prev.inputTokens + u.inputTokens,
      outputTokens: prev.outputTokens + u.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: prev.cacheCreationTokens + u.cacheCreationTokens,
      costUsd: prev.costUsd + u.costUsd,
    };
  }
  return out;
}

const defaultLLM: PlannerLLM = async ({ system, user, maxTokens }) =>
  completeWithMeta({ system, cacheSystem: true, maxTokens, messages: [{ role: "user", content: user }] });

async function defaultReadFile(install: Installation, repo: Repository, path: string, sha: string): Promise<string | null> {
  try {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return await ghText(install.installationId, `/repos/${repo.owner}/${repo.name}/contents/${encoded}?ref=${sha}`, {
      Accept: "application/vnd.github.raw",
    });
  } catch {
    return null;
  }
}

async function defaultFetchDiff(install: Installation, repo: Repository, prNumber: number): Promise<string> {
  return ghText(install.installationId, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`, {
    Accept: "application/vnd.github.v3.diff",
  });
}

export function diffPaths(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());
}

export function planPolicy(args: {
  criteria: Criterion[];
  wfE2e: "auto" | "always" | "never";
  yml: DevasignVerifyConfig | null;
  setup: DetectedSetup;
  touched: string[];
}): PlanPolicy {
  const e2ePolicy = args.yml?.e2e ?? args.wfE2e;
  const bootConfigured = hasBootConfig(args.yml) || args.setup.frameworks.some((f) => f.name === "playwright" && !!f.configPath);
  const e2eAllowed = e2ePolicy !== "never" && bootConfigured;
  const apiOnly = !args.touched.some(isFrontendPath);
  const maxLevel = new Map<string, TestLevel>();
  for (const c of args.criteria) {
    const kind = c.kind ?? "code";
    if (kind === "ui") maxLevel.set(c.id, e2eAllowed ? "e2e" : "component");
    else maxLevel.set(c.id, apiOnly ? "integration" : "component");
  }
  return { e2ePolicy, e2eAllowed, bootConfigured, apiOnly, maxLevel };
}

function normalizeGeneratedPath(p: string, runner: TestRunner): string {
  let clean = p.replace(/^\.\//, "").replace(/^\/+/, "");
  if (clean.startsWith(".devasign/")) return clean;
  clean = clean.replace(/^(tests?|__tests__|spec|e2e)\//, "");
  return runner === "playwright" ? `.devasign/tests/e2e/${clean}` : `.devasign/tests/${clean}`;
}

export function normalizeRawTests(raw: unknown, knownIds: Set<string>, fallbackRunner: TestRunner): RawPlanTest[] {
  const list = (raw as { tests?: unknown })?.tests;
  if (!Array.isArray(list)) return [];
  const out: RawPlanTest[] = [];
  for (const t of list) {
    const o = (t || {}) as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path.trim().slice(0, 300) : "";
    const ids = Array.isArray(o.criterionIds) ? o.criterionIds.map(String).filter((id) => knownIds.has(id)) : [];
    if (!path || !ids.length) continue;
    const origin = o.origin === "existing" ? "existing" : "generated";
    const level = LEVELS.includes(o.level as TestLevel) ? (o.level as TestLevel) : "unit";
    const runner = RUNNERS.has(String(o.runner)) ? (o.runner as TestRunner) : level === "e2e" ? "playwright" : fallbackRunner;
    const content = typeof o.content === "string" && o.content.trim() ? o.content : null;
    if (origin === "generated" && !content) continue;
    out.push({
      path: origin === "generated" ? normalizeGeneratedPath(path, runner) : path.replace(/^\.\//, ""),
      content: origin === "generated" ? content : null,
      criterionIds: [...new Set(ids)],
      level,
      levelReason: typeof o.levelReason === "string" ? o.levelReason.slice(0, 300) : "",
      origin,
      runner,
      targetFiles: Array.isArray(o.targetFiles) ? o.targetFiles.map(String).slice(0, 20) : [],
    });
  }
  return out;
}

export function normalizeUnverifiable(raw: unknown, knownIds: Set<string>): Array<{ criterionId: string; reason: string }> {
  const list = (raw as { unverifiable?: unknown })?.unverifiable;
  if (!Array.isArray(list)) return [];
  return list
    .map((u) => ({ criterionId: String((u as any)?.criterionId ?? ""), reason: String((u as any)?.reason ?? "").slice(0, 300) }))
    .filter((u) => knownIds.has(u.criterionId));
}

/** Drop existing tests that aren't in the tree (hallucinated) and tests above their allowed level. */
export function enforcePlanPolicy(
  tests: RawPlanTest[],
  policy: PlanPolicy,
  treePaths: Set<string>
): { kept: RawPlanTest[]; violations: Array<{ test: RawPlanTest; reason: "missing_existing" | "level" }> } {
  const kept: RawPlanTest[] = [];
  const violations: Array<{ test: RawPlanTest; reason: "missing_existing" | "level" }> = [];
  for (const t of tests) {
    if (t.origin === "existing" && !treePaths.has(t.path)) {
      violations.push({ test: t, reason: "missing_existing" });
      continue;
    }
    if (t.origin === "generated") {
      const allowed = t.criterionIds.some((id) => LEVEL_RANK[t.level] <= LEVEL_RANK[policy.maxLevel.get(id) ?? "unit"]);
      if (!allowed || (t.level === "e2e" && !policy.e2eAllowed)) {
        violations.push({ test: t, reason: "level" });
        continue;
      }
    }
    kept.push(t);
  }
  return { kept, violations };
}

function fallbackRunnerFor(setup: DetectedSetup): TestRunner {
  const names = new Set(setup.frameworks.map((f) => f.name));
  if (names.has("vitest")) return "vitest";
  if (names.has("jest")) return "jest";
  if (names.has("pytest")) return "pytest";
  if (names.has("go-test")) return "go";
  if (names.has("node-test")) return "node-test";
  return "bundled";
}

export function buildCommands(tests: PlanTest[]): PlanCommand[] {
  const groups = new Map<TestRunner, PlanTest[]>();
  for (const t of tests) groups.set(t.runner, [...(groups.get(t.runner) ?? []), t]);
  const out: PlanCommand[] = [];
  for (const [runner, group] of groups) {
    const paths = [...new Set(group.map((t) => t.path))];
    const quoted = paths.map((p) => JSON.stringify(p)).join(" ");
    const base = { id: uuid(), runner, testIds: group.map((t) => t.id) };
    switch (runner) {
      case "vitest":
        out.push({ ...base, cmd: `npx vitest run ${quoted}`, timeoutMs: 10 * 60_000 });
        break;
      case "jest":
        out.push({ ...base, cmd: `npx jest --runTestsByPath ${quoted}`, timeoutMs: 10 * 60_000 });
        break;
      case "pytest":
        out.push({ ...base, cmd: `python -m pytest -q ${quoted}`, timeoutMs: 10 * 60_000 });
        break;
      case "go":
        out.push({ ...base, cmd: `go test ${[...new Set(paths.map((p) => "./" + p.replace(/\/[^/]+$/, "")))].join(" ")}`, timeoutMs: 10 * 60_000 });
        break;
      case "playwright":
        out.push({ ...base, cmd: `npx playwright test --config .devasign/playwright.config.ts ${quoted}`, timeoutMs: 20 * 60_000, needsBrowsers: true });
        break;
      case "node-test":
        out.push({ ...base, cmd: `node --test ${quoted}`, timeoutMs: 10 * 60_000 });
        break;
      default:
        out.push({ ...base, cmd: `devasign-bundled ${quoted}`, timeoutMs: 10 * 60_000 });
    }
  }
  return out;
}

function renderSetup(setup: DetectedSetup, yml: DevasignVerifyConfig | null): string {
  const fw = setup.frameworks.map((f) => `${f.name}${f.version ? `@${f.version}` : ""}${f.configPath ? ` (${f.configPath})` : ""}`).join(", ") || "none detected";
  return [
    `- Languages: ${setup.languages.join(", ") || "unknown"}`,
    `- Package manager: ${setup.packageManager ?? "unknown"}`,
    `- Test frameworks: ${fw}`,
    `- Test commands: ${setup.testCommands.join("; ") || "none"}`,
    `- Services: ${setup.services.join(", ") || "none"}`,
    setup.monorepo ? `- Monorepo: ${setup.monorepo.tool} (${setup.monorepo.packages.join(", ")})` : "",
    `- .devasign.yml verify: ${yml ? JSON.stringify({ ...yml, login: yml.login ? { strategy: yml.login.strategy } : undefined }) : "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderCriteria(criteria: Criterion[]): string {
  return criteria.map((c) => `- [${c.id}] (${c.kind ?? "code"})${c.implied ? " [implied]" : ""} ${c.text}`).join("\n");
}

function renderPolicy(policy: PlanPolicy, ids: string[]): string {
  return [
    ...ids.map((id) => `- [${id}]: max level ${policy.maxLevel.get(id)}`),
    `- E2E allowed: ${policy.e2eAllowed ? "yes" : `no (${policy.e2ePolicy === "never" ? "e2e: never" : NO_BOOT_REASON})`}`,
    `- Diff scope: ${policy.apiOnly ? "api-only (no frontend files touched)" : "includes frontend files"}`,
  ].join("\n");
}

export type PlanContext = {
  run: VerifyRun;
  repo: Repository;
  install: Installation;
  criteria: Criterion[];
  diff: string;
  treePaths: Set<string>;
  setup: DetectedSetup;
  yml: DevasignVerifyConfig | null;
  policy: PlanPolicy;
  existingTests: string[];
  candidates: Array<{ path: string; imports: string[] }>;
  flakeNotes: string[];
  prTitle: string;
};

export function buildPlannerUserPrompt(ctx: PlanContext, opts: { replan?: { ids: string[] } } = {}): string {
  const target = opts.replan ? ctx.criteria.filter((c) => opts.replan!.ids.includes(c.id)) : ctx.criteria;
  const diff = formatRawDiff(truncateDiffAtHunkBoundary(ctx.diff, DIFF_CAP).text);
  const lines = [
    `# Test plan for PR "${ctx.prTitle}" (${ctx.repo.owner}/${ctx.repo.name}#${ctx.run.prNumber})`,
    "",
    opts.replan ? "## Re-plan ONLY these criteria at or below their max level (the previous plan exceeded it)" : "## Acceptance criteria",
    renderCriteria(target),
    "",
    "## Level policy",
    renderPolicy(ctx.policy, target.map((c) => c.id)),
    "",
    "## Repository test setup",
    renderSetup(ctx.setup, ctx.yml),
    "",
    `## Existing test files (${ctx.existingTests.length})`,
    ...ctx.existingTests.slice(0, MAX_EXISTING_LISTED).map((p) => `  - ${p}`),
    "",
    "## Existing tests touching the diff",
    ...(ctx.candidates.length ? ctx.candidates.map((c) => `  - ${c.path} (imports: ${c.imports.slice(0, 6).join(", ")})`) : ["  (none found)"]),
    "",
    "## Flake history",
    ...(ctx.flakeNotes.length ? ctx.flakeNotes : ["- none"]),
    "",
    "## Diff",
    "```diff",
    diff,
    "```",
  ];
  return lines.join("\n");
}

async function gatherContext(run: VerifyRun, repo: Repository, install: Installation, deps: PlannerDeps): Promise<PlanContext> {
  const review = db.find("prReviews", (r) => r.id === run.reviewId);
  const { criteria: all } = criteriaForRun(run);
  const only = deps.onlyCriteriaIds ? new Set(deps.onlyCriteriaIds) : null;
  const criteria = all.filter((c) => (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy && (!only || only.has(c.id)));
  const [diff, tree] = await Promise.all([
    (deps.fetchDiff ?? defaultFetchDiff)(install, repo, run.prNumber),
    (deps.fetchTree ?? fetchTree)(repo, install, run.sha),
  ]);
  const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
  const treePaths = new Set(paths);
  const readFile = deps.readFile ?? defaultReadFile;
  const [ymlRaw, packageJson, envExample] = await Promise.all([
    treePaths.has(".devasign.yml") ? readFile(install, repo, ".devasign.yml", run.sha) : Promise.resolve(null),
    !repo.verify?.detected && treePaths.has("package.json") ? readFile(install, repo, "package.json", run.sha) : Promise.resolve(null),
    !repo.verify?.detected && treePaths.has(".env.example") ? readFile(install, repo, ".env.example", run.sha) : Promise.resolve(null),
  ]);
  const yml = parseDevasignVerify(ymlRaw);
  if (ymlRaw != null) {
    db.update("repositories", (r) => r.id === repo.id, {
      verify: { onboarding: { state: "none" }, ...(repo.verify || {}), devasignYml: { raw: ymlRaw.slice(0, 20_000), parsed: yml, sha: run.sha } },
    });
  }
  const setup = repo.verify?.detected ?? inferSetupFromTree(paths, { packageJson, envExample });
  const touched = diffPaths(diff);
  const wf = effectiveWorkflow(repo);
  const policy = planPolicy({ criteria, wfE2e: wf.verify?.e2e ?? "auto", yml, setup, touched });
  const existingTests = paths.filter(isTestPath);
  const touchedStems = new Set(touched.map((p) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "")));
  const candidates = db
    .filter("repoIndex", (e) => e.repoId === repo.id && isTestPath(e.path))
    .filter((e) => e.imports.some((imp) => touchedStems.has((imp.split("/").pop() || imp).replace(/\.[^.]+$/, ""))))
    .slice(0, 20)
    .map((e) => ({ path: e.path, imports: e.imports }));
  const flakeNotes: string[] = [];
  for (const c of criteria) {
    for (const row of flakeRowsForCriterion(repo.id, c.text)) {
      if (isRetired(row)) flakeNotes.push(`- [${c.id}]: RETIRED — a ${row.level ?? "generated"} test for this criterion flaked ${row.flakeCount} times; do not generate it again, mark it unverifiable.`);
      else if (isQuarantined(row))
        flakeNotes.push(
          `- [${c.id}]: the previous ${row.level ?? ""} test (targets ${(row.targetFiles || []).join(", ") || "n/a"}) was flaky and is quarantined. Regenerate with a DIFFERENT strategy (strategy version ${latestStrategyVersion(row) + 1}): drop one rung on the ladder where the criterion allows, replace timing-based waits with explicit state assertions, use role/test-id selectors over text, isolate seeded data per test.`
        );
    }
  }
  return {
    run,
    repo,
    install,
    criteria,
    diff,
    treePaths,
    setup,
    yml,
    policy,
    existingTests,
    candidates,
    flakeNotes,
    prTitle: review?.prTitle ?? `PR #${run.prNumber}`,
  };
}

/** Plan a run. Returns the updated run row (awaiting_runner, skipped, or failed). */
export async function runVerifyPlan(runId: string, deps: PlannerDeps = {}): Promise<VerifyRun | null> {
  const run = db.find("verifyRuns", (r) => r.id === runId);
  if (!run || run.status !== "planning") return run ?? null;
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) {
    return updateRun(run.id, { status: "failed", error: "no GitHub installation for this repository" });
  }
  const planStartedAt = Date.now();
  updateRun(run.id, { timings: { ...run.timings, planStartedAt } });
  const model = modelForPlan(run.planTier);
  return withModel(model, () =>
    withUsage(async () => {
      try {
        const ctx = await gatherContext(run, repo, install, deps);
        if (!ctx.criteria.length) {
          return updateRun(run.id, { status: "skipped", skipReason: "no_criteria", timings: { ...run.timings, planStartedAt, planFinishedAt: Date.now() } });
        }
        const wf = effectiveWorkflow(repo);
        const system = withMaintainerInstructions(testPlannerSystemPrompt(), wf.prompts?.verify);
        const llm = deps.llm ?? defaultLLM;
        const knownIds = new Set(ctx.criteria.map((c) => c.id));
        const fallbackRunner = fallbackRunnerFor(ctx.setup);

        const first = await llm({ system, user: buildPlannerUserPrompt(ctx), maxTokens: 16_000 });
        const parsed = extractJSON(first.text) ?? {};
        let tests = normalizeRawTests(parsed, knownIds, fallbackRunner);
        const unverifiable = new Map(normalizeUnverifiable(parsed, knownIds).map((u) => [u.criterionId, u.reason]));
        let { kept, violations } = enforcePlanPolicy(tests, ctx.policy, ctx.treePaths);
        const dropped = violations.map((v) => `${v.test.path} (${v.reason})`);

        // One re-plan for criteria a violating test left uncovered, with the cap spelled out.
        const covered = new Set(kept.flatMap((t) => t.criterionIds));
        const uncovered = ctx.criteria.map((c) => c.id).filter((id) => !covered.has(id) && !unverifiable.has(id));
        const violatedIds = uncovered.filter((id) => violations.some((v) => v.test.criterionIds.includes(id)));
        if (violatedIds.length) {
          const second = await llm({ system, user: buildPlannerUserPrompt(ctx, { replan: { ids: violatedIds } }), maxTokens: 12_000 });
          const again = normalizeRawTests(extractJSON(second.text) ?? {}, new Set(violatedIds), fallbackRunner);
          const enforced = enforcePlanPolicy(again, ctx.policy, ctx.treePaths);
          kept = [...kept, ...enforced.kept];
          for (const u of normalizeUnverifiable(extractJSON(second.text) ?? {}, new Set(violatedIds))) unverifiable.set(u.criterionId, u.reason);
          for (const v of enforced.violations) dropped.push(`${v.test.path} (${v.reason}, re-plan)`);
        }

        // Signatures, quarantine strategy bumps, and retirement.
        const critText = new Map(ctx.criteria.map((c) => [c.id, c.text]));
        const finalTests: PlanTest[] = [];
        const retired = new Set<string>();
        for (const t of kept) {
          const text = t.criterionIds.map((id) => critText.get(id) || "").join(" | ");
          const signature = testSignature(text, t.level, t.origin === "existing" ? [t.path] : t.targetFiles);
          const row = flakeRow(repo.id, signature);
          if (t.origin === "generated" && isRetired(row)) {
            for (const id of t.criterionIds) retired.add(id);
            continue;
          }
          const strategyVersion = t.origin === "generated" && isQuarantined(row) ? latestStrategyVersion(row) + 1 : latestStrategyVersion(row);
          finalTests.push({
            id: uuid(),
            path: t.path,
            content: t.content,
            criterionIds: t.criterionIds,
            level: t.level,
            levelReason: t.levelReason,
            origin: t.origin,
            runner: t.runner,
            testSignature: signature,
            strategyVersion,
            targetFiles: t.targetFiles,
          });
        }
        const finalCovered = new Set(finalTests.flatMap((t) => t.criterionIds));
        const planUnverifiable: VerifyPlan["unverifiable"] = [];
        for (const c of ctx.criteria) {
          if (finalCovered.has(c.id)) continue;
          if (retired.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: RETIRED_REASON });
          else if (unverifiable.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: unverifiable.get(c.id)! });
          else if ((c.kind ?? "code") === "ui" && !ctx.policy.e2eAllowed && ctx.policy.e2ePolicy !== "never")
            planUnverifiable.push({ criterionId: c.id, reason: NO_BOOT_REASON, fixUrl: `${config.webOrigin.replace(/\/+$/, "")}/settings/verify?repo=${repo.id}` });
          else if ((c.kind ?? "code") === "ui" && ctx.policy.e2ePolicy === "never")
            planUnverifiable.push({ criterionId: c.id, reason: "end-to-end tests are disabled for this repo (e2e: never)" });
          else planUnverifiable.push({ criterionId: c.id, reason: NO_LEVEL_REASON });
        }

        const plan: VerifyPlan = db.insert("verifyPlans", {
          id: uuid(),
          schemaVersion: 1,
          runId: run.id,
          repoId: repo.id,
          criteriaRevision: run.criteriaRevision,
          tests: finalTests,
          commands: buildCommands(finalTests),
          unverifiable: planUnverifiable,
          createdAt: Date.now(),
        });
        const planFinishedAt = Date.now();
        const generated = finalTests.filter((t) => t.origin === "generated").length;
        const updated = updateRun(run.id, {
          status: "awaiting_runner",
          planId: plan.id,
          timings: { ...run.timings, planStartedAt, planFinishedAt },
          tokenUsage: { ...run.tokenUsage, plan: usageByProvider() },
        });
        db.insert("reviewLogs", {
          id: uuid(),
          reviewId: run.reviewId,
          kind: "verify",
          at: planFinishedAt,
          action: `Test plan ready: ${generated} generated, ${finalTests.length - generated} existing, ${planUnverifiable.length} unverifiable`,
          detail: [
            ...finalTests.map((t) => `${t.level} ${t.origin} ${t.path} → [${t.criterionIds.join(", ")}] (${t.levelReason})`),
            ...planUnverifiable.map((u) => `unverifiable [${u.criterionId}]: ${u.reason}`),
            ...(dropped.length ? [`dropped: ${dropped.join("; ")}`] : []),
          ].join("\n"),
          meta: { runId: run.id, planId: plan.id, generated, existing: finalTests.length - generated, unverifiable: planUnverifiable.length, dropped, apiOnly: ctx.policy.apiOnly, e2eAllowed: ctx.policy.e2eAllowed, truncated: first.stopReason === "max_tokens" },
        });
        if (updated?.report?.commentId) await rerenderReport(run.id);
        return updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[verify] planner failed for run ${run.id}:`, err);
        return updateRun(run.id, { status: "failed", error: `planner: ${msg.slice(0, 300)}`, timings: { ...run.timings, planStartedAt, planFinishedAt: Date.now() } });
      }
    })
  );
}
