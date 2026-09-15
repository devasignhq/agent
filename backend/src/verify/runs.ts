// Row helpers for verify runs: creation, lookup, and the read model that both
// GET /v1/runs/{id} and the app render.
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { planForUser, type Plan } from "../billing/plans.js";
import type {
  Criterion,
  CriteriaRevision,
  Installation,
  PRReview,
  Repository,
  VerifyArtifact,
  VerifyPlan,
  VerifyRun,
  VerifyRunStatus,
  VerifySkipReason,
} from "../types.js";
import type { RunnerPlan, RunView, RunViewArtifact } from "./contract.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { artifactStorage, UPLOAD_LIMITS } from "./storage.js";
import { needsManagedBoot } from "./yml.js";

export const TERMINAL_STATUSES: ReadonlySet<VerifyRunStatus> = new Set([
  "completed",
  "timed_out",
  "lost",
  "skipped",
  "failed",
]);

// A runner long-polls /v1/runs/resolve while the review job is still queued and
// gives up after its own timeout. Remembering that it called lets the planner
// re-trigger CI instead of leaving the run to be reaped. In-process only: a
// redeploy loses the queue too, so there is nothing to re-trigger for.
type RunnerPoll = { first: number; last: number; gone?: boolean };
const runnerPolls = new Map<string, RunnerPoll>();
// Runners poll every 3-5s. Shorter than the old 90s so a plan that lands after
// the runner quit re-dispatches promptly; cancel-in-progress bounds a false positive.
export const RUNNER_GONE_MS = 30_000;
// A webhook that was going to create this review has had this long to arrive.
export const NO_REVIEW_GRACE_MS = 60_000;

const pollKey = (repoId: string, prNumber: number, sha: string) => `${repoId}:${prNumber}:${sha.toLowerCase()}`;

export function noteRunnerPoll(repoId: string, prNumber: number, sha: string, at = Date.now()): void {
  if (runnerPolls.size > 500) runnerPolls.clear();
  const key = pollKey(repoId, prNumber, sha);
  const prev = runnerPolls.get(key);
  runnerPolls.set(key, prev ? { ...prev, last: at } : { first: at, last: at });
}

/** The runner said this was its final poll, so the plan will have nobody to collect it. */
export function noteRunnerGone(repoId: string, prNumber: number, sha: string, at = Date.now()): void {
  const key = pollKey(repoId, prNumber, sha);
  const prev = runnerPolls.get(key);
  runnerPolls.set(key, prev ? { ...prev, last: at, gone: true } : { first: at, last: at, gone: true });
}

/** True when a runner polled for this commit and has since stopped waiting. */
export function runnerGaveUp(repoId: string, prNumber: number, sha: string, now = Date.now()): boolean {
  const e = runnerPolls.get(pollKey(repoId, prNumber, sha));
  return !!e && (e.gone === true || now - e.last > RUNNER_GONE_MS);
}

/** A runner has been polling this long with still no review row: none is coming. */
export function runnerWaitedWithoutReview(
  repoId: string,
  prNumber: number,
  sha: string,
  graceMs = NO_REVIEW_GRACE_MS,
  now = Date.now()
): boolean {
  const e = runnerPolls.get(pollKey(repoId, prNumber, sha));
  return !!e && now - e.first >= graceMs;
}

export function forgetRunnerPoll(repoId: string, prNumber: number, sha: string): void {
  runnerPolls.delete(pollKey(repoId, prNumber, sha));
}

export function planTierForRepo(repo: Pick<Repository, "installationId">): Plan {
  const ownerId = db.find("installations", (i) => i.id === repo.installationId)?.userId;
  return ownerId ? planForUser(ownerId) : "free";
}

export function latestCriteriaRevision(reviewId: string): number {
  let max = 1;
  for (const r of db.filter("criteriaRevisions", (c) => c.reviewId === reviewId)) {
    if (r.revision > max) max = r.revision;
  }
  return max;
}

