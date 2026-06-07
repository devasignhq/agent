// GitHub-Actions test gating. The reviewer (opt-in per repo) waits for the
// repo's own CI to run on the PR head SHA and folds the result into the verdict.
//
// Split into PURE parsing helpers (no I/O — unit-tested offline in
// tests-ci.test.ts) and thin gh()-backed wrappers. Nothing here executes repo
// code: the tests run on GitHub's runners; we only read the outcome.
//   node --import tsx/esm --test src/review/tests-ci.test.ts
import { gh } from "../github/app.js";
import { config } from "../config.js";
import type { TestRun } from "../types.js";

// ── GitHub Actions API shapes (only the fields we read) ─────────────────────
export type GhWorkflowRun = {
  id: number;
  name?: string | null;
  path?: string | null; // ".github/workflows/ci.yml"
  head_sha: string;
  status: string | null; // queued | in_progress | completed | waiting | …
  conclusion: string | null; // success | failure | cancelled | timed_out | …
  html_url?: string;
  run_started_at?: string;
};
export type GhWorkflowJob = {
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url?: string;
};

// A failing run rendered as a blocker finding (structurally compatible with the
// pipeline's HolisticFinding, consumed by emitFindingLog / formatReviewBody).
export type TestFailureFinding = {
  concern: string;
  severity: "blocker";
  fixPrompt?: string;
};

// ── Pure helpers ────────────────────────────────────────────────────────────

// Does a run correspond to the workflow the repo designated for tests? Matches
// either the display name ("CI") or the workflow filename ("ci.yml") against
// run.name / basename(run.path), case-insensitively. Empty filter → any run.
export function runMatchesWorkflow(run: GhWorkflowRun, workflowName: string): boolean {
  const want = workflowName.trim().toLowerCase();
  if (!want) return true;
  const name = (run.name || "").trim().toLowerCase();
  const file = (run.path || "").split("/").pop()?.trim().toLowerCase() || "";
  return name === want || file === want;
}

// Pick the run to gate on: the newest one matching the designated workflow (by
// id, which is monotonic). Returns null when nothing matches.
export function pickWorkflowRun(
  runs: GhWorkflowRun[],
  workflowName: string
): GhWorkflowRun | null {
  const matches = runs.filter((r) => runMatchesWorkflow(r, workflowName));
  if (!matches.length) return null;
  return matches.reduce((newest, r) => (r.id > newest.id ? r : newest));
}

// Map a run's status+conclusion to a TestRun.state. Anything not yet completed
// is "pending"; among completed runs only an outright failure/timeout blocks —
// cancelled/neutral/skipped/etc. are "skipped" (non-blocking: we gate on a real
// failure, never on the absence of a clean pass).
export function classifyRun(run: GhWorkflowRun): TestRun["state"] {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
      return "failed";
    default:
      return "skipped";
  }
}

export function extractFailedJobs(jobs: GhWorkflowJob[]): Array<{ name: string; url: string }> {
  return jobs
    .filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out")
    .map((j) => ({ name: j.name, url: j.html_url || "" }));
}

// Build the blocker finding for a failed run. Lists the failing jobs (if known)
// so the PR comment points the developer straight at what broke.
export function testFailureFinding(args: {
  workflowName?: string;
  htmlUrl?: string;
  failedJobs?: Array<{ name: string; url: string }>;
}): TestFailureFinding {
  const wf = args.workflowName ? `\`${args.workflowName}\`` : "CI";
  const jobs = args.failedJobs?.length
    ? args.failedJobs.map((j) => j.name).join(", ")
    : "";
  const concern =
    `The ${wf} workflow failed for this commit` +
    (jobs ? ` — failing job(s): ${jobs}.` : ".") +
    (args.htmlUrl ? ` See the run: ${args.htmlUrl}` : "");
  const fixPrompt =
    `The CI workflow ${wf} is failing on this PR` +
    (jobs ? ` (failing job(s): ${jobs})` : "") +
    `. Open the workflow run${args.htmlUrl ? ` (${args.htmlUrl})` : ""}, read the failing step logs, ` +
    `reproduce the failure locally, and fix the underlying cause so the tests pass.`;
  return { concern, severity: "blocker", fixPrompt };
}

// Combine the criteria/holistic ("pre-test") outcome with the test result.
// `pending` means hold the verdict; otherwise a failed run forces a fail, while
// passed/skipped/errored defer to the pre-test outcome (non-blocking).
export function combineWithTests(
  preTestPassed: boolean,
  testState: TestRun["state"]
): { effectivePassed: boolean; pending: boolean } {
  if (testState === "pending") return { effectivePassed: preTestPassed, pending: true };
  if (testState === "failed") return { effectivePassed: false, pending: false };
  return { effectivePassed: preTestPassed, pending: false };
}

