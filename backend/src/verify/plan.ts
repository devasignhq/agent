// Test planner: the cheapest test that can prove each criterion. The model
// proposes; the code enforces what it may not decide — existing tests must
// exist, levels obey the ladder policy, flaky signatures are regenerated or
// retired, and generated files live under .devasign/.
import { posix } from "node:path";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  completeStructured,
  currentUsageByModel,
  retryStructured,
  withModel,
  withUsage,
  type LLMMessage,
  type StructuredAttempt,
  type StructuredResult,
  type StructuredTool,
  type Validation,
} from "../llm.js";
import { modelForPlan } from "../billing/plans.js";
import { ghText, repositoryDispatch } from "../github/app.js";
import { fetchRepoTree, runPool, type RepoTree, type TreeEntry } from "../review/indexer.js";
import { testFileSystemPrompt, testPlannerSystemPrompt } from "../review/prompts.js";
import { planManifestTool, planTestFileTool } from "../review/tools.js";
import { withMaintainerInstructions } from "../review/decisions.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { formatRawDiff, truncateDiffAtHunkBoundary } from "../review/diff-format.js";
import type { Criterion, Installation, Repository, VerifyPlan, VerifyPlanBrowser, VerifyRun, VerifyStageUsage } from "../types.js";
import type { DetectedSetup, DevasignVerifyConfig, PlanCommand, PlanTest, TestLevel, TestRunner } from "./contract.js";
import { codeSpans, isRewritableSpecifier } from "./code-spans.js";
import { buildImportAllowList, disallowedImports, hasRenderStack, IMPORT_LEAD, importTarget, resolvesInRepo, unresolvedRelativeImports, withoutExt, type ImportAllowList, type ImportTargetOpts } from "./imports.js";
import { appSourceFor, sourceUnderTest, waysIn, type SourceFile } from "./app-source.js";
import { routeLines } from "./app-routes.js";
import { libraryNotes } from "./library-notes.js";
import { syntaxError } from "./syntax.js";
import { specLint, specLintCertain } from "./spec-lint.js";
import { historyLint } from "./history-lint.js";
import { moduleSyntaxLint } from "./module-syntax-lint.js";
import { withDomEnvironment } from "./dom-env.js";
import { inferSetupFromTree, isFrontendPath, isTestPath } from "./detect.js";
import { flakeRowsForCriterion, flakeRow, isQuarantined, isRetired, latestStrategyVersion, testSignature } from "./flake.js";
import { rerenderReport } from "./report.js";
import { criteriaForRun, forgetRunnerPoll, runnerGaveUp, RUNNER_GONE_MS, updateRun } from "./runs.js";
import { BOOT_KEYS, hasBootConfig, parseDevasignVerify } from "./yml.js";
import { patchRepoVerify, setupFixUrl } from "./repo-state.js";

export const LEVELS: TestLevel[] = ["unit", "integration", "component", "e2e"];
const LEVEL_RANK: Record<TestLevel, number> = { unit: 0, integration: 1, component: 2, e2e: 3 };
const RUNNERS: ReadonlySet<string> = new Set<TestRunner>(["vitest", "jest", "pytest", "playwright", "go", "node-test", "bundled"]);
const DIFF_CAP = 60_000;
const MAX_EXISTING_LISTED = 150;
export const NO_BOOT_REASON = "no app start / login configured";
export const NO_LEVEL_REASON = "planner could not produce a test at an allowed level";
export const RETIRED_REASON = "could not produce a stable test (retired after repeated flakes)";
export const PLAN_CUT_OFF_REASON = "the test plan was cut off before this criterion was covered";
export const PLAN_UNUSABLE_REASON = "the planner did not return a usable test plan";
export const MISSING_PACKAGE_REASON = "proving this needs a test package this repository does not have";
export const MISSING_IMPORT_REASON = "the generated test imported a file that does not exist in the repository";

export type PlannerLLM = (args: { system: string; messages: LLMMessage[]; maxTokens: number; tool: StructuredTool }) => Promise<StructuredResult>;

export type PlannerDeps = {
  llm?: PlannerLLM;
  // Feedback re-runs plan only the criteria a comment changed; the rest inherit verdicts.
  onlyCriteriaIds?: string[];
  fetchTree?: (repo: Repository, install: Installation, sha: string) => Promise<TreeEntry[] | RepoTree>;
  readFile?: (install: Installation, repo: Repository, path: string, sha: string) => Promise<string | null>;
  fetchDiff?: (install: Installation, repo: Repository, prNumber: number) => Promise<string>;
  dispatch?: (install: Installation, repo: Repository, payload: Record<string, unknown>) => Promise<void>;
};

const defaultDispatch = (install: Installation, repo: Repository, payload: Record<string, unknown>) =>
  repositoryDispatch(install.installationId, repo.owner, repo.name, "devasign-verify", payload);

export type PlanPolicy = {
  e2ePolicy: "auto" | "always" | "never";
  e2eAllowed: boolean;
  bootConfigured: boolean;
  // Whether the repo has anything to render a component with. True when unknown, so a
  // detection blind spot never closes a rung that is open today.
  componentCapable: boolean;
  apiOnly: boolean;
  maxLevel: Map<string, TestLevel>;
  // Test files this PR adds or changes. They ship inside the change under review,
  // so they carry its blind spots and cannot stand as evidence for it.
  prAuthoredTests: Set<string>;
  // Non-test files this PR changes. A generated test below e2e must target one of
  // them: a criterion is about this change, not about whichever module shares a word.
  touchedSources: Set<string>;
};

export type RawPlanTest = {
  path: string;
  content: string | null;
  // The path the model chose, before relocation — what its relative imports are
  // anchored on. Absent for existing tests, which are not moved or rewritten.
  rebaseFrom?: string;
  criterionIds: string[];
  level: TestLevel;
  levelReason: string;
  origin: "existing" | "generated";
  runner: TestRunner;
  targetFiles: string[];
  strategy?: string;
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

const defaultLLM: PlannerLLM = async ({ system, messages, maxTokens, tool }) =>
  completeStructured({ system, cacheSystem: true, maxTokens, messages, tool });

// Planning is mechanical next to review judgment — the ladder policy, path safety and
// flake retirement are all enforced in code after the model — so it need not share the tier.
export function plannerLLM(llm: PlannerLLM, tier: VerifyRun["planTier"]): PlannerLLM {
  const model = config.verify.plannerModel;
  // Free already plans on the cheap model; overriding would only raise its cost.
  if (!model || tier === "free") return llm;
  return (args) => withModel(model, () => llm(args));
}

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
  return {
    e2ePolicy,
    e2eAllowed,
    bootConfigured,
    componentCapable: hasRenderStack(args.setup),
    apiOnly,
    maxLevel,
    prAuthoredTests: new Set(args.touched.filter(isTestPath)),
    touchedSources: new Set(args.touched.filter((p) => !isTestPath(p))),
  };
}

// The planner's paths come from a model reading an attacker-influenced diff, so
// a traversal segment here would end up in the runner's checkout and in the
// "Adopt tests" commit. Null drops the test. `from` is the location the model
// believed it was writing to, which is what its relative imports are anchored on.
// Generated tests live here, and adoptGeneratedTests re-homes them under a
// prefix of the SAME depth — the `../` counts baked into their imports by
// rebaseRelativeImports depend on it (asserted in plan.test.ts).
export const GENERATED_TEST_PREFIX = ".devasign/tests";

