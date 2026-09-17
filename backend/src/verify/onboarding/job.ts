// Onboarding: open the "Enable DevAsign verification" PR when the App lands on
// a repo, regenerate it on request, push doctor follow-ups to it, and open
// "adopt this test" PRs. Every GitHub write goes through injectable deps so
// the flow is exercised offline.
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { branchTipSha, compareBehindBy, createPullRequest, ensureBranch, findOpenPullRequestStrict, gh, getBranchSha, listRepoSecretNames, postPRCommentReturningId, putFile, readFileAtRefStrict, updatePullRequest, updatePullRequestBranch } from "../../github/app.js";
import { fetchTree, type TreeEntry } from "../../review/indexer.js";
import { pushNotification } from "../../notifications.js";
import type { Installation, Repository, VerifyRun } from "../../types.js";
import type { DevasignVerifyConfig, DoctorDiagnosis } from "../contract.js";
import { inferSetupFromTree, envVarNames } from "../detect.js";
import { bootConfigFrom, inferBootCandidates, inferenceFilesFor } from "../boot-inference.js";
import { updateRun } from "../runs.js";
import { mdInline } from "../md.js";
import { codeFence } from "../../review/render.js";
import { refreshDefaultYml } from "../default-yml.js";
import { parseDevasignVerify } from "../yml.js";
import { patchRepoVerify } from "../repo-state.js";
import { writeSetupPr } from "./setup-branch.js";
import {
  ACTION_REF,
  DEVASIGN_YML_PATH,
  expectedSecrets,
  extendWorkflow,
  generateWorkflow,
  guessVerifyConfig,
  mergeDevasignYml,
  ONBOARDING_BRANCH,
  ONBOARDING_TITLE,
  patchExtendedWorkflowForDoctor,
  patchWorkflowForDoctor,
  prBody,
  stackHints,
  WORKFLOW_PATH,
  WORKFLOW_VERSION,
} from "./generate.js";

