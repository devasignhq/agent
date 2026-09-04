// Onboarding: open the "Enable DevAsign verification" PR when the App lands on
// a repo, regenerate it on request, push doctor follow-ups to it, and open
// "adopt this test" PRs. Every GitHub write goes through injectable deps so
// the flow is exercised offline.
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { createPullRequest, ensureBranch, gh, getBranchSha, listRepoSecretNames, postPRCommentReturningId, putFile, readFileAtRef } from "../../github/app.js";
import { fetchTree, type TreeEntry } from "../../review/indexer.js";
import { pushNotification } from "../../notifications.js";
import type { Installation, Repository, VerifyRun } from "../../types.js";
import type { DoctorDiagnosis } from "../contract.js";
import { inferSetupFromTree, envVarNames } from "../detect.js";
import { updateRun } from "../runs.js";
import {
  ACTION_REF,
  DEVASIGN_YML_PATH,
  expectedSecrets,
  extendWorkflow,
  generateDevasignYml,
  generateWorkflow,
  guessVerifyConfig,
  ONBOARDING_BRANCH,
  ONBOARDING_TITLE,
  patchWorkflowForDoctor,
  prBody,
  stackHints,
  WORKFLOW_PATH,
} from "./generate.js";

export type OnboardDeps = {
  tree?: (repo: Repository, install: Installation, sha: string) => Promise<TreeEntry[]>;
  read?: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  branchSha?: (install: Installation, repo: Repository, branch: string) => Promise<string>;
  ensureBranch?: (install: Installation, repo: Repository, branch: string, sha: string) => Promise<void>;
  putFile?: (install: Installation, repo: Repository, branch: string, path: string, content: string, message: string) => Promise<void>;
  createPr?: (install: Installation, repo: Repository, args: { title: string; body: string; head: string; base: string }) => Promise<{ number: number; html_url: string }>;
  secretNames?: (install: Installation, repo: Repository) => Promise<string[] | null>;
  postComment?: (install: Installation, repo: Repository, prNumber: number, body: string) => Promise<number | null>;
  prHeadRef?: (install: Installation, repo: Repository, prNumber: number) => Promise<string | null>;
};

