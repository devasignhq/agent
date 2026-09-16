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
      return { files: out, body: prBody({ mode, workflowPath, hints, setup, verify: effective, expected, missing, extendedJob, dispatch }), mode, workflowPath, ymlError };
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
      setOnboarding(repo, { setupPrOpen: false, workflowPath: built.workflowPath, workflowVersion: WORKFLOW_VERSION, lastError: built.ymlError ?? null, candidates: cached }, (cur) => ({ detected: cur.detected ?? setup }));
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
    const branch = `devasign/adopt-${run.id.slice(0, 8)}`;
    await d.ensureBranch(install, repo, branch, run.sha);
    for (const t of tests) await d.putFile(install, repo, branch, adoptedPath(t.path)!, t.content!, `Adopt DevAsign test for criteria ${t.criterionIds.join(", ")}`);
    const pr = await d.createPr(install, repo, {
      title: `Adopt DevAsign generated tests (PR #${run.prNumber})`,
      body: [
        `These tests were generated by DevAsign from PR #${run.prNumber}'s acceptance criteria and ran in CI as verification evidence. Merging this into \`${base}\` keeps them as part of the repository's own suite.`,
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