export function normalizeGeneratedPath(p: string, runner: TestRunner): { path: string; from: string } | null {
  const from = p.replace(/^\.\//, "").replace(/^\/+/, "");
  if (from.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  const inPrefix = from.startsWith(`${GENERATED_TEST_PREFIX}/`);
  if (from.startsWith(".devasign/") && !inPrefix) return null;
  const clean = (inPrefix ? from.slice(GENERATED_TEST_PREFIX.length + 1) : from).replace(/^(tests?|__tests__|spec|e2e)\//, "");
  if (!clean) return null;
  // The runner points Playwright at .devasign/tests/e2e alone: a browser test anywhere else is never found.
  return { path: runner === "playwright" ? `${GENERATED_TEST_PREFIX}/e2e/${clean}` : `${GENERATED_TEST_PREFIX}/${clean}`, from };
}

// Imports are written relative to the path the model chose, but generated tests
// are moved under .devasign/tests/ — so "./total.js" next to src/total.ts would
// resolve to .devasign/tests/src/total.js and fail to load. Re-anchor them.
//
// Every match is gated on code-spans.ts: only a specifier whose own quotes open a
// literal in code position is rewritten, so module-looking text inside a string,
// a comment, or a template literal is left as the data it is.
const RELATIVE_IMPORT = new RegExp(`(${IMPORT_LEAD})(['"\`])(\\.{1,2}(?:/[^'"\`]*)?)\\2`, "g");

export type SkippedSpecifier = { specifier: string; reason: "interpolated" | "above_root" | "missing" };

export function rebaseRelativeImports(
  content: string,
  from: string,
  to: string,
  opts: ImportTargetOpts & {
    // Specifiers left alone on purpose. They cannot resolve after the move, so the
    // caller reports them instead of shipping a silent load failure.
    onUnresolved?: (skipped: SkippedSpecifier) => void;
  } = {}
): string {
  const fromDir = posix.dirname(from);
  const toDir = posix.dirname(to);
  const spans = codeSpans(content);
  return content.replace(RELATIVE_IMPORT, (match, lead: string, quote: string, spec: string, offset: number) => {
    // Before the checks below, so a `${` inside a string is never counted as an
    // unresolved import.
    if (!isRewritableSpecifier(spans, offset, lead, spec)) return match;
    const t = importTarget(spec, fromDir, { siblings: opts.siblings, exists: opts.exists });
    if (!("target" in t)) {
      opts.onUnresolved?.({ specifier: spec, reason: t.reason });
      return match;
    }
    // Anchored on the directory the file is written to, so this is what resolves in CI —
    // and when nothing is there, the caller hears about it instead of shipping a dead load.
    if (opts.exists && !resolvesInRepo(t.target, opts.exists)) opts.onUnresolved?.({ specifier: spec, reason: "missing" });
    const rel = posix.relative(toDir, t.target);
    const next = rel.startsWith("../") ? rel : `./${rel}`;
    return next === spec ? match : `${lead}${quote}${next}${quote}`;
  });
}

// vitest and jest are spawned from the repo's own node_modules; the CLI supplies
// playwright and the tsx behind node-test/bundled, so only those two can be missing.
const REPO_INSTALLED_RUNNERS: ReadonlySet<TestRunner> = new Set<TestRunner>(["vitest", "jest"]);
const JS_RUNNERS: ReadonlySet<TestRunner> = new Set<TestRunner>(["vitest", "jest", "node-test", "bundled"]);

export function runnerAvailable(runner: TestRunner, setup: DetectedSetup): boolean {
  if (!REPO_INSTALLED_RUNNERS.has(runner)) return true;
  if (setup.frameworks.some((f) => f.name === runner)) return true;
  // Nothing detected AND no dependency list read is a blind spot; a list we did read
  // and that holds no runner is an answer — npx would cancel on the missing package.
  return !setup.frameworks.length && setup.dependencies == null;
}

/** The runner a JS test can actually be spawned with. Never a python or go one. */
function jsRunnerFor(setup: DetectedSetup): TestRunner {
  const f = fallbackRunnerFor(setup);
  return JS_RUNNERS.has(f) ? f : "bundled";
}

export function normalizeRawTests(raw: unknown, knownIds: Set<string>, fallbackRunner: TestRunner, setup?: DetectedSetup): RawPlanTest[] {
  return normalizeManifestTests(raw, knownIds, fallbackRunner, setup).filter((t) => t.origin === "existing" || t.content);
}

// Manifest entries carry no content for generated tests; the authoring step fills it in.
// `setup` is optional on the same terms as everything else here: absent means we cannot
// know what the repo has, so the runner the model picked stands.
export function normalizeManifestTests(raw: unknown, knownIds: Set<string>, fallbackRunner: TestRunner, setup?: DetectedSetup): RawPlanTest[] {
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
    const picked = RUNNERS.has(String(o.runner)) ? (o.runner as TestRunner) : level === "e2e" ? "playwright" : fallbackRunner;
    // Coerce rather than drop: the criterion stays covered. Before normalizeGeneratedPath,
    // which keys the path prefix off the runner.
    const runner = origin === "generated" && setup && !runnerAvailable(picked, setup) ? jsRunnerFor(setup) : picked;
    const content = typeof o.content === "string" && o.content.trim() ? o.content : null;
    const moved = origin === "generated" ? normalizeGeneratedPath(path, runner) : null;
    const safe = origin === "generated" ? moved?.path : path.replace(/^\.\//, "");
    if (!safe || safe.split("/").includes("..")) continue;
    out.push({
      path: safe,
      content: origin === "generated" ? content : null,
      rebaseFrom: moved?.from,
      criterionIds: [...new Set(ids)],
      level,
      levelReason: typeof o.levelReason === "string" ? o.levelReason.slice(0, 300) : "",
      origin,
      runner,
      targetFiles: Array.isArray(o.targetFiles) ? o.targetFiles.map(String).slice(0, 20) : [],
      ...(typeof o.strategy === "string" && o.strategy.trim() ? { strategy: o.strategy.slice(0, 500) } : {}),
    });
  }
  return out;
}

export type UnresolvedImport = SkippedSpecifier & { path: string };

const REWRITABLE_EXT = /\.[cm]?[jt]sx?$/;
const MAX_UNRESOLVED = 50;

/** Generated files keyed by extensionless origin path. Two survivors claiming one origin
 *  make no redirect knowably right, so neither is redirected. */
export function movedSiblings<T extends { path: string; rebaseFrom?: string }>(
  shipped: readonly T[],
  // Everything that claimed an origin, shipped or not. An origin two tests claimed names no
  // one file, so a referrer that imports it must not be handed whichever twin survived.
  claimed: readonly { rebaseFrom?: string }[] = shipped
): Map<string, string> {
  const claims = new Map<string, number>();
  for (const t of claimed) {
    if (!t.rebaseFrom) continue;
    const stem = withoutExt(t.rebaseFrom);
    claims.set(stem, (claims.get(stem) ?? 0) + 1);
  }
  const siblings = new Map<string, string>();
  for (const t of shipped) {
    if (!t.rebaseFrom) continue;
    const stem = withoutExt(t.rebaseFrom);
    if ((claims.get(stem) ?? 0) > 1) continue;
    siblings.set(stem, t.path);
  }
  return siblings;
}

/**
 * Re-anchor the generated tests that actually ship. Filters nothing and never
 * touches `path` — testSignature reads it, so moving one would reset that test's
 * flake history.
 */
export function rebaseGeneratedContent<T extends { path: string; content: string | null; rebaseFrom?: string }>(
  tests: readonly T[],
  opts: { exists?: (p: string) => boolean; claimed?: readonly { rebaseFrom?: string }[] } = {}
): { tests: T[]; unresolved: UnresolvedImport[] } {
  const siblings = movedSiblings(tests, opts.claimed ?? tests);
  const unresolved: UnresolvedImport[] = [];
  const out = tests.map((t) => {
    // Only JS/TS imports are re-anchored; a pytest or go file is relocated too,
    // but its imports are by module name, which the move does not disturb.
    if (!t.rebaseFrom || !t.content || !REWRITABLE_EXT.test(t.path)) return t;
    const content = rebaseRelativeImports(t.content, t.rebaseFrom, t.path, {
      siblings,
      exists: opts.exists,
      onUnresolved: (skipped) => {
        if (unresolved.length < MAX_UNRESOLVED) unresolved.push({ path: t.path, ...skipped });
      },
    });
    return content === t.content ? t : { ...t, content };
  });
  return { tests: out, unresolved };
}

export function normalizeUnverifiable(raw: unknown, knownIds: Set<string>): Array<{ criterionId: string; reason: string }> {
  const list = (raw as { unverifiable?: unknown })?.unverifiable;
  if (!Array.isArray(list)) return [];
  return list
    .map((u) => ({ criterionId: String((u as any)?.criterionId ?? ""), reason: String((u as any)?.reason ?? "").slice(0, 300) }))
    .filter((u) => knownIds.has(u.criterionId));
}

export type PlanViolation = "missing_existing" | "pr_authored" | "level" | "off_target";

// A component test renders into a DOM shim with no layout engine, so behaviour
// that only real geometry can settle — canvas, drag, virtualised lists — is
// invisible one rung below the browser. Such a criterion may overshoot its cap
// by exactly that rung, and only with a reason naming what component cannot see.
const MIN_ESCALATION_REASON = 20;

export function mayEscalateToBrowser(t: RawPlanTest, policy: PlanPolicy): boolean {
  if (t.level !== "e2e" || !policy.e2eAllowed || policy.apiOnly) return false;
  if ((t.levelReason ?? "").trim().length < MIN_ESCALATION_REASON) return false;
  return t.criterionIds.some((id) => policy.maxLevel.get(id) === "component");
}

/**
 * Whether a browser test was still open to a criterion the model called unverifiable —
 * either its cap already says e2e, or it is capped at component on a frontend diff and
 * could have escalated. Only then is re-asking worth a second call.
 */
export function hasUntriedRung(criterionId: string, policy: PlanPolicy): boolean {
  const cap = policy.maxLevel.get(criterionId);
  // The component rung stays open with no boot config — but only where the repo can
  // actually render; re-asking otherwise just pressures the model into an import it
  // does not have.
  return cap === "e2e" || (cap === "component" && !policy.apiOnly && policy.componentCapable);
}

/** Drop existing tests that aren't in the tree (hallucinated), tests this PR wrote, and tests above their allowed level. */
export function enforcePlanPolicy(
  tests: RawPlanTest[],
  policy: PlanPolicy,
  treePaths: Set<string>
): { kept: RawPlanTest[]; violations: Array<{ test: RawPlanTest; reason: PlanViolation }> } {
  const kept: RawPlanTest[] = [];
  const violations: Array<{ test: RawPlanTest; reason: PlanViolation }> = [];
  for (const t of tests) {
    if (t.origin === "existing" && !treePaths.has(t.path)) {
      violations.push({ test: t, reason: "missing_existing" });
      continue;
    }
    if (t.origin === "existing" && policy.prAuthoredTests.has(t.path)) {
      violations.push({ test: t, reason: "pr_authored" });
      continue;
    }
    if (t.origin === "generated") {
      const withinCap = t.criterionIds.some((id) => LEVEL_RANK[t.level] <= LEVEL_RANK[policy.maxLevel.get(id) ?? "unit"]);
      if ((!withinCap && !mayEscalateToBrowser(t, policy)) || (t.level === "e2e" && !policy.e2eAllowed)) {
        violations.push({ test: t, reason: "level" });
        continue;
      }
      // A target the tree does not have is a hallucinated module (a changed file is real by
      // definition); a test below e2e that targets none of the changed files is testing the
      // wrong module.
      const targetFiles = t.targetFiles.map((p) => p.replace(/^\.\//, "")).filter((p) => treePaths.has(p) || policy.touchedSources.has(p));
      if (t.level !== "e2e" && policy.touchedSources.size && !targetFiles.some((p) => policy.touchedSources.has(p))) {
        violations.push({ test: t, reason: "off_target" });
        continue;
      }
      kept.push(targetFiles.length === t.targetFiles.length ? t : { ...t, targetFiles });
      continue;
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

// A login script and form credentials can carry secrets, so the prompt only learns that they exist.
function renderVerifyBlock(yml: DevasignVerifyConfig | null): string {
  if (!yml) return "none";
  const { servers, login, ...rest } = yml;
  return [
    JSON.stringify({ ...rest, ...(login?.strategy ? { login: { strategy: login.strategy } } : {}) }),
    servers?.length ? `servers: ${servers.map((s) => s.name).join(", ")}` : "",
    login?.script ? "login script: yes" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function renderSetup(setup: DetectedSetup, yml: DevasignVerifyConfig | null): string {
  const fw = setup.frameworks.map((f) => `${f.name}${f.version ? `@${f.version}` : ""}${f.configPath ? ` (${f.configPath})` : ""}`).join(", ") || "none detected";
  const deps = setup.dependencies ?? [];
  return [
    `- Languages: ${setup.languages.join(", ") || "unknown"}`,
    `- Package manager: ${setup.packageManager ?? "unknown"}`,
    `- Test frameworks: ${fw}`,
    setup.dependencies == null
      ? "- Installed packages: unknown (no package.json seen)"
      : deps.length
        ? `- Installed packages (the ONLY ones a test may import): ${deps.join(", ")}`
        : "- Installed packages: none — nothing is installed where these tests run, so a test may use only Node builtins and the runner's own assertions.",
    `- Test commands: ${setup.testCommands.join("; ") || "none"}`,
    setup.packages?.length
      ? `- Packages (no root package.json): ${setup.packages.map((d) => `${d}/`).join(", ")} — each installs its own dependencies, which its source files resolve from their own directory. A generated test lives under .devasign/tests/ and resolves bare imports from the repository root, so it may import repository source only by relative path.`
      : "",
    `- Services: ${setup.services.join(", ") || "none"}`,
    setup.monorepo ? `- Monorepo: ${setup.monorepo.tool} (${setup.monorepo.packages.join(", ")})` : "",
    `- .devasign.yml verify: ${renderVerifyBlock(yml)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const MAX_CHANGED_LISTED = 80;

// The only inventory of source paths the planner sees, so it names real modules.
function renderChanged(ctx: PlanContext): string[] {
  if (!ctx.changed.length) return [];
  return [
    `## Files changed by this PR (${ctx.changed.length})`,
    "A generated unit, integration or component test must name at least one of these in targetFiles, spelled exactly as listed; " +
      "a test that targets only other files is dropped. Reach other modules only through these.",
    ...ctx.changed.slice(0, MAX_CHANGED_LISTED).map((c) => `  - ${c.path}${c.exports.length ? ` (exports: ${c.exports.slice(0, 8).join(", ")})` : ""}`),
    "",
  ];
}

function renderCriteria(criteria: Criterion[]): string {
  return criteria.map((c) => `- [${c.id}] (${c.kind ?? "code"})${c.implied ? " [implied]" : ""} ${c.text}`).join("\n");
}

function renderPolicy(policy: PlanPolicy, ids: string[], setup: DetectedSetup, yml: DevasignVerifyConfig | null): string {
  const hasPlaywright = setup.frameworks.some((f) => f.name === "playwright");
  return [
    ...ids.map((id) => `- [${id}]: max level ${policy.maxLevel.get(id)}`),
    policy.e2eAllowed
      ? "- Browser (e2e) tests: available"
      : `- Browser (e2e) tests: not available (${policy.e2ePolicy === "never" ? "e2e: never" : NO_BOOT_REASON}).` +
        (policy.componentCapable
          ? " UI criteria remain testable at component level: render the component with its real state and assert on the DOM. Mark a UI criterion unverifiable only if no component test could decide it."
          : " No component-test environment either — the repository has no render library or DOM environment among its installed packages, and nothing may be added. Prove what you can through the plain modules the component delegates to, in the repo's own convention; mark a UI criterion unverifiable only when no such test could decide it."),
    `- Diff scope: ${policy.apiOnly ? "api-only (no frontend files touched)" : "includes frontend files"}`,
    // Without this the model reads "Test frameworks: vitest" and rules the
    // browser out, even where the runner would have supplied one.
    policy.e2eAllowed && !hasPlaywright
      ? "- Playwright: supplied by the runner, browsers installed automatically — plan e2e tests even though the repo has no Playwright dependency of its own."
      : "",
    policy.e2eAllowed && !policy.apiOnly
      ? "- A criterion capped at component may still be planned at e2e when only a real browser can observe it, if levelReason says what component cannot see."
      : "",
    policy.e2eAllowed && yml?.login?.script ? "- Browser tests start signed in (the runner applies a saved session); never sign in inside a test." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type PlanContext = {
  run: VerifyRun;
  repo: Repository;
  install: Installation;
  criteria: Criterion[];
  diff: string;
  treePaths: Set<string>;
  // False when GitHub capped the tree listing: a path absent from treePaths may still be there,
  // so nothing may be rejected or re-anchored for being missing.
  treeComplete: boolean;
  setup: DetectedSetup;
  yml: DevasignVerifyConfig | null;
  ymlFrom: "head" | "base" | "base_boot" | null;
  policy: PlanPolicy;
  // UI criteria kept from the model: `e2e: always` with nothing to boot forbids proving them below the browser.
  withheld: Criterion[];
  existingTests: string[];
  // Non-test files the PR changes, with their exported symbols when the index knows them.
  changed: Array<{ path: string; exports: string[] }>;
  candidates: Array<{ path: string; imports: string[] }>;
  flakeNotes: string[];
  prTitle: string;
};

export type ReplanCohorts = { level: string[]; escalate: string[]; fallback?: string[] };

function replanHeader(r: ReplanCohorts): string {
  const lines = ["## Re-plan ONLY these criteria"];
  if (r.level.length)
    lines.push(
      `- [${r.level.join("], [")}]: your previous test was rejected — it was above the max level, or it targeted files this PR did not change. ` +
        "Plan at or below the max level below, with targetFiles naming a file from the changed list."
    );
  if (r.escalate.length)
    lines.push(
      `- [${r.escalate.join("], [")}]: you marked these unverifiable, but the Level policy below still allows a rung you did not attempt. ` +
        "Plan a test at the highest level the policy allows for it, with a levelReason naming what the level beneath it cannot observe, and when that level is e2e add a fallback below it too. Repeat the unverifiable entry only if no test at any allowed level could decide the criterion."
    );
  if (r.fallback?.length)
    lines.push(
      `- [${r.fallback.join("], [")}]: covered only by a browser test, which can fail to run for reasons that have nothing to do with the change. ` +
        "Plan each a fallback: a generated test at the cheapest level below e2e that can observe the logic behind it, never a test file this PR adds or changes. Do not plan another browser test for these."
    );
  // The criteria list follows immediately; without the break it reads as one list.
  return lines.join("\n") + "\n";
}

export function buildPlannerUserPrompt(ctx: PlanContext, opts: { replan?: ReplanCohorts } = {}): string {
  const replanIds = opts.replan ? [...opts.replan.level, ...opts.replan.escalate, ...(opts.replan.fallback ?? [])] : [];
  const target = opts.replan ? ctx.criteria.filter((c) => replanIds.includes(c.id)) : ctx.criteria;
  const lines = [
    `# Test plan for PR "${ctx.prTitle}" (${ctx.repo.owner}/${ctx.repo.name}#${ctx.run.prNumber})`,
    "",
    opts.replan ? replanHeader(opts.replan) : "## Acceptance criteria",
    renderCriteria(target),
    "",
    "## Level policy",
    renderPolicy(ctx.policy, target.map((c) => c.id), ctx.setup, ctx.yml),
    "",
    ...renderChanged(ctx),
    "## Repository test setup",
    renderSetup(ctx.setup, ctx.yml),
    "",
    `## Existing test files (${ctx.existingTests.length})`,
    ctx.policy.prAuthoredTests.size
      ? `(${ctx.policy.prAuthoredTests.size} test ${ctx.policy.prAuthoredTests.size === 1 ? "file" : "files"} this PR adds or changes ${ctx.policy.prAuthoredTests.size === 1 ? "is" : "are"} withheld from this list and may not be cited.)`
      : "",
    ...ctx.existingTests.slice(0, MAX_EXISTING_LISTED).map((p) => `  - ${p}`),
    "",
    "## Existing tests touching the diff",
    ...(ctx.candidates.length ? ctx.candidates.map((c) => `  - ${c.path} (imports: ${c.imports.slice(0, 6).join(", ")})`) : ["  (none found)"]),
    "",
    "## Flake history",
    ...(ctx.flakeNotes.length ? ctx.flakeNotes : ["- none"]),
    "",
    renderDiff(ctx),
  ];
  return lines.join("\n");
}

const MANIFEST_BUDGETS = [8_000, 16_000];
const BODY_BUDGETS = [12_000, 24_000];
const PLAN_BODY_CONCURRENCY = 3;
const BOOT_REASON_HINT = /app start|login|boot/i;

type PlanManifest = { tests?: unknown; unverifiable?: unknown };
type PlanAttempts = { manifest: StructuredAttempt[]; replan?: StructuredAttempt[]; bodies: Record<string, StructuredAttempt[]> };

// A model sometimes sends a list as the JSON text of one, and its repair pass has repeated
// that — losing a whole re-plan — so a string that parses to a list is read as the list.
function listOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function validateManifest(input: unknown): Validation<PlanManifest> {
  const given = input as PlanManifest | null;
  if (!given || typeof given !== "object") return { ok: false, reason: "no plan object in the response" };
  const o = { ...given, tests: listOf(given.tests), unverifiable: listOf(given.unverifiable) };
  if (o.tests != null && !Array.isArray(o.tests)) return { ok: false, reason: "tests is not an array" };
  if (o.unverifiable != null && !Array.isArray(o.unverifiable)) return { ok: false, reason: "unverifiable is not an array" };
  return { ok: true, value: o };
}
const manifestRepair = (reason: string) => `Your previous answer could not be used: ${reason}. Call ${planManifestTool.name} now with the complete plan.`;

// retryStructured allows exactly one repair pass, so the reason has to carry everything
// the model needs to rewrite the file — including what it may import instead.
export function makeTestFileValidator(
  allow: ImportAllowList,
  onReject?: (bad: string[], missing: string[]) => void,
  path?: string,
  runner?: TestRunner,
  // Where the file's relative imports are anchored and what exists there; absent = unchecked.
  resolve?: { exists: (p: string) => boolean; siblings?: ReadonlyMap<string, string> }
): (input: unknown) => Validation<{ content: string }> {
  let calls = 0;
  return (input) => {
    const given = input as { content?: unknown; path?: unknown } | null;
    const content = given?.content;
    if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "content is empty" };
    const bad = disallowedImports(content, allow);
    const file = path ?? (typeof given?.path === "string" ? given.path : "");
    const unparsable = syntaxError(file, content);
    // Checked every time, against the target the rebase will anchor on rather than the
    // specifier as written: a relative import of nothing is a suite that never loads.
    const missing = resolve && file ? unresolvedRelativeImports(content, file, resolve.exists, resolve.siblings) : [];
    // First answer only: a pattern check is a nudge, and a spec that insists may be right.
    // Asked later, it would drop a file whose only repair went to a syntax error. A wait that
    // can never return is not a nudge — it is refused every time, as `unparsable` is.
    const patterns =
      calls++ === 0
        ? [...specLint(content, allow.names, runner), ...historyLint(content), ...moduleSyntaxLint(file, content, runner)]
        : specLintCertain(content, runner);
    if (!bad.length && !unparsable && !patterns.length && !missing.length) return { ok: true, value: { content } };
    // Reported every failure, empty included, so a later syntax-only miss is not blamed on a package.
    onReject?.(bad, missing);
    const available = [...allow.names].sort().join(", ") || "none";
    const problems = [
      unparsable ? `it does not parse — ${unparsable} — and a spec that cannot load fails every other spec run beside it` : "",
      missing.length
        ? `it imports ${missing.map((m) => `"${m}"`).join(", ")} relative to ${file}, which do not exist in the repository — a relative import must point at a real repository file from this test's own location (e.g. "../../src/module.ts"), and any helper must be defined inside the test file`
        : "",
      bad.length
        ? `it imports ${bad.map((b) => `"${b}"`).join(", ")}, which this repository does not have — the runner installs nothing, so the suite would fail to load. ` +
          `Rewrite it using only these packages: ${available}; Node builtins; and the runner's own assertions. ` +
          "If the criterion cannot be proven without a package that is missing, return a file that proves as much of it as you can"
        : "",
      ...patterns,
    ];
    return { ok: false, reason: problems.filter(Boolean).join("; and ") };
  };
}
const testFileRepair = (reason: string) => `Your previous answer could not be used: ${reason}. Call ${planTestFileTool.name} now with the complete file contents.`;

function askPlanner<T>(
  llm: PlannerLLM,
  system: string,
  user: string,
  tool: StructuredTool,
  budgets: number[],
  validate: (input: unknown) => Validation<T>,
  repairPrompt: (reason: string) => string
) {
  return retryStructured<T>({
    call: (maxTokens, messages) => llm({ system, messages, maxTokens, tool }),
    messages: [{ role: "user", content: user }],
    budgets,
    validate,
    repairPrompt,
  });
}

function renderDiff(ctx: PlanContext): string {
  return ["## Diff", "```diff", formatRawDiff(truncateDiffAtHunkBoundary(ctx.diff, DIFF_CAP).text), "```"].join("\n");
}

function renderSharedContext(ctx: PlanContext): string {
  return ["# Shared context", "", "## Repository test setup", renderSetup(ctx.setup, ctx.yml), "", renderDiff(ctx)].join("\n");
}

const renderSourceFile = (f: SourceFile) => `### ${f.path}${f.truncated ? " (truncated)" : ""}\n\`\`\`\`\n${f.content}\n\`\`\`\``;

export function buildTestFilePrompt(ctx: PlanContext, t: RawPlanTest & { strategyVersion?: number }, source: SourceFile[] = []): string {
  const byId = new Map(ctx.criteria.map((c) => [c.id, c]));
  return [
    `# Write the test file for PR "${ctx.prTitle}" (${ctx.repo.owner}/${ctx.repo.name}#${ctx.run.prNumber})`,
    `- path: ${t.rebaseFrom ?? t.path}`,
    `- runner: ${t.runner}`,
    `- level: ${t.level}${t.levelReason ? ` (${t.levelReason})` : ""}`,
    "- criteria:",
    ...t.criterionIds.map((id) => `  - [${id}] ${byId.get(id)?.text ?? ""}`),
    // The planner never sees the app, so its setup steps for a browser test are guesses the
    // author follows over what the source shows; the criteria already say what to prove.
    t.strategy && t.runner !== "playwright" ? `- strategy: ${t.strategy}` : "",
    t.targetFiles.length ? `- targetFiles: ${t.targetFiles.join(", ")}` : "",
    (t.strategyVersion ?? 1) > 1
      ? `- strategy version: ${t.strategyVersion} — the previous version of this test was flaky; take a different approach (explicit state assertions, role/test-id selectors, isolated data).`
      : "",
    "",
    ...(t.runner === "playwright" ? routeLines(source, ctx.treePaths) : []),
    ...(t.runner === "playwright" ? waysIn(source, ctx.treePaths) : []),
    ...(!source.length
      ? []
      : t.runner === "playwright"
        ? ["## App source", "What this PR's head renders — build every step and selector of the flow from it.", ...source.map(renderSourceFile)]
        : [
            "## Source under test",
            "The code this test calls and what it imports, with the runner's config when it has one, as this PR's head has them. Take every name, value and shape from here.",
            ...source.map(renderSourceFile),
          ]),
    ...(t.runner === "playwright" ? libraryNotes(ctx.setup.dependencies) : []),
    // Measured on a real run: 9 of 18 spec timeouts sat on "/" waiting for a screen mounted at
    // another URL, and 3 more asserted on seeded data the spec had invented.
    ...(t.runner === "playwright"
      ? [
          "## Writing the spec",
          "Navigate to the URL that renders the flow — take it from the URL map above when one is listed. `/` is often a redirect, and a spec that waits there for a screen mounted elsewhere times out.",
          "Assert only on data the spec creates itself or that the source shows is built in. Never invent an entity name; where a list only has to be non-empty, discover its first row instead of naming one.",
        ]
      : []),
    `Write the complete file and submit it with ${planTestFileTool.name}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// A branch cut before onboarding carries no verify block, so every PR it opens would plan as
// if the app could not boot; the base branch's block is the one in force for it. A head block
// without `start` keeps its other keys but boots the way base does.
async function readVerifyYml(
  headRaw: string | null,
  headSha: string,
  baseRef: string | undefined,
  read: (ref: string) => Promise<string | null>
): Promise<{ raw: string | null; sha: string; yml: DevasignVerifyConfig | null; from: PlanContext["ymlFrom"] }> {
  const head = parseDevasignVerify(headRaw);
  if (head?.start || !baseRef) return { raw: headRaw, sha: headSha, yml: head, from: head ? "head" : null };
  const baseRaw = await read(baseRef);
  const base = parseDevasignVerify(baseRaw);
  if (!head) return base ? { raw: baseRaw, sha: baseRef, yml: base, from: "base" } : { raw: headRaw, sha: headSha, yml: null, from: null };
  if (!base?.start) return { raw: headRaw, sha: headSha, yml: head, from: "head" };
  return { raw: headRaw, sha: headSha, yml: { ...bootGroup(head, false), ...bootGroup(base, true) }, from: "base_boot" };
}

const BOOT_KEY_SET: ReadonlySet<string> = new Set(BOOT_KEYS);
const bootGroup = (cfg: DevasignVerifyConfig, boot: boolean): DevasignVerifyConfig =>
  Object.fromEntries(Object.entries(cfg).filter(([k]) => BOOT_KEY_SET.has(k) === boot));

async function gatherContext(run: VerifyRun, repo: Repository, install: Installation, deps: PlannerDeps): Promise<PlanContext> {
  const review = db.find("prReviews", (r) => r.id === run.reviewId);
  const { criteria: all } = criteriaForRun(run);
  const only = deps.onlyCriteriaIds ? new Set(deps.onlyCriteriaIds) : null;
  const criteria = all.filter((c) => (c.kind ?? "code") !== "unverifiable" && !c.notApplicable && !c.supersededBy && (!only || only.has(c.id)));
  const [diff, tree] = await Promise.all([
    (deps.fetchDiff ?? defaultFetchDiff)(install, repo, run.prNumber),
    (deps.fetchTree ?? fetchRepoTree)(repo, install, run.sha),
  ]);
  // A capped listing is not an answer about what the repo holds, only about what was read.
  const listed: RepoTree = Array.isArray(tree) ? { tree, truncated: false } : tree;
  const paths = listed.tree.filter((e) => e.type === "blob").map((e) => e.path);
  const treePaths = new Set(paths);
  const readFile = deps.readFile ?? defaultReadFile;
  const [headYml, packageJson, envExample] = await Promise.all([
    treePaths.has(".devasign.yml") ? readFile(install, repo, ".devasign.yml", run.sha) : Promise.resolve(null),
    // Always at run.sha, even when a runner has reported: a PR that adds a dependency
    // must not have its own test judged against the list from before it.
    treePaths.has("package.json") ? readFile(install, repo, "package.json", run.sha) : Promise.resolve(null),
    !repo.verify?.detected && treePaths.has(".env.example") ? readFile(install, repo, ".env.example", run.sha) : Promise.resolve(null),
  ]);
  const boot = await readVerifyYml(headYml, run.sha, review?.baseSha || repo.defaultBranch, (ref) => readFile(install, repo, ".devasign.yml", ref));
  const yml = boot.yml;
  if (boot.raw != null) {
    const devasignYml = { raw: boot.raw.slice(0, 20_000), parsed: yml, sha: boot.sha };
    patchRepoVerify(repo.id, (cur) => ({ ...cur, devasignYml }));
  }
  const inferred = inferSetupFromTree(paths, { packageJson, envExample });
  const detected = repo.verify?.detected ?? inferred;
  // The runner's list unions the workspaces, the head manifest is current: take both,
  // and leave it absent when neither could be read so the allow-list stays off.
  const dependencies =
    detected.dependencies || inferred.dependencies ? [...new Set([...(detected.dependencies ?? []), ...(inferred.dependencies ?? [])])].sort() : undefined;
  const setup: DetectedSetup = { ...detected, ...(dependencies ? { dependencies } : {}) };
  const touched = diffPaths(diff);
  const wf = effectiveWorkflow(repo);
  const policy = planPolicy({ criteria, wfE2e: wf.verify?.e2e ?? "auto", yml, setup, touched });
  const withheld = policy.e2ePolicy === "always" && !policy.bootConfigured ? criteria.filter((c) => (c.kind ?? "code") === "ui") : [];
  const planned = withheld.length ? criteria.filter((c) => !withheld.includes(c)) : criteria;
  // The tree is the PR head, so it holds the tests the PR itself wrote. Keeping
  // them off both lists is what stops a change being graded by its own tests.
  const existingTests = paths.filter((p) => isTestPath(p) && !policy.prAuthoredTests.has(p));
  const indexed = new Map(db.filter("repoIndex", (e) => e.repoId === repo.id && policy.touchedSources.has(e.path)).map((e) => [e.path, e.exports]));
  const changed = [...policy.touchedSources].filter((p) => treePaths.has(p)).map((path) => ({ path, exports: indexed.get(path) ?? [] }));
  const touchedStems = new Set(touched.map((p) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "")));
  const candidates = db
    .filter("repoIndex", (e) => e.repoId === repo.id && isTestPath(e.path) && !policy.prAuthoredTests.has(e.path))
    .filter((e) => e.imports.some((imp) => touchedStems.has((imp.split("/").pop() || imp).replace(/\.[^.]+$/, ""))))
    .slice(0, 20)
    .map((e) => ({ path: e.path, imports: e.imports }));
  const flakeNotes: string[] = [];
  for (const c of planned) {
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
    criteria: planned,
    diff,
    treePaths,
    treeComplete: !listed.truncated,
    setup,
    yml,
    ymlFrom: boot.from,
    policy,
    withheld,
    existingTests,
    changed,
    candidates,
    flakeNotes,
    prTitle: review?.prTitle ?? `PR #${run.prNumber}`,
  };
}

async function retriggerRunner(run: VerifyRun, repo: Repository, install: Installation, deps: PlannerDeps): Promise<void> {
  try {
    await (deps.dispatch ?? defaultDispatch)(install, repo, { pr: run.prNumber, sha: run.sha, runId: run.id, reviewId: run.reviewId });
    forgetRunnerPoll(repo.id, run.prNumber, run.sha);
    db.insert("reviewLogs", { id: uuid(), reviewId: run.reviewId, kind: "verify", at: Date.now(), action: "Runner re-triggered: the plan was not ready when CI asked", meta: { runId: run.id } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verify] repository_dispatch failed for ${repo.owner}/${repo.name}:`, msg);
    db.insert("reviewLogs", { id: uuid(), reviewId: run.reviewId, kind: "verify", at: Date.now(), action: "Could not re-trigger the runner", detail: `${msg.slice(0, 300)} — the workflow needs a repository_dispatch trigger and the App needs contents:write; push a commit to re-run instead.`, meta: { runId: run.id } });
  }
}

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 100) / 10)}s`;

/**
 * A runner that quits between the plan landing and RUNNER_GONE_MS elapsing would strand the
 * run in awaiting_runner until the reaper times it out an hour later. Re-check once.
 */
function scheduleGiveUpRecheck(run: VerifyRun, repo: Repository, install: Installation, deps: PlannerDeps): void {
  const timer = setTimeout(() => {
    const fresh = db.find("verifyRuns", (r) => r.id === run.id);
    if (!fresh || fresh.status !== "awaiting_runner" || fresh.timings.resolvedAt != null) return;
    if (!runnerGaveUp(repo.id, run.prNumber, run.sha)) return;
    void retriggerRunner(fresh, repo, install, deps);
  }, RUNNER_GONE_MS + 5_000);
  timer.unref?.();
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
  // The review may have already posted its comment while planning ran long; every
  // terminal outcome (ready, skipped, failed) has to refresh it.
  const settle = async (updated: VerifyRun | null): Promise<VerifyRun | null> => {
    if (updated?.report?.commentId) {
      try {
        await rerenderReport(run.id);
      } catch (err) {
        console.warn(`[verify] could not refresh the report for run ${run.id}:`, err);
      }
    }
    return updated;
  };
  const model = modelForPlan(run.planTier);
  return withModel(model, () =>
    withUsage(async () => {
      try {
        const ctx = await gatherContext(run, repo, install, deps);
        const gatherMs = Date.now() - planStartedAt;
        if (!ctx.criteria.length && !ctx.withheld.length) {
          return await settle(updateRun(run.id, { status: "skipped", skipReason: "no_criteria", timings: { ...run.timings, planStartedAt, planFinishedAt: Date.now() } }));
        }
        const wf = effectiveWorkflow(repo);
        const system = withMaintainerInstructions(testPlannerSystemPrompt(), wf.prompts?.verify);
        const llm = plannerLLM(deps.llm ?? defaultLLM, run.planTier);
        const knownIds = new Set(ctx.criteria.map((c) => c.id));
        const fallbackRunner = fallbackRunnerFor(ctx.setup);

        const attempts: PlanAttempts = { manifest: [], bodies: {} };
        const cutOff = new Set<string>();
        const unusable = new Set<string>();
        const missingPackage = new Set<string>();
        const missingImport = new Set<string>();
        const lose = (ids: Iterable<string>, stop: string | null) => {
          for (const id of ids) (stop === "max_tokens" ? cutOff : unusable).add(id);
        };

        const llmStartedAt = Date.now();
        // Every criterion withheld leaves the model nothing to plan; the plan still records why.
        const first = ctx.criteria.length
          ? await askPlanner<PlanManifest>(llm, system, buildPlannerUserPrompt(ctx), planManifestTool, MANIFEST_BUDGETS, validateManifest, manifestRepair)
          : null;
        const firstLlmMs = Date.now() - llmStartedAt;
        attempts.manifest = first?.attempts ?? [];
        if (first && !first.value) lose(knownIds, first.lastStopReason);
        const parsed = first?.value ?? {};
        let tests = normalizeManifestTests(parsed, knownIds, fallbackRunner, ctx.setup);
        const unverifiable = new Map(normalizeUnverifiable(parsed, knownIds).map((u) => [u.criterionId, u.reason]));
        let { kept, violations } = enforcePlanPolicy(tests, ctx.policy, ctx.treePaths);
        const dropped = violations.map((v) => `${v.test.path} (${v.reason})`);

        // One re-plan, covering three cohorts: criteria a violating test left uncovered, criteria
        // waved off as unverifiable while a rung was still open, and criteria only a browser test
        // covers — a browser that cannot boot would leave those with no verdict at all.
        const covered = new Set(kept.flatMap((t) => t.criterionIds));
        const uncovered = ctx.criteria.map((c) => c.id).filter((id) => !covered.has(id) && !unverifiable.has(id));
        const violatedIds = uncovered.filter((id) => violations.some((v) => v.test.criterionIds.includes(id)));
        const escapedIds = [...unverifiable.keys()].filter((id) => !covered.has(id) && hasUntriedRung(id, ctx.policy));
        const coveredAt = (id: string, browser: boolean) => kept.some((t) => (t.level === "e2e") === browser && t.criterionIds.includes(id));
        const fallbackIds = ctx.criteria.map((c) => c.id).filter((id) => coveredAt(id, true) && !coveredAt(id, false));
        const replanIds = [...violatedIds, ...escapedIds, ...fallbackIds];
        let replanMs = 0;
        let replanLost: string | null = null;
        if (replanIds.length) {
          const replanStartedAt = Date.now();
          const user = buildPlannerUserPrompt(ctx, { replan: { level: violatedIds, escalate: escapedIds, fallback: fallbackIds } });
          const second = await askPlanner<PlanManifest>(llm, system, user, planManifestTool, MANIFEST_BUDGETS, validateManifest, manifestRepair);
          replanMs = Date.now() - replanStartedAt;
          attempts.replan = second.attempts;
          if (!second.value) {
            lose(replanIds, second.lastStopReason);
            replanLost = second.lastStopReason;
          }
          const secondJson = second.value ?? {};
          const replanKnown = new Set(replanIds);
          // The last call, and a test this PR wrote cannot vouch for the change it ships with:
          // rather than lose the coverage asked for, DevAsign writes that test itself.
          const ownTest = (t: unknown) => {
            const o = t as { origin?: unknown; path?: unknown } | null;
            return o?.origin === "existing" && typeof o.path === "string" && ctx.policy.prAuthoredTests.has(o.path.replace(/^\.\//, ""));
          };
          const listed = (secondJson as PlanManifest).tests;
          const asked = Array.isArray(listed) ? { ...secondJson, tests: listed.map((t) => (ownTest(t) ? { ...(t as object), origin: "generated" } : t)) } : secondJson;
          // The fallback cohort already has its browser test; a second one is not what was asked.
          const browserCovered = new Set(fallbackIds);
          const again = normalizeManifestTests(asked, replanKnown, fallbackRunner, ctx.setup).filter(
            (t) => t.level !== "e2e" || t.criterionIds.some((id) => !browserCovered.has(id))
          );
          const enforced = enforcePlanPolicy(again, ctx.policy, ctx.treePaths);
          kept = [...kept, ...enforced.kept];
          for (const u of normalizeUnverifiable(secondJson, replanKnown)) unverifiable.set(u.criterionId, u.reason);
          for (const v of enforced.violations) dropped.push(`${v.test.path} (${v.reason}, re-plan)`);
        }

        // Two generated tests given one path would overwrite each other on disk, and the report
        // would credit both with whichever was written last.
        const taken = new Set<string>();
        kept = kept.map((t) => {
          if (t.origin !== "generated") return t;
          let path = t.path;
          for (let n = 2; taken.has(path); n++) path = t.path.replace(/([^/.]+)((?:\.[^/.]+)*)$/, `$1-${n}$2`);
          taken.add(path);
          return path === t.path ? t : { ...t, path };
        });

        // Signatures, quarantine strategy bumps, and retirement — before any file
        // is authored, so a retired test costs no body call.
        const critText = new Map(ctx.criteria.map((c) => [c.id, c.text]));
        const survivors: Array<RawPlanTest & { signature: string; strategyVersion: number }> = [];
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
          survivors.push({ ...t, signature, strategyVersion });
        }

        // One call per generated file, so a cut costs that file alone.
        const bodySystem = `${withMaintainerInstructions(testFileSystemPrompt(), wf.prompts?.verify)}\n\n${renderSharedContext(ctx)}`;
        const authored = new Map<object, string>();
        const bodyFailed: string[] = [];
        const generated = survivors.filter((t) => t.origin === "generated");
        // The files in one plan crawl the same code, so each repo file is read once.
        const headReads = new Map<string, Promise<string | null>>();
        const readHead = (p: string) => {
          if (!headReads.has(p)) headReads.set(p, (deps.readFile ?? defaultReadFile)(install, repo, p, run.sha));
          return headReads.get(p)!;
        };
        // A sibling planned in this batch is as real as a tree path once it is written — but
        // only where it IS written: a rebaseFrom is the path the model named, which nothing
        // creates, so counting one would let a clamp land on a file that never exists.
        const plannedPaths = new Set(survivors.map((s) => s.path));
        const inRepo = (p: string) => ctx.treePaths.has(p) || plannedPaths.has(p);
        const plannedSiblings = movedSiblings(survivors);
        const author = async (t: (typeof survivors)[number]) => {
          // Per test, not per run: the allow-list depends on t.runner and the pool runs
          // three of these at once.
          let rejected: string[] = [];
          let unresolved: string[] = [];
          const validate = makeTestFileValidator(
            buildImportAllowList(ctx.setup, t.runner),
            (bad, missing) => {
              rejected = bad;
              unresolved = missing;
            },
            t.rebaseFrom ?? t.path,
            t.runner,
            ctx.treeComplete ? { exists: inRepo, siblings: plannedSiblings } : undefined
          );
          try {
            // vitest reads the Vite config when it has none of its own, and a Vite app keeps its
            // `test` block there.
            const config =
              ctx.setup.frameworks.find((f) => f.name === t.runner)?.configPath ??
              (t.runner === "vitest" ? [...ctx.treePaths].find((p) => /^vite\.config\.[cm]?[jt]s$/.test(p)) : undefined);
            const source = await (t.runner === "playwright"
              ? appSourceFor({ targetFiles: t.targetFiles, tree: ctx.treePaths, read: readHead })
              : sourceUnderTest({ targetFiles: t.targetFiles, config, tree: ctx.treePaths, read: readHead })
            ).catch(() => []);
            const r = await askPlanner<{ content: string }>(llm, bodySystem, buildTestFilePrompt(ctx, t, source), planTestFileTool, BODY_BUDGETS, validate, testFileRepair);
            attempts.bodies[t.path] = r.attempts;
            if (r.value) {
              const configSource = config ? source.find((f) => f.path === config)?.content : undefined;
              return void authored.set(t, withDomEnvironment(r.value.content, { runner: t.runner, dependencies: ctx.setup.dependencies ?? [], config: configSource }));
            }
            bodyFailed.push(`${t.path} (${r.attempts.at(-1)?.reason ?? "no answer"})`);
            if (rejected.length) for (const id of t.criterionIds) missingPackage.add(id);
            else if (unresolved.length) for (const id of t.criterionIds) missingImport.add(id);
            lose(t.criterionIds, r.lastStopReason);
          } catch (err) {
            bodyFailed.push(`${t.path} (${err instanceof Error ? err.message : String(err)})`.slice(0, 300));
            lose(t.criterionIds, null);
          }
        };
        const bodiesStartedAt = Date.now();
        // The first file alone, so the shared-context cache write lands before the pool fans out.
        if (generated.length) {
          await author(generated[0]);
          await runPool(generated.slice(1), PLAN_BODY_CONCURRENCY, author, "planner");
        }
        const bodiesMs = generated.length ? Date.now() - bodiesStartedAt : 0;
        const withContent = survivors.flatMap((t) => {
          if (t.origin !== "generated") return [t];
          const content = authored.get(t);
          return content ? [{ ...t, content }] : [];
        });
        // Only here is the written set final — both planner batches, past policy,
        // retirement and authoring — so a sibling redirect can only point at a file
        // the runner actually writes. Any filter added after this reopens that bug.
        const writtenPaths = new Set(withContent.map((t) => t.path));
        const { tests: rebased, unresolved } = rebaseGeneratedContent(withContent, {
          exists: ctx.treeComplete ? (p) => ctx.treePaths.has(p) || writtenPaths.has(p) : undefined,
          // Survivors, not the written set: a twin dropped while its body was authored still
          // makes its origin ambiguous, so the referrer is reported rather than redirected.
          claimed: survivors,
        });
        // Minting the id here keeps buildCommands(finalTests) from ever running
        // against a stale array or ids that no longer exist.
        const finalTests: PlanTest[] = rebased.map((t) => ({
          id: uuid(),
          path: t.path,
          content: t.content,
          criterionIds: t.criterionIds,
          level: t.level,
          levelReason: t.levelReason,
          origin: t.origin,
          runner: t.runner,
          testSignature: t.signature,
          strategyVersion: t.strategyVersion,
          targetFiles: t.targetFiles,
        }));
        const finalCovered = new Set(finalTests.flatMap((t) => t.criterionIds));
        const fixUrl = setupFixUrl(repo.id);
        const browser: VerifyPlanBrowser = {
          policy: ctx.policy.e2ePolicy,
          allowed: ctx.policy.e2eAllowed,
          bootConfigured: ctx.policy.bootConfigured,
          reason: ctx.policy.e2ePolicy === "never" ? "never" : ctx.policy.bootConfigured ? "ok" : "no_boot",
          fixUrl,
        };
        const planUnverifiable: VerifyPlan["unverifiable"] = [];
        // A withheld criterion is uncovered by construction, so it lands in the noBoot branch.
        for (const c of [...ctx.criteria, ...ctx.withheld]) {
          if (finalCovered.has(c.id)) continue;
          const isUi = (c.kind ?? "code") === "ui";
          const noBoot = isUi && !ctx.policy.e2eAllowed && ctx.policy.e2ePolicy !== "never";
          if (retired.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: RETIRED_REASON });
          else if (unverifiable.has(c.id)) {
            const cited = unverifiable.get(c.id)!;
            const reason = noBoot && BOOT_REASON_HINT.test(cited) ? NO_BOOT_REASON : cited;
            planUnverifiable.push({ criterionId: c.id, reason, ...(reason === NO_BOOT_REASON ? { fixUrl } : {}) });
          } else if (cutOff.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: PLAN_CUT_OFF_REASON });
          else if (missingPackage.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: MISSING_PACKAGE_REASON });
          else if (missingImport.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: MISSING_IMPORT_REASON });
          else if (unusable.has(c.id)) planUnverifiable.push({ criterionId: c.id, reason: PLAN_UNUSABLE_REASON });
          else if (noBoot) planUnverifiable.push({ criterionId: c.id, reason: NO_BOOT_REASON, fixUrl });
          else if (isUi && ctx.policy.e2ePolicy === "never")
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
          prAuthoredTests: [...ctx.policy.prAuthoredTests],
          ...(ctx.yml && ctx.ymlFrom ? { verifyConfig: ctx.yml, verifyConfigFrom: ctx.ymlFrom } : {}),
          browser,
          createdAt: Date.now(),
        });
        const planFinishedAt = Date.now();
        const generatedCount = finalTests.filter((t) => t.origin === "generated").length;
        const updated = updateRun(run.id, {
          status: "awaiting_runner",
          planId: plan.id,
          timings: { ...run.timings, planStartedAt, planFinishedAt },
          tokenUsage: { ...run.tokenUsage, plan: usageByProvider() },
        });
        // The runner may have polled while this plan was still queued and given
        // up; nothing else would ever hand it the plan.
        if (runnerGaveUp(repo.id, run.prNumber, run.sha)) await retriggerRunner(run, repo, install, deps);
        else scheduleGiveUpRecheck(run, repo, install, deps);
        const queuedMs = planStartedAt - (run.timings.criteriaFinishedAt ?? run.timings.forkedAt);
        const totalMs = planFinishedAt - planStartedAt;
        const lostLine = (what: string, stop: string | null, n: number) =>
          `${stop === "max_tokens" ? "cut off" : "unusable"}: ${what} ${stop === "max_tokens" ? "stopped at max_tokens" : "returned no usable plan"} after ${n} attempt(s)`;
        db.insert("reviewLogs", {
          id: uuid(),
          reviewId: run.reviewId,
          kind: "verify",
          at: planFinishedAt,
          action: `Test plan ready: ${generatedCount} generated, ${finalTests.length - generatedCount} existing, ${planUnverifiable.length} unverifiable`,
          detail: [
            `planned in ${secs(totalMs)} (queued ${secs(queuedMs)}, gather ${secs(gatherMs)}, llm ${secs(firstLlmMs)}${replanMs ? `, re-plan ${secs(replanMs)}` : ""}${bodiesMs ? `, bodies ${secs(bodiesMs)}` : ""})`,
            ...(ctx.ymlFrom === "base" ? ["app start read from the base branch's .devasign.yml — this PR's head has no verify block of its own"] : []),
            ...(ctx.ymlFrom === "base_boot" ? ["boot keys read from the base branch's .devasign.yml — this PR's head block has no start"] : []),
            ...finalTests.map((t) => `${t.level} ${t.origin} ${t.path} → [${t.criterionIds.join(", ")}] (${t.levelReason})`),
            ...planUnverifiable.map((u) => `unverifiable [${u.criterionId}]: ${u.reason}`),
            ...(!first || first.value ? [] : [lostLine("manifest", first.lastStopReason, first.attempts.length)]),
            ...(attempts.replan && replanLost !== null ? [lostLine("re-plan", replanLost, attempts.replan.length)] : []),
            ...bodyFailed.map((b) => `body failed: ${b}`),
            ...(dropped.length ? [`dropped: ${dropped.join("; ")}`] : []),
            ...(unresolved.length ? [`unresolved imports: ${unresolved.map((u) => `${u.path} → ${u.specifier} (${u.reason})`).join("; ")}`] : []),
          ].join("\n"),
          meta: {
            runId: run.id,
            planId: plan.id,
            generated: generatedCount,
            existing: finalTests.length - generatedCount,
            unverifiable: planUnverifiable.length,
            dropped,
            unresolvedImports: unresolved,
            apiOnly: ctx.policy.apiOnly,
            e2eAllowed: ctx.policy.e2eAllowed,
            browser,
            verifyConfigFrom: ctx.ymlFrom,
            prAuthoredTests: [...ctx.policy.prAuthoredTests],
            escalated: escapedIds,
            fallback: fallbackIds,
            cutOff: [...cutOff].filter((id) => !finalCovered.has(id)),
            bodyFailed,
            attempts,
            ms: { queued: queuedMs, gather: gatherMs, llm: firstLlmMs, replan: replanMs, bodies: bodiesMs, total: totalMs },
          },
        });
        return await settle(updated);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[verify] planner failed for run ${run.id}:`, err);
        return await settle(updateRun(run.id, { status: "failed", error: `planner: ${msg.slice(0, 300)}`, timings: { ...run.timings, planStartedAt, planFinishedAt: Date.now() } }));
      }
    })
  );
}