const defaults: Required<OnboardDeps> = {
  tree: (repo, install, sha) => fetchTree(repo, install, sha),
  read: (install, repo, path, ref) => readFileAtRef(install.installationId, repo.owner, repo.name, path, ref),
  branchSha: (install, repo, branch) => getBranchSha(install.installationId, repo.owner, repo.name, branch),
  ensureBranch: (install, repo, branch, sha) => ensureBranch(install.installationId, repo.owner, repo.name, branch, sha),
  putFile: (install, repo, branch, path, content, message) => putFile(install.installationId, repo.owner, repo.name, branch, path, content, message),
  createPr: (install, repo, args) => createPullRequest(install.installationId, repo.owner, repo.name, args),
  secretNames: (install, repo) => listRepoSecretNames(install.installationId, repo.owner, repo.name),
  postComment: (install, repo, prNumber, body) => postPRCommentReturningId(install.installationId, repo.owner, repo.name, prNumber, body),
  prHeadRef: async (install, repo, prNumber) => {
    const pr = await gh<{ head?: { ref?: string } }>(install.installationId, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`);
    return pr?.head?.ref ?? null;
  },
};

export type OnboardOptions = { trigger: "install" | "manual" | "doctor"; mode?: "separate" | "extend"; workflow?: string };
export type OnboardResult = { status: "opened" | "skipped" | "failed"; prNumber?: number; prUrl?: string; reason?: string };

function setOnboarding(repo: Repository, patch: Partial<NonNullable<Repository["verify"]>["onboarding"]>, extra: Partial<NonNullable<Repository["verify"]>> = {}): void {
  const cur = repo.verify ?? { onboarding: { state: "none" as const } };
  db.update("repositories", (r) => r.id === repo.id, { verify: { ...cur, ...extra, onboarding: { ...cur.onboarding, ...patch } } });
}

const FILES_TO_READ = ["package.json", ".env.example", ".env.test", DEVASIGN_YML_PATH, "requirements.txt", "pyproject.toml", ".python-version", "go.mod", ".nvmrc"];

export async function runVerifyOnboard(repoId: string, opts: OnboardOptions, deps: OnboardDeps = {}): Promise<OnboardResult> {
  const d = { ...defaults, ...deps };
  const repo = db.find("repositories", (r) => r.id === repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return { status: "skipped", reason: "no installation" };
  const state = repo.verify?.onboarding?.state ?? "none";
  if (opts.trigger !== "manual" && (state === "pr_open" || state === "pr_merged" || state === "verified")) return { status: "skipped", reason: `already ${state}` };

  try {
    const headSha = await d.branchSha(install, repo, repo.defaultBranch || "main");
    const tree = await d.tree(repo, install, headSha);
    const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
    const workflowPaths = paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).slice(0, 10);
    const files: Record<string, string | null> = {};
    for (const p of [...FILES_TO_READ, ...workflowPaths]) files[p] = paths.includes(p) ? await d.read(install, repo, p, headSha) : null;
    const workflows = workflowPaths.map((p) => ({ path: p, text: files[p] || "" }));
    if (paths.includes(WORKFLOW_PATH) || workflows.some((w) => w.text.includes(ACTION_REF.split("@")[0]))) {
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
    const verify = guessVerifyConfig(setup, hints, pkg, expected);
    const ymlText = generateDevasignYml(files[DEVASIGN_YML_PATH], verify);

    let mode: "separate" | "extend" = opts.mode === "extend" ? "extend" : "separate";
    let workflowPath = WORKFLOW_PATH;
    let extendedJob: string | undefined;
    const out: Record<string, string> = {};
    if (mode === "extend") {
      const target = workflows.find((w) => w.path === opts.workflow) ?? workflows.find((w) => /ci|test/i.test(w.path)) ?? workflows[0];
      const ext = target ? extendWorkflow(target.text) : { error: "no existing workflow" };
      if ("text" in ext) {
        workflowPath = target!.path;
        extendedJob = ext.job;
        out[workflowPath] = ext.text;
      } else {
        mode = "separate";
      }
    }
    if (mode === "separate") out[WORKFLOW_PATH] = generateWorkflow(setup, hints, expected, paths);
    if (ymlText !== (files[DEVASIGN_YML_PATH] || "")) out[DEVASIGN_YML_PATH] = ymlText;

    await d.ensureBranch(install, repo, ONBOARDING_BRANCH, headSha);
    for (const [path, content] of Object.entries(out)) await d.putFile(install, repo, ONBOARDING_BRANCH, path, content, `${path.includes("workflows") ? "Add" : "Configure"} DevAsign verification (${path})`);
    const pr = await d.createPr(install, repo, {
      title: ONBOARDING_TITLE,
      body: prBody({ mode, workflowPath, hints, setup, verify, expected, missing, extendedJob }),
      head: ONBOARDING_BRANCH,
      base: repo.defaultBranch || "main",
    });
    setOnboarding(repo, { state: "pr_open", prNumber: pr.number, prUrl: pr.html_url, mode, lastError: null, expectedSecrets: expected, missingSecrets: missing }, { detected: repo.verify?.detected ?? setup });
    if (install.userId) pushNotification(install.userId, "system", `Enable DevAsign verification on ${repo.owner}/${repo.name}`, `PR #${pr.number} adds the verify workflow${missing?.length ? ` — ${missing.length} secret(s) still missing` : ""}`, { link: pr.html_url });
    return { status: "opened", prNumber: pr.number, prUrl: pr.html_url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verify] onboarding PR failed for ${repo.owner}/${repo.name}:`, msg);
    setOnboarding(repo, { lastError: msg.slice(0, 300) });
    if (install.userId) pushNotification(install.userId, "system", `Could not open the DevAsign verification PR on ${repo.owner}/${repo.name}`, /403|404/.test(msg) ? "The GitHub App needs contents: write (and secrets: read) — grant it, then use Regenerate setup PR." : msg.slice(0, 200));
    return { status: "failed", reason: msg };
  }
}

/** A merged/closed onboarding PR moves the repo's setup state; nothing is re-opened automatically. */
export function noteOnboardingPrClosed(repoId: string, prNumber: number, merged: boolean): void {
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo || repo.verify?.onboarding?.prNumber !== prNumber) return;
  setOnboarding(repo, { state: merged ? "pr_merged" : "pr_closed" });
}

/** First run that completed without a setup problem marks the repo verified. */
export function noteRunSucceeded(run: VerifyRun): void {
  const repo = db.find("repositories", (r) => r.id === run.repoId);
  if (!repo || repo.verify?.onboarding?.firstSuccessfulRunId) return;
  setOnboarding(repo, { state: "verified", firstSuccessfulRunId: run.id, lastDiagnosis: null });
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
  let patched = false;
  let patchNote = "";
  try {
    const current = await d.read(install, repo, WORKFLOW_PATH, ONBOARDING_BRANCH);
    const next = current ? patchWorkflowForDoctor(current, doctor) : null;
    if (next) {
      await d.putFile(install, repo, ONBOARDING_BRANCH, WORKFLOW_PATH, next, `Fix DevAsign verification setup: ${doctor.code}`);
      patched = true;
      patchNote = `\n\nI pushed a commit to this PR that applies the mechanical fix (${doctor.code.replace(/_/g, " ")}).`;
    }
  } catch (err) {
    console.warn("[verify] doctor follow-up commit failed:", err);
  }
  const lines = [
    `### Setup needs attention`,
    "",
    `The first verification run on PR #${run.prNumber} could not run its tests: **${doctor.message}** (${doctor.stage}/${doctor.code}).`,
    ...(doctor.missingSecrets?.length ? ["", `Missing secrets: ${doctor.missingSecrets.map((s) => `\`${s}\``).join(", ")}`] : []),
    ...(doctor.suggestedFix ? ["", doctor.suggestedFix.instructions, ...(doctor.suggestedFix.patch ? ["", "```yaml", doctor.suggestedFix.patch.trim(), "```"] : [])] : []),
    patchNote,
    "",
    "Criteria on that PR are reported as unverifiable, not failed, until this is fixed.",
  ];
  const id = await d.postComment(install, repo, ob.prNumber, lines.join("\n"));
  return { commented: id != null, patched };
}

const ADOPT_DIR = "tests/devasign";

export function adoptedPath(generatedPath: string): string {
  const rel = generatedPath.replace(/^\.devasign\/tests\//, "");
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
  const tests = plan.tests.filter((t) => t.origin === "generated" && t.content && (!testIds || testIds.includes(t.id)));
  if (!tests.length) return { status: "skipped", reason: "no generated tests to adopt" };
  try {
    const base = await d.prHeadRef(install, repo, run.prNumber);
    if (!base) return { status: "failed", reason: "could not resolve the PR's branch" };
    const branch = `devasign/adopt-${run.id.slice(0, 8)}`;
    await d.ensureBranch(install, repo, branch, run.sha);
    for (const t of tests) await d.putFile(install, repo, branch, adoptedPath(t.path), t.content!, `Adopt DevAsign test for criteria ${t.criterionIds.join(", ")}`);
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
    db.insert("reviewLogs", { id: uuid(), reviewId: run.reviewId, kind: "verify", at: Date.now(), action: `Opened PR #${pr.number} adopting ${tests.length} generated test(s)`, meta: { runId: run.id, prUrl: pr.html_url } });
    return { status: "opened", prNumber: pr.number, prUrl: pr.html_url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verify] adopt-test PR failed for run ${run.id}:`, msg);
    return { status: "failed", reason: msg };
  }
}