export function createVerifyRun(input: {
  review: Pick<PRReview, "id" | "repoId" | "prNumber" | "headSha">;
  repo: Pick<Repository, "id" | "installationId">;
  install?: Pick<Installation, "id"> | null;
  status: VerifyRunStatus;
  skipReason?: VerifySkipReason | null;
  criteriaRevision?: number;
  triggeredBy: VerifyRun["triggeredBy"];
  planTier?: Plan;
  inheritFromRunId?: string | null;
}): VerifyRun {
  const now = Date.now();
  const prior = db.filter("verifyRuns", (r) => r.reviewId === input.review.id && r.sha === input.review.headSha);
  const attempt = prior.reduce((m, r) => Math.max(m, r.attempt), 0) + 1;
  return db.insert("verifyRuns", {
    id: uuid(),
    schemaVersion: 1,
    reviewId: input.review.id,
    repoId: input.repo.id,
    installationId: input.install?.id ?? input.repo.installationId,
    prNumber: input.review.prNumber,
    sha: input.review.headSha,
    attempt,
    status: input.status,
    skipReason: input.skipReason ?? null,
    error: null,
    criteriaRevision: input.criteriaRevision ?? latestCriteriaRevision(input.review.id),
    planTier: input.planTier ?? planTierForRepo(input.repo),
    planId: null,
    resultsId: null,
    verdicts: [],
    timings: { forkedAt: now },
    tokenUsage: {},
    artifactBytes: 0,
    triggeredBy: input.triggeredBy,
    inheritFromRunId: input.inheritFromRunId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

function revisionKey(criteria: Criterion[]): string {
  return JSON.stringify(criteria.map((c) => [c.id, c.text, c.kind ?? "code", !!c.notApplicable, c.supersededBy ?? null]));
}

/** What changed between two criteria lists, in revision-diff terms. */
export function diffCriteria(prev: Criterion[], next: Criterion[]): CriteriaRevision["diff"] {
  const out: CriteriaRevision["diff"] = [];
  const before = new Map(prev.map((c) => [c.id, c]));
  const after = new Map(next.map((c) => [c.id, c]));
  for (const c of next) {
    const p = before.get(c.id);
    if (!p) {
      out.push({ op: "add", criterionId: c.id, after: c.text });
      continue;
    }
    if (p.text !== c.text) out.push({ op: "reword", criterionId: c.id, before: p.text, after: c.text });
    if (!p.notApplicable && c.notApplicable) out.push({ op: "not_applicable", criterionId: c.id, before: c.text });
    if (!p.supersededBy && c.supersededBy) out.push({ op: "remove", criterionId: c.id, before: c.text, after: after.get(c.supersededBy)?.text });
  }
  for (const p of prev) if (!after.has(p.id)) out.push({ op: "remove", criterionId: p.id, before: p.text });
  return out;
}

/** Record the criteria as a revision; a snapshot identical to the latest one is reused, not duplicated. */
export function snapshotCriteriaRevision(reviewId: string, criteria: Criterion[], causedByCommentId: number | null, diff?: CriteriaRevision["diff"]): CriteriaRevision {
  const rows = db.filter("criteriaRevisions", (c) => c.reviewId === reviewId).sort((a, b) => b.revision - a.revision);
  const latest = rows[0] ?? null;
  if (latest && revisionKey(latest.criteria) === revisionKey(criteria)) return latest;
  return db.insert("criteriaRevisions", {
    id: uuid(),
    schemaVersion: 1,
    reviewId,
    revision: (latest?.revision ?? 0) + 1,
    causedByCommentId,
    criteria: criteria.map((c) => ({ ...c })),
    diff: diff ?? (latest ? diffCriteria(latest.criteria, criteria) : []),
    createdAt: Date.now(),
  });
}

/** Has a runner ever talked to us about this repo? Drives the "Setup pending" state. */
export function hasRunnerEvidence(repo: Pick<Repository, "id" | "verify">): boolean {
  if (repo.verify?.detected || repo.verify?.onboarding?.firstSuccessfulRunId) return true;
  return !!db.find("verifyRuns", (r) => r.repoId === repo.id && r.timings.resolvedAt != null);
}

export function updateRun(id: string, patch: Partial<VerifyRun>): VerifyRun | null {
  return db.update("verifyRuns", (r) => r.id === id, { ...patch, updatedAt: Date.now() });
}

/** Newest run for a review (optionally pinned to a sha), by attempt then creation. */
export function latestRunForReview(reviewId: string, sha?: string): VerifyRun | null {
  const runs = db
    .filter("verifyRuns", (r) => r.reviewId === reviewId && (sha ? r.sha === sha : true))
    .sort((a, b) => b.createdAt - a.createdAt || b.attempt - a.attempt);
  return runs[0] ?? null;
}

/** The criteria a run was planned against: the pinned revision, else the live review row. */
export function criteriaForRun(run: Pick<VerifyRun, "reviewId" | "criteriaRevision">): { criteria: Criterion[]; revision: number } {
  const rev = db.find("criteriaRevisions", (c) => c.reviewId === run.reviewId && c.revision === run.criteriaRevision);
  if (rev) return { criteria: rev.criteria, revision: rev.revision };
  const review = db.find("prReviews", (r) => r.id === run.reviewId);
  return { criteria: review?.criteria ?? [], revision: run.criteriaRevision };
}

export type E2eWithheld = NonNullable<NonNullable<VerifyRun["runnerMeta"]>["e2eWithheld"]>;

/** Why this runner must not get the plan's browser tests: they need servers, a login or base-branch boot keys it cannot handle. */
export function e2eGate(
  plan: Pick<VerifyPlan, "tests" | "verifyConfig" | "verifyConfigFrom">,
  capabilities: readonly string[] | undefined,
  managedBootOn: boolean = config.verify.managedBoot
): E2eWithheld | null {
  if (!plan.tests.some((t) => t.runner === "playwright")) return null;
  const managed = needsManagedBoot(plan.verifyConfig);
  if (!managed && plan.verifyConfigFrom !== "base_boot") return null;
  // Base-branch start/url alone boots through Playwright's webServer, which the switch leaves on.
  if (managed && !managedBootOn) return "managed_boot_off";
  return capabilities?.includes("managed_boot") ? null : "runner_outdated";
}

export function runnerPlanFor(run: VerifyRun, plan: VerifyPlan, repo: Repository, opts: { capabilities?: readonly string[] } = {}): RunnerPlan {
  const { criteria } = criteriaForRun(run);
  const withheld = e2eGate(plan, opts.capabilities);
  const dropped = new Set(withheld ? plan.tests.filter((t) => t.runner === "playwright").map((t) => t.id) : []);
  const tests = dropped.size ? plan.tests.filter((t) => !dropped.has(t.id)) : plan.tests;
  const commands = dropped.size
    ? plan.commands.flatMap((c) => {
        const testIds = c.testIds.filter((id) => !dropped.has(id));
        return testIds.length || !c.testIds.length ? [{ ...c, testIds }] : [];
      })
    : plan.commands;
  const hasPlaywrightTests = tests.some((t) => t.runner === "playwright");
  const detected = repo.verify?.detected?.frameworks.find((f) => f.name === "playwright") ?? null;
  return {
    planId: plan.id,
    criteriaRevision: plan.criteriaRevision,
    criteria: criteria
      .filter((c) => !c.supersededBy && !c.notApplicable)
      .map((c) => ({ id: c.id, text: c.text, kind: c.kind ?? "code" })),
    tests,
    commands,
    playwright: hasPlaywrightTests
      ? { record: true, configFrom: detected?.configPath ?? null, installBrowsers: !detected }
      : null,
    retries: { generated: 2, existing: 0 },
    uploadLimits: { ...UPLOAD_LIMITS },
    unverifiable: plan.unverifiable,
    failOn: failOnFor(repo),
    ...(plan.verifyConfig ? { verifyConfig: plan.verifyConfig } : {}),
    ...(config.verify.managedBoot ? {} : { managedBoot: false }),
  };
}

// Stored workflows are merged raw, so an old or hand-edited value is checked here.
function failOnFor(repo: Repository): RunnerPlan["failOn"] {
  const stored = effectiveWorkflow(repo).verify?.failOn;
  return stored === "verdict" || stored === "unverifiable" ? stored : "never";
}

// A signed-in run's trace replays what that session could see, so its link is short-lived.
export const SIGNED_IN_TRACE_TTL_SECONDS = 300;

function getUrlTtlSeconds(a: Pick<VerifyArtifact, "kind">, plan: Pick<VerifyPlan, "verifyConfig"> | null): number {
  const ttl = config.artifacts.getUrlTtlSeconds;
  return a.kind === "trace" && plan?.verifyConfig?.login?.script ? Math.min(ttl, SIGNED_IN_TRACE_TTL_SECONDS) : ttl;
}

export async function buildRunView(run: VerifyRun, opts: { includeUsage: boolean }): Promise<RunView> {
  const { criteria, revision } = criteriaForRun(run);
  const plan = run.planId ? db.find("verifyPlans", (p) => p.id === run.planId) : null;
  const results = run.resultsId ? db.find("verifyResults", (r) => r.id === run.resultsId) : null;
  const storage = artifactStorage();
  const now = Date.now();
  const rows = db.filter("verifyArtifacts", (a) => a.runId === run.id);
  const urlById = new Map<string, string>();
  if (storage) {
    await Promise.all(
      rows
        .filter((a) => a.state === "uploaded" && a.expiresAt > now)
        .map(async (a) => {
          try {
            urlById.set(a.id, await storage.signGet(a.storageKey, getUrlTtlSeconds(a, plan)));
          } catch (err) {
            console.warn(`[verify] signGet failed for ${a.id}:`, err);
          }
        })
    );
  }
  const artifacts: RunViewArtifact[] = rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    testId: a.testId,
    criterionIds: a.criterionIds,
    bytes: a.bytes,
    state: a.state,
    expiresAt: a.expiresAt,
    posterArtifactId: a.posterArtifactId ?? null,
    path: a.path,
    attempt: a.attempt,
    getUrl: urlById.get(a.id) ?? null,
    posterUrl: a.posterArtifactId ? urlById.get(a.posterArtifactId) ?? null : null,
    urlExpiresAt: urlById.has(a.id) ? now + getUrlTtlSeconds(a, plan) * 1000 : null,
  }));
  const { tokenUsage, ...rest } = run;
  return {
    run: opts.includeUsage ? { ...rest, tokenUsage } : rest,
    criteria,
    revision,
    plan: plan
      ? { ...plan, tests: plan.tests.map(({ content: _content, ...t }) => t) }
      : null,
    results: results?.payload.results ?? null,
    artifacts,
    report: {
      ...(run.report?.checkRunUrl ? { checkRunUrl: run.report.checkRunUrl } : {}),
      ...(run.report?.commentUrl ? { commentUrl: run.report.commentUrl } : {}),
    },
  };
}