// ── gh()-backed wrappers ────────────────────────────────────────────────────

// List workflow runs for a head SHA and pick the one to gate on.
export async function findWorkflowRun(
  installationId: number,
  repo: { owner: string; name: string },
  headSha: string,
  workflowName: string
): Promise<GhWorkflowRun | null> {
  const resp = await gh<{ workflow_runs?: GhWorkflowRun[] }>(
    installationId,
    `/repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${headSha}&per_page=30`
  );
  return pickWorkflowRun(resp.workflow_runs || [], workflowName);
}

// Decide the initial TestRun for a review: await an existing/queued run, or (when
// configured) dispatch one, or skip when there's nothing to wait on. Best-effort
// — any GitHub error degrades to a non-blocking "skipped" so the review still
// lands rather than hanging.
export async function ensureCiForReview(args: {
  installationId: number;
  repo: { owner: string; name: string };
  headSha: string;
  prNumber: number;
  workflowName: string;
}): Promise<TestRun> {
  const { installationId, repo, headSha, prNumber, workflowName } = args;
  const now = Date.now();
  try {
    const run = await findWorkflowRun(installationId, repo, headSha, workflowName);
    if (run) {
      const state = classifyRun(run);
      return {
        state,
        workflowRunId: run.id,
        workflowName: run.name || workflowName || undefined,
        htmlUrl: run.html_url,
        conclusion: run.conclusion || undefined,
        startedAt: now,
        ...(state === "pending" ? {} : { completedAt: now }),
      };
    }
    // No run found for this SHA yet. Optionally dispatch one.
    if (config.ci.dispatch && workflowName) {
      const dispatched = await tryDispatch(installationId, repo, prNumber, workflowName);
      if (dispatched) {
        return { state: "pending", workflowName, startedAt: now, detail: "dispatched workflow_dispatch" };
      }
    }
    return { state: "skipped", startedAt: now, completedAt: now, detail: "no CI run found for head SHA" };
  } catch (err) {
    return {
      state: "skipped",
      startedAt: now,
      completedAt: now,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Fetch a completed run + its jobs and summarize into TestRun fields.
export async function summarizeWorkflowRun(
  installationId: number,
  repo: { owner: string; name: string },
  runId: number
): Promise<Pick<TestRun, "state" | "conclusion" | "htmlUrl" | "failedJobs" | "workflowName">> {
  const run = await gh<GhWorkflowRun>(
    installationId,
    `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}`
  );
  const state = classifyRun(run);
  let failedJobs: Array<{ name: string; url: string }> = [];
  if (state === "failed") {
    try {
      const jobsResp = await gh<{ jobs?: GhWorkflowJob[] }>(
        installationId,
        `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/jobs?per_page=100`
      );
      failedJobs = extractFailedJobs(jobsResp.jobs || []);
    } catch {
      // Non-fatal: we still know the run failed, just not which jobs.
    }
  }
  return {
    state,
    conclusion: run.conclusion || undefined,
    htmlUrl: run.html_url,
    workflowName: run.name || undefined,
    ...(failedJobs.length ? { failedJobs } : {}),
  };
}

// Best-effort workflow_dispatch. Needs the head branch (looked up from the PR;
// fork heads can't be dispatched) and a workflow filename. Returns whether the
// dispatch POST was accepted. Off unless config.ci.dispatch is set.
async function tryDispatch(
  installationId: number,
  repo: { owner: string; name: string },
  prNumber: number,
  workflowName: string
): Promise<boolean> {
  try {
    const pr = await gh<{ head?: { ref?: string; repo?: { full_name?: string } } }>(
      installationId,
      `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`
    );
    const ref = pr.head?.ref;
    const sameRepo = pr.head?.repo?.full_name?.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase();
    if (!ref || !sameRepo) return false; // fork head or unknown branch — can't dispatch
    // workflow_dispatch needs a workflow id or filename. Only a .yml/.yaml name
    // is usable directly as the {workflow_id} path segment.
    if (!/\.(ya?ml)$/i.test(workflowName)) return false;
    await gh(
      installationId,
      `/repos/${repo.owner}/${repo.name}/actions/workflows/${encodeURIComponent(workflowName)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref }),
        headers: { "Content-Type": "application/json" },
      }
    );
    return true;
  } catch {
    return false;
  }
}

// Resolve the workflow name to gate on for a repo: its own setting, else the
// global default. Empty string means "newest run on the SHA".
export function workflowNameFor(repoTestWorkflow: string | null | undefined): string {
  return (repoTestWorkflow || config.ci.defaultWorkflow || "").trim();
}