export type OnboardDeps = {
  tree?: (repo: Repository, install: Installation, sha: string) => Promise<TreeEntry[]>;
  read?: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  branchSha?: (install: Installation, repo: Repository, branch: string) => Promise<string>;
  branchTip?: (install: Installation, repo: Repository, branch: string) => Promise<string | null>;
  ensureBranch?: (install: Installation, repo: Repository, branch: string, sha: string) => Promise<void>;
  putFile?: (install: Installation, repo: Repository, branch: string, path: string, content: string, message: string) => Promise<void>;
  createPr?: (install: Installation, repo: Repository, args: { title: string; body: string; head: string; base: string }) => Promise<{ number: number; html_url: string }>;
  findPr?: (install: Installation, repo: Repository, head: string) => Promise<{ number: number; html_url: string; body?: string } | null>;
  updatePr?: (install: Installation, repo: Repository, prNumber: number, patch: { body: string }) => Promise<void>;
  updateBranch?: (install: Installation, repo: Repository, prNumber: number) => Promise<boolean>;
  behindBy?: (install: Installation, repo: Repository, base: string, head: string) => Promise<number | null>;
  secretNames?: (install: Installation, repo: Repository) => Promise<string[] | null>;
  postComment?: (install: Installation, repo: Repository, prNumber: number, body: string) => Promise<number | null>;
  prHeadRef?: (install: Installation, repo: Repository, prNumber: number) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaults: Required<OnboardDeps> = {
  tree: (repo, install, sha) => fetchTree(repo, install, sha),
  // Strict on purpose, like findPr: a swallowed 403/500 reads as "the file is not there"
  // and rewrites whatever the maintainer put on the setup branch with our defaults.
  read: (install, repo, path, ref) => readFileAtRefStrict(install.installationId, repo.owner, repo.name, path, ref),
  branchSha: (install, repo, branch) => getBranchSha(install.installationId, repo.owner, repo.name, branch),
  branchTip: (install, repo, branch) => branchTipSha(install.installationId, repo.owner, repo.name, branch),
  ensureBranch: (install, repo, branch, sha) => ensureBranch(install.installationId, repo.owner, repo.name, branch, sha),
  putFile: (install, repo, branch, path, content, message) => putFile(install.installationId, repo.owner, repo.name, branch, path, content, message),
  createPr: (install, repo, args) => createPullRequest(install.installationId, repo.owner, repo.name, args),
  // Strict on purpose: a swallowed error here reads as "no PR" and resets the branch.
  findPr: (install, repo, head) => findOpenPullRequestStrict(install.installationId, repo.owner, repo.name, head),
  updatePr: (install, repo, prNumber, patch) => updatePullRequest(install.installationId, repo.owner, repo.name, prNumber, patch),
  updateBranch: (install, repo, prNumber) => updatePullRequestBranch(install.installationId, repo.owner, repo.name, prNumber),
  behindBy: (install, repo, base, head) => compareBehindBy(install.installationId, repo.owner, repo.name, base, head),
  secretNames: (install, repo) => listRepoSecretNames(install.installationId, repo.owner, repo.name),
  postComment: (install, repo, prNumber, body) => postPRCommentReturningId(install.installationId, repo.owner, repo.name, prNumber, body),
  prHeadRef: async (install, repo, prNumber) => {
    const pr = await gh<{ head?: { ref?: string } }>(install.installationId, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`);
    return pr?.head?.ref ?? null;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export type OnboardOptions = { trigger: "install" | "manual" | "doctor"; mode?: "separate" | "extend"; workflow?: string; answers?: Partial<DevasignVerifyConfig> };
export type OnboardResult = { status: "opened" | "skipped" | "failed"; prNumber?: number; prUrl?: string; reason?: string };

type VerifyState = NonNullable<Repository["verify"]>;

function setOnboarding(repo: Repository, patch: Partial<VerifyState["onboarding"]>, extra: Partial<VerifyState> | ((cur: VerifyState) => Partial<VerifyState>) = {}): void {
  patchRepoVerify(repo.id, (cur) => ({ ...cur, ...(typeof extra === "function" ? extra(cur) : extra), onboarding: { ...cur.onboarding, ...patch } }));
}

const FILES_TO_READ = ["package.json", ".env.example", ".env.test", DEVASIGN_YML_PATH, "requirements.txt", "pyproject.toml", ".python-version", "go.mod", ".nvmrc", ".node-version"];

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAX_WORKFLOWS = 10;
const runsTheAction = (text: string | null | undefined) => (text || "").includes(ACTION_REF.split("@")[0]);

/** Which workflow bodies are worth spending a read on, most interesting first. */
function byWorkflowInterest(recorded: string | undefined, asked: string | undefined): (a: string, b: string) => number {
  const rank = (p: string) =>
    p === asked ? 0 : p === recorded ? 1 : p === WORKFLOW_PATH ? 2 : /devasign|verify/i.test(p) ? 3 : /ci|test|check|build/i.test(p) ? 4 : 5;
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

export async function runVerifyOnboard(repoId: string, opts: OnboardOptions, deps: OnboardDeps = {}): Promise<OnboardResult> {
  const d = { ...defaults, ...deps };
  const repo = db.find("repositories", (r) => r.id === repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return { status: "skipped", reason: "no installation" };
  const state = repo.verify?.onboarding?.state ?? "none";
  if (opts.trigger !== "manual" && (state === "pr_open" || state === "pr_merged" || state === "verified")) return { status: "skipped", reason: `already ${state}` };

  try {
    const base = repo.defaultBranch || "main";
    const headSha = await d.branchSha(install, repo, base);
    const tree = await d.tree(repo, install, headSha);
    const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
    // Reading every workflow body costs a call each, so only MAX_WORKFLOWS are fetched —
    // but which ones is not left to tree order: the file our step already lives in, and
    // the ones whose names say CI, come first. Past that we cannot claim the action is absent.
    const allWorkflowPaths = paths.filter((p) => WORKFLOW_FILE.test(p));
    const workflowPaths = [...allWorkflowPaths].sort(byWorkflowInterest(repo.verify?.onboarding?.workflowPath, opts.workflow)).slice(0, MAX_WORKFLOWS);
    const unreadWorkflows = allWorkflowPaths.length > workflowPaths.length;
    const files: Record<string, string | null> = {};
    for (const p of [...FILES_TO_READ, ...inferenceFilesFor(paths), ...workflowPaths]) {
      if (p in files) continue;
      files[p] = paths.includes(p) ? await d.read(install, repo, p, headSha) : null;
    }
    const workflows = workflowPaths.map((p) => ({ path: p, text: files[p] || "" }));
    const alreadyOnDefault = paths.includes(WORKFLOW_PATH) || workflows.some((w) => runsTheAction(w.text));
    // A manual regenerate is the only way an onboarded repo ever gets an updated workflow,
    // so it must proceed here; install/doctor triggers still stop.
    if (alreadyOnDefault && opts.trigger !== "manual") {
      setOnboarding(repo, { state: "pr_merged" });
      return { status: "skipped", reason: "the verify workflow is already in the default branch" };
    }

    let pkg: any = null;
    try {
      pkg = files["package.json"] ? JSON.parse(files["package.json"]) : null;
    } catch {
      pkg = null;
    }
    const setup = inferSetupFromTree(paths, { packageJson: files["package.json"], envExample: files[".env.example"] });
    setup.envExampleVars = [...new Set([...setup.envExampleVars, ...envVarNames(files[".env.test"])])];
    const hints = stackHints(setup, paths, pkg, files);
    const expected = expectedSecrets(setup, workflows.map((w) => w.text));
    const present = await d.secretNames(install, repo);
    const missing = present ? expected.filter((s) => !present.includes(s)) : null;

    // Which file our step belongs in is decided from the default branch; the branch
    // copies read below only decide whether it still needs writing. A named workflow that
    // is not in the tree is a mistake, not an invitation to edit whatever sorts first.
    if (opts.workflow && !workflows.some((w) => w.path === opts.workflow)) {
      const reason = `${opts.workflow} is not a workflow in ${base}`;
      setOnboarding(repo, { lastError: reason });
      return { status: "failed", reason };
    }
    const extendTarget = opts.mode === "extend" ? workflows.find((w) => w.path === opts.workflow) ?? workflows.find((w) => /ci|test/i.test(w.path)) ?? workflows[0] : undefined;
    const foreign = workflows.find((w) => w.path !== WORKFLOW_PATH && runsTheAction(w.text));
    const mode0: "separate" | "extend" = (opts.mode === "extend" ? extendTarget : foreign) ? "extend" : "separate";

    const candidates = inferBootCandidates({ paths, files, mode: mode0, workflowTexts: workflows.map((w) => w.text) });
    const verify = guessVerifyConfig(setup, hints, pkg, expected, bootConfigFrom(candidates, paths, files));

    const build = (current: Record<string, string | null>) => {
      const at = (p: string): string | null => (p in current ? current[p] : files[p]) ?? null;
      let mode = mode0;
      let workflowPath = WORKFLOW_PATH;
      let extendedJob: string | undefined;
      let dispatch = true;
      const out: Record<string, string> = {};
      if (extendTarget) {
        workflowPath = extendTarget.path;
        const text = at(extendTarget.path) ?? extendTarget.text;
        // Their CI already runs us — on the branch or on the default branch. Adding a
        // second workflow would verify every pull request twice.
        if (!runsTheAction(text) && !runsTheAction(extendTarget.text)) {
          const ext = extendWorkflow(text);
          if ("text" in ext) {
            extendedJob = ext.job;
            dispatch = ext.dispatch;
            out[workflowPath] = ext.text;
          } else if (foreign) {
            workflowPath = foreign.path;
          } else {
            mode = "separate";
            workflowPath = WORKFLOW_PATH;
          }
        }
      } else if (foreign) {
        workflowPath = foreign.path;
      }
      if (mode === "separate" && workflowPath === WORKFLOW_PATH) out[WORKFLOW_PATH] = generateWorkflow(setup, hints, expected, paths);

      let ymlError: string | undefined;
      const merged = mergeDevasignYml(at(DEVASIGN_YML_PATH), verify, opts.answers);
      // What the PR body describes is the file the PR actually proposes — which keeps the
      // maintainer's own boot keys, and drops anything the runner's parser would refuse.
      let effective = verify;
      if ("error" in merged) ymlError = `.devasign.yml was left unchanged: ${merged.error}`;
      else {
        out[DEVASIGN_YML_PATH] = merged.text;
        effective = parseDevasignVerify(merged.text) ?? verify;
      }

      for (const [p, text] of Object.entries(out)) if (text === (at(p) ?? "")) delete out[p];
      return { files: out, body: prBody({ mode, workflowPath, hints, setup, verify: effective, expected, missing, extendedJob, dispatch }), mode, workflowPath, ymlError, dispatch };
    };

    const outcome = await writeSetupPr({
      install,
      repo,
      branch: ONBOARDING_BRANCH,
      base,
      headSha,
      title: ONBOARDING_TITLE,
      readAtBranch: [DEVASIGN_YML_PATH, WORKFLOW_PATH, extendTarget?.path, foreign?.path].filter((p): p is string => !!p),
      defaults: files,
      // Their PR was closed unmerged: whatever is on that branch now is theirs.
      resettable: state !== "pr_closed",
      build,
      deps: d,
    });
    if (outcome.status === "failed") {
      setOnboarding(repo, { lastError: outcome.reason.slice(0, 300) });
      return { status: "failed", reason: outcome.reason };
    }
    const cached = { sha: headSha, ...candidates };
    const built = outcome.built;
    if (outcome.status === "skipped") {
      setOnboarding(repo, { setupPrOpen: false, workflowPath: built.workflowPath, workflowVersion: WORKFLOW_VERSION, lastError: built.ymlError ?? null, candidates: cached, dispatchable: built.dispatch }, (cur) => ({ detected: cur.detected ?? setup }));
      return { status: "skipped", reason: outcome.reason };
    }
    // A repo whose workflow already runs on the default branch is not un-verified by a
    // follow-up setup PR; only setupPrOpen moves.
    setOnboarding(repo, {
      // Not having seen every workflow file is not proof the action is absent, so it
      // cannot demote a repo that was verified either.
      state: (alreadyOnDefault || unreadWorkflows) && (state === "verified" || state === "pr_merged") ? state : "pr_open",
      setupPrOpen: true,
      prNumber: outcome.prNumber,
      prUrl: outcome.prUrl,
      mode: built.mode,
      workflowPath: built.workflowPath,
      workflowVersion: WORKFLOW_VERSION,
      lastError: built.ymlError ?? null,
      expectedSecrets: expected,
      missingSecrets: missing,
      candidates: cached,
      // Whether a dispatch can ever wake this workflow: an extended file with other jobs
      // deliberately gets no repository_dispatch trigger.
      dispatchable: built.dispatch,
    }, (cur) => ({ detected: cur.detected ?? setup }));
    if (install.userId) {
      const verb = outcome.created ? "adds" : "updates";
      pushNotification(install.userId, "system", `Enable DevAsign verification on ${repo.owner}/${repo.name}`, `PR #${outcome.prNumber} ${verb} the verify workflow${missing?.length ? ` — ${missing.length} secret(s) still missing` : ""}`, { link: outcome.prUrl });
    }
    return { status: "opened", prNumber: outcome.prNumber, prUrl: outcome.prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verify] onboarding PR failed for ${repo.owner}/${repo.name}:`, msg);
    setOnboarding(repo, { lastError: msg.slice(0, 300) });
    if (install.userId) pushNotification(install.userId, "system", `Could not open the DevAsign verification PR on ${repo.owner}/${repo.name}`, /403|404/.test(msg) ? "The GitHub App needs contents: write (and secrets: read) — grant it, then use Regenerate setup PR." : msg.slice(0, 200));
    return { status: "failed", reason: msg };
  }
}

/** A merged/closed onboarding PR moves the repo's setup state; nothing is re-opened automatically. */
export function noteOnboardingPrClosed(repoId: string, prNumber: number, merged: boolean, deps: OnboardDeps = {}): void {
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo || repo.verify?.onboarding?.prNumber !== prNumber) return;
  const state = repo.verify.onboarding.state;
  // Closing a follow-up PR unmerged does not undo a workflow that already runs on the default branch.
  const keep = !merged && (state === "verified" || state === "pr_merged");
  setOnboarding(repo, { state: merged ? "pr_merged" : keep ? state : "pr_closed", setupPrOpen: false });
  // Only injected readers pass through: the default one tells a missing file from a failed read.
  if (merged) void refreshDefaultYml(repo.id, { force: true, deps: { branchSha: deps.branchSha, read: deps.read } });
}

/** A run that completed without a setup problem marks the repo verified — again after a regenerated setup PR merges. */
export function noteRunSucceeded(run: VerifyRun): void {
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  const ob = repo?.verify?.onboarding;
  if (!repo) return;
  // The first run is the one the setup PR itself triggers — the workflow only exists on
  // that branch. It proves the workflow works, not that it landed: closing the PR unmerged
  // would otherwise freeze the repo on "verified" with nothing on the default branch.
  const onSetupPr = ob?.setupPrOpen === true && ob.prNumber != null && run.prNumber === ob.prNumber;
  if (!onSetupPr && ob?.state !== "verified") setOnboarding(repo, { state: "verified", firstSuccessfulRunId: ob?.firstSuccessfulRunId ?? run.id, lastDiagnosis: null });
  else if (ob?.lastDiagnosis != null) setOnboarding(repo, { lastDiagnosis: null });
}

/** Doctor diagnosis → comment on the open onboarding PR (+ a mechanical fix commit when we have one). */
export async function postDoctorFollowup(run: VerifyRun, doctor: DoctorDiagnosis, deps: OnboardDeps = {}): Promise<{ commented: boolean; patched: boolean }> {
  const d = { ...defaults, ...deps };
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return { commented: false, patched: false };
  setOnboarding(repo, { lastDiagnosis: doctor });
  const ob = repo.verify?.onboarding;
  if (ob?.state !== "pr_open" || !ob.prNumber) return { commented: false, patched: false };
  const workflowPath = ob.workflowPath ?? WORKFLOW_PATH;
  let patched = false;
  let patchNote = "";
  try {
    const current = await d.read(install, repo, workflowPath, ONBOARDING_BRANCH);
    // Their own CI file gets a job-scoped edit; the text patch assumes our generated layout.
    const next = !current ? null : workflowPath === WORKFLOW_PATH ? patchWorkflowForDoctor(current, doctor) : patchExtendedWorkflowForDoctor(current, doctor);
    if (next) {
      await d.putFile(install, repo, ONBOARDING_BRANCH, workflowPath, next, `Fix DevAsign verification setup: ${doctor.code}`);
      patched = true;
      patchNote = `\n\nI pushed a commit to this PR that applies the mechanical fix (${doctor.code.replace(/_/g, " ")}).`;
    }
  } catch (err) {
    console.warn("[verify] doctor follow-up commit failed:", err);
  }
  const patch = doctor.suggestedFix?.patch?.trim() ?? "";
  const fence = codeFence(patch);
  const lines = [
    `### Setup needs attention`,
    "",
    `The first verification run on PR #${run.prNumber} could not run its tests: **${mdInline(doctor.message)}** (${doctor.stage}/${doctor.code}).`,
    ...(doctor.missingSecrets?.length ? ["", `Missing secrets: ${doctor.missingSecrets.map((s) => `\`${s}\``).join(", ")}`] : []),
    ...(doctor.suggestedFix ? ["", mdInline(doctor.suggestedFix.instructions, 1000), ...(patch ? ["", `${fence}yaml`, patch, fence] : [])] : []),
    patchNote,
    "",
    "Until this is fixed, UI criteria are checked below browser level with a note on each PR, and reported as unverifiable only under `e2e: always`.",
  ];
  const id = await d.postComment(install, repo, ob.prNumber, lines.join("\n"));
  return { commented: id != null, patched };
}

// Must stay the same depth as GENERATED_TEST_PREFIX: the generated content's
// relative imports were re-anchored for that depth and are committed verbatim.
export const ADOPT_DIR = "tests/devasign";

export function adoptedPath(generatedPath: string): string | null {
  const rel = generatedPath.replace(/^\.devasign\/tests\//, "");
  // Second gate on the planner's path (plan.ts is the first): this string
  // becomes a commit path in the customer's repository.
  if (!rel || rel.startsWith("/") || rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  return `${ADOPT_DIR}/${rel}`;
}

// Committing a test is not the same as joining the suite: a repo whose test
// command names its own paths never looks at ADOPT_DIR. Reach is read, not assumed.
export type SuiteScript = { manifest: string; script: string };
export type SuiteReach = { covered: boolean | null; scripts: SuiteScript[] };

const SUITE_PROBE_LIMIT = 6;
const ENV_ASSIGN = /^[A-Za-z_]\w*=/;
const WRAPPERS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "exec", "dlx", "run", "cross-env", "dotenv", "--"]);
const FLAG_TAKES_VALUE =
  /^(?:--(?:import|loader|require|experimental-loader|env-file|test-reporter|test-reporter-destination|test-name-pattern|test-shard|test-concurrency|reporter|outputFile|max-workers|maxWorkers|runner|environment)|-r|-w)$/;
const CONFIG_FLAG = /^(?:--config|-c)$/;
// A named project, workspace or shard runs part of the suite, so the framework's default
// include is no longer what decides.
const NARROWING_FLAG = /^(?:--(?:project|projects|workspace|shard|dir|root|rootDir|testPathPattern|testPathPatterns)|-p)$/;
const VITEST_SUBCOMMANDS = new Set(["run", "watch", "related", "bench", "list", "dev", "typecheck"]);
const VITEST_CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vitest.workspace.ts", "vitest.workspace.js", "vite.config.ts", "vite.config.mts", "vite.config.js"];
const JEST_CONFIGS = ["jest.config.ts", "jest.config.mts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"];
const CONFIG_READ_BUDGET = 24;
// Repo-authored patterns are never compiled as regexes here, and a glob is only expanded
// when it is small enough that a miss cannot backtrack for long.
const REGEX_META = /[\\^$*+?()[\]{}|]/;
const globSafe = (g: string) => g.length <= 120 && (g.match(/\*/g)?.length ?? 0) <= 6;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitCommands(script: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let quoted = false;
  let quote: string | null = null;
  const pushTok = () => {
    if (tok || quoted) cur.push(tok);
    tok = "";
    quoted = false;
  };
  const endCmd = () => {
    pushTok();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote) {
      if (c === quote) quote = null;
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      pushTok();
      continue;
    }
    if (c === "&" || c === "|" || c === ";") {
      endCmd();
      if (script[i + 1] === c) i++;
      continue;
    }
    tok += c;
  }
  endCmd();
  return out;
}

/** Whether a shell glob (or a bare directory) selects a repo-relative path. */
export function globSelects(glob: string, path: string): boolean {
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!g) return false;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") {
        i++;
        re += "(?:[^/]*/)*";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{" && g.indexOf("}", i) > i) {
      const end = g.indexOf("}", i);
      re += `(?:${g.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
      i = end;
    } else re += escapeRe(c);
  }
  // Adjacent wildcards would make a miss backtrack over every split of the path.
  return new RegExp(`^(?:${re.replace(/(?:\.\*)+/g, ".*")})(?:/|$)`).test(path);
}

// `defaults` marks a framework invocation with no path filters: its default include covers
// the destination unless a config narrows it, and `config` is the one the command names.
type Select = { v: boolean | null; defaults?: "vitest" | "jest"; config?: string };

function commandSelects(tokens: string[], rel: string, scripts: Record<string, string>, depth: number): Select {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || WRAPPERS.has(tokens[i]))) i++;
  const name = (tokens[i] ?? "").split("/").pop() ?? "";
  if (!name) return { v: null };
  if (depth < 2 && typeof scripts[name] === "string") return scriptSelect(scripts[name], rel, scripts, depth + 1);
  const args: string[] = [];
  let config: string | undefined;
  let narrowed = false;
  for (let j = i + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (!tok.startsWith("-")) {
      args.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = eq > 0 ? tok.slice(0, eq) : tok;
    const inline = eq > 0 ? tok.slice(eq + 1) : null;
    if (CONFIG_FLAG.test(flag)) config = inline ?? tokens[++j] ?? "";
    else if (NARROWING_FLAG.test(flag)) narrowed = true;
    else if (inline === null && FLAG_TAKES_VALUE.test(flag)) j++;
  }
  if (name === "vitest") {
    const filters = args.filter((a, k) => !(k === 0 && VITEST_SUBCOMMANDS.has(a)));
    if (narrowed) return { v: null };
    if (!filters.length) return { v: true, defaults: "vitest", config };
    return { v: filters.some((f) => rel.includes(f.replace(/^\.\//, ""))) };
  }
  if (name === "jest") {
    if (narrowed) return { v: null };
    if (!args.length) return { v: true, defaults: "jest", config };
    // jest matches these as regexes, but they come out of the PR head's package.json, so
    // only a plain fragment is read — anything with regex syntax in it is unreadable.
    const pats = args.map((a) => a.replace(/^\.\//, ""));
    if (pats.some((a) => !REGEX_META.test(a) && rel.includes(a))) return { v: true };
    return { v: pats.some((a) => REGEX_META.test(a)) ? null : false };
  }
  if (name === "node") {
    if (!tokens.includes("--test") || !args.length) return { v: null };
    return { v: args.every(globSafe) ? args.some((a) => globSelects(a, rel)) : null };
  }
  return { v: null };
}

function scriptSelect(script: string, rel: string, scripts: Record<string, string>, depth: number): Select {
  let unknown = false;
  let negative = false;
  for (const tokens of splitCommands(script)) {
    if (!tokens.length) continue;
    const r = commandSelects(tokens, rel, scripts, depth);
    if (r.v === true) return r;
    if (r.v === false) negative = true;
    else unknown = true;
  }
  return { v: unknown ? null : negative ? false : null };
}

/** true: this script runs `rel`. false: it names paths and none of them is `rel`. null: unreadable. */
export function scriptSelects(script: string, rel: string, scripts: Record<string, string> = {}): boolean | null {
  return scriptSelect(script, rel, scripts, 0).v;
}

/**
 * Whether anything could narrow the framework's default include. A config we cannot parse
 * is not a config that covers everything, so its mere presence is enough to stop the claim.
 */
async function configNarrows(
  read: (path: string) => Promise<string | null>,
  dir: string,
  fw: "vitest" | "jest",
  pkg: any,
  budget: { left: number },
  named?: string
): Promise<boolean> {
  const at = (p: string) => (dir ? `${dir}/${p}` : p);
  // A command that names its own config is running that config, whatever it holds.
  if (named !== undefined) return true;
  if (fw === "jest" && pkg?.jest) return true;
  for (const name of fw === "vitest" ? VITEST_CONFIGS : JEST_CONFIGS) {
    if (budget.left <= 0) return true;
    budget.left--;
    if ((await read(at(name))) !== null) return true;
  }
  return false;
}

/** Do the repo's own `npm test` commands run files committed at `dests`? */
export async function suiteReach(read: (path: string) => Promise<string | null>, packageDirs: string[], dests: string[]): Promise<SuiteReach> {
  const all = [...new Set(["", ...packageDirs])];
  const dirs = all.slice(0, SUITE_PROBE_LIMIT);
  const scripts: SuiteScript[] = [];
  const budget = { left: CONFIG_READ_BUDGET };
  const configs = new Map<string, Promise<boolean>>();
  // Per destination, across every manifest: "does the suite run this file" is a question
  // one command can answer yes to on its own, so the verdicts join as a disjunction.
  const verdict = new Map<string, boolean | null>();
  const merge = (dest: string, v: boolean | null) => {
    const cur = verdict.get(dest);
    if (cur === true) return;
    if (v === true || cur === undefined) verdict.set(dest, v);
    else if (v === null) verdict.set(dest, null);
  };
  for (const dir of dirs) {
    const manifest = dir ? `${dir}/package.json` : "package.json";
    const text = await read(manifest);
    let pkg: any = null;
    try {
      pkg = text ? JSON.parse(text) : null;
    } catch {
      pkg = null;
    }
    const script = pkg?.scripts?.test;
    if (typeof script !== "string" || !script.trim()) continue;
    scripts.push({ manifest, script });
    for (const dest of dests) {
      // A package's command runs from its own directory: a file outside it is not something
      // that command declines, it is something it never sees. Silence, not a verdict.
      if (dir && !dest.startsWith(`${dir}/`)) continue;
      const sel = scriptSelect(script, dir ? dest.slice(dir.length + 1) : dest, pkg.scripts, 0);
      if (sel.v === true && sel.defaults) {
        const key = `${dir}\u0000${sel.defaults}\u0000${sel.config ?? ""}`;
        if (!configs.has(key)) configs.set(key, configNarrows(read, dir, sel.defaults, pkg, budget, sel.config));
        merge(dest, (await configs.get(key)!) ? null : true);
      } else merge(dest, sel.v);
    }
  }
  // No command that could even see a destination is not silence about it: nothing runs it.
  const seen = dests.map((d) => (verdict.has(d) ? verdict.get(d)! : scripts.length ? false : null));
  const covered = !scripts.length ? null : seen.some((v) => v === false) ? false : seen.some((v) => v === null) ? null : true;
  // A package list this stopped short of could hold the command that does run them.
  return { covered: covered === false && all.length > dirs.length ? null : covered, scripts };
}

const inlineCode = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/`/g, "'").slice(0, 200);

export function adoptLead(prNumber: number, base: string, reach: SuiteReach): string[] {
  const head = `These tests were generated by DevAsign from PR #${prNumber}'s acceptance criteria and ran in CI as verification evidence.`;
  if (reach.covered === true) return [`${head} Merging this into \`${base}\` keeps them as part of the repository's own suite.`];
  if (reach.covered === null)
    return [
      `${head} Merging this into \`${base}\` commits them under \`${ADOPT_DIR}/\`. If this repository's test command selects files by path, add that directory so they run with the rest of the suite.`,
    ];
  return [
    `${head} Merging this into \`${base}\` commits them, but no test command in this repository selects \`${ADOPT_DIR}/\`, so they will not run with the rest of the suite:`,
    "",
    ...reach.scripts.slice(0, 4).map((s) => `- \`${s.manifest}\` — \`${inlineCode(s.script)}\``),
    ...(reach.scripts.length > 4 ? [`- …and ${reach.scripts.length - 4} more`] : []),
    "",
    // Not "or move them": their relative imports were re-anchored for ADOPT_DIR's depth and
    // are committed verbatim, so a destination at any other depth breaks every one of them.
    `Add \`${ADOPT_DIR}/**\` to one of those commands' paths. Their relative imports are anchored ${ADOPT_DIR.split("/").length} directories deep, so a different destination would have to sit at the same depth.`,
  ];
}

/** Open a PR (against the reviewed PR's branch) that commits generated tests into the customer's suite. */
export async function adoptGeneratedTests(runId: string, testIds: string[] | null, deps: OnboardDeps = {}): Promise<{ status: "opened" | "skipped" | "failed"; prNumber?: number; prUrl?: string; reason?: string }> {
  const d = { ...defaults, ...deps };
  const run = db.find("verifyRuns", (r) => r.id === runId);
  const plan = run?.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
  const repo = run ? db.find("repositories", (r) => r.id === run.repoId) : null;
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!run || !plan || !repo || !install) return { status: "skipped", reason: "run, plan, or installation missing" };
  const tests = plan.tests.filter((t) => t.origin === "generated" && t.content && !t.adopted && adoptedPath(t.path) && (!testIds || testIds.includes(t.id)));
  if (!tests.length) return { status: "skipped", reason: "no generated tests to adopt" };
  try {
    const base = await d.prHeadRef(install, repo, run.prNumber);
    if (!base) return { status: "failed", reason: "could not resolve the PR's branch" };
    const detected = repo.verify?.detected;
    let reach: SuiteReach = { covered: null, scripts: [] };
    try {
      const dirs = [...(detected?.packages ?? []), ...(detected?.monorepo?.packages ?? [])];
      reach = await suiteReach((p) => d.read(install, repo, p, run.sha), dirs, tests.map((t) => adoptedPath(t.path)!));
    } catch (err) {
      console.warn(`[verify] adopt-test suite probe failed for run ${run.id}:`, err);
    }
    const branch = `devasign/adopt-${run.id.slice(0, 8)}`;
    await d.ensureBranch(install, repo, branch, run.sha);
    for (const t of tests) await d.putFile(install, repo, branch, adoptedPath(t.path)!, t.content!, `Adopt DevAsign test for criteria ${t.criterionIds.join(", ")}`);
    const pr = await d.createPr(install, repo, {
      title: `Adopt DevAsign generated tests (PR #${run.prNumber})`,
      body: [
        ...adoptLead(run.prNumber, base, reach),
        "",
        ...tests.map((t) => `- \`${adoptedPath(t.path)}\` — criteria ${t.criterionIds.join(", ")} (${t.level}, ${t.runner})`),
        "",
        `[Verification details](${config.webOrigin.replace(/\/+$/, "")}/reviews/${run.reviewId}?run=${run.id})`,
      ].join("\n"),
      head: branch,
      base,
    });
    updateRun(run.id, { report: { ...(run.report || {}), adoptPrUrl: pr.html_url } as VerifyRun["report"] });
    const adopted = { prUrl: pr.html_url, prNumber: pr.number, at: Date.now() };
    const chosen = new Set(tests.map((t) => t.id));
    db.update("verifyPlans", (p) => p.id === plan.id, { tests: plan.tests.map((t) => (chosen.has(t.id) ? { ...t, adopted } : t)) });
    db.insert("reviewLogs", { id: uuid(), reviewId: run.reviewId, kind: "verify", at: Date.now(), action: `Opened PR #${pr.number} adopting ${tests.length} generated test(s)`, meta: { runId: run.id, prUrl: pr.html_url } });
    return { status: "opened", prNumber: pr.number, prUrl: pr.html_url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verify] adopt-test PR failed for run ${run.id}:`, msg);
    return { status: "failed", reason: msg };
  }
}
