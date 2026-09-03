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
  VerifyPlan,
  VerifyRun,
  VerifyRunStatus,
  VerifySkipReason,
} from "../types.js";
import type { RunnerPlan, RunView, RunViewArtifact } from "./contract.js";
import { artifactStorage, UPLOAD_LIMITS } from "./storage.js";

export const TERMINAL_STATUSES: ReadonlySet<VerifyRunStatus> = new Set([
  "completed",
  "timed_out",
  "lost",
  "skipped",
  "failed",
]);

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
    createdAt: now,
    updatedAt: now,
  });
}

function revisionKey(criteria: Criterion[]): string {
  return JSON.stringify(criteria.map((c) => [c.id, c.text, c.kind ?? "code", !!c.notApplicable, c.supersededBy ?? null]));
}

/** Record the criteria as a revision; a snapshot identical to the latest one is reused, not duplicated. */
export function snapshotCriteriaRevision(reviewId: string, criteria: Criterion[], causedByCommentId: number | null, diff: CriteriaRevision["diff"] = []): CriteriaRevision {
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
    diff,
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

export function runnerPlanFor(run: VerifyRun, plan: VerifyPlan, repo: Repository): RunnerPlan {
  const { criteria } = criteriaForRun(run);
  const hasPlaywrightTests = plan.tests.some((t) => t.runner === "playwright");
  const detected = repo.verify?.detected?.frameworks.find((f) => f.name === "playwright") ?? null;
  return {
    planId: plan.id,
    criteriaRevision: plan.criteriaRevision,
    criteria: criteria
      .filter((c) => !c.supersededBy && !c.notApplicable)
      .map((c) => ({ id: c.id, text: c.text, kind: c.kind ?? "code" })),
    tests: plan.tests,
    commands: plan.commands,
    playwright: hasPlaywrightTests
      ? { record: true, configFrom: detected?.configPath ?? null, installBrowsers: !detected }
      : null,
    retries: { generated: 2, existing: 0 },
    uploadLimits: { ...UPLOAD_LIMITS },
  };
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
            urlById.set(a.id, await storage.signGet(a.storageKey, config.artifacts.getUrlTtlSeconds));
          } catch (err) {
            console.warn(`[verify] signGet failed for ${a.id}:`, err);
          }
        })
    );
  }
  const urlExpiresAt = now + config.artifacts.getUrlTtlSeconds * 1000;
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
    urlExpiresAt: urlById.has(a.id) ? urlExpiresAt : null,
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
