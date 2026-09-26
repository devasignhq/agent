// Cross-repo Tests page rows: one per planned test of a run, joined to its
// result and evidence metadata. Pure — no storage signing, no db access.
import type { VerifyArtifact, VerifyPlan, VerifyResults, VerifyRun, VerifyRunStatus } from "../types.js";
import type { ResultStatus, TestLevel, TestOrigin, TestRunner } from "./contract.js";

export type TestCategory = "unit" | "e2e";
export type EvidenceKind = "video" | "trace" | "screenshot" | "log";
export type TestAdoption = { prUrl: string; prNumber: number; at: number };

export type VerifyTestRow = {
  key: string;
  testId: string;
  path: string;
  level: TestLevel;
  category: TestCategory;
  origin: TestOrigin;
  runner: TestRunner;
  criterionIds: string[];
  status: ResultStatus | "not_run";
  attempts: number;
  durationMs: number;
  evidence: Array<{ artifactId: string; kind: EvidenceKind; attempt: number | null; expired: boolean }>;
  adopted: TestAdoption | null;
  // supersededBy: the newer PR of the same repo that auto-archived this row.
  archived: { at: number; supersededBy?: number } | null;
  repo: { id: string; name: string };
  review: { id: string; prNumber: number; prTitle: string };
  run: { id: string; sha: string; status: VerifyRunStatus; createdAt: number; checkRunUrl: string | null };
};

export type VerifyTestCounts = { ran: number; e2e: number; unit: number; passed: number; failed: number; archived: number };

export type VerifyTestsResponse = {
  rows: VerifyTestRow[];
  counts: VerifyTestCounts;
  repos: Array<{ id: string; name: string }>;
  truncated: boolean;
};

export type Supersession = { prNumber: number; at: number };

/**
 * Per repo, only the highest-numbered PR keeps its tests active; every older PR is
 * superseded by it, as of when that PR arrived. `runs` is one run per review.
 */
export function supersededReviews(runs: VerifyRun[], arrivedAt: (reviewId: string) => number | undefined): Map<string, Supersession> {
  const newest = new Map<string, VerifyRun>();
  for (const r of runs) {
    const cur = newest.get(r.repoId);
    if (!cur || r.prNumber > cur.prNumber) newest.set(r.repoId, r);
  }
  const out = new Map<string, Supersession>();
  for (const r of runs) {
    const top = newest.get(r.repoId)!;
    if (top.prNumber === r.prNumber) continue;
    out.set(r.reviewId, { prNumber: top.prNumber, at: arrivedAt(top.reviewId) ?? top.createdAt });
  }
  return out;
}

const EVIDENCE_KINDS = new Set<string>(["video", "trace", "screenshot", "log"]);

export function bucketLevel(level: TestLevel): TestCategory {
  return level === "e2e" ? "e2e" : "unit";
}

export function buildTestRows(
  run: VerifyRun,
  plan: VerifyPlan,
  results: VerifyResults | null,
  artifacts: VerifyArtifact[],
  ctx: {
    repoName: string;
    review: { id: string; prNumber: number; prTitle: string };
    archived?: Array<{ path: string; at: number }>;
    restored?: Array<{ path: string; at: number }>;
    superseded?: Supersession | null;
  },
  now = Date.now()
): VerifyTestRow[] {
  const resultByTest = new Map((results?.payload.results ?? []).map((r) => [r.testId, r]));
  const artifactsByTest = new Map<string, VerifyArtifact[]>();
  for (const a of artifacts) {
    if (!a.testId || !EVIDENCE_KINDS.has(a.kind)) continue;
    const list = artifactsByTest.get(a.testId) ?? [];
    list.push(a);
    artifactsByTest.set(a.testId, list);
  }
  const archivedAt = new Map((ctx.archived ?? []).map((a) => [a.path, a.at]));
  const restoredAt = new Map((ctx.restored ?? []).map((a) => [a.path, a.at]));
  const sup = ctx.superseded ?? null;
  const archivedFor = (path: string): VerifyTestRow["archived"] => {
    const at = archivedAt.get(path);
    if (at !== undefined) return { at };
    if (!sup || (restoredAt.get(path) ?? -Infinity) >= sup.at) return null;
    return { at: sup.at, supersededBy: sup.prNumber };
  };
  return plan.tests.map((t) => {
    const r = resultByTest.get(t.id);
    return {
      key: `${run.id}:${t.id}`,
      testId: t.id,
      path: t.path,
      level: t.level,
      category: bucketLevel(t.level),
      origin: t.origin,
      runner: t.runner,
      criterionIds: t.criterionIds,
      status: r?.status ?? "not_run",
      attempts: r?.attempts.length ?? 0,
      durationMs: r?.durationMs ?? 0,
      evidence: (artifactsByTest.get(t.id) ?? [])
        .sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
        .map((a) => ({
          artifactId: a.id,
          kind: a.kind as EvidenceKind,
          attempt: a.attempt ?? null,
          expired: a.state === "expired" || a.expiresAt <= now,
        })),
      adopted: t.adopted ?? null,
      archived: archivedFor(t.path),
      repo: { id: run.repoId, name: ctx.repoName },
      review: ctx.review,
      run: {
        id: run.id,
        sha: run.sha,
        status: run.status,
        createdAt: run.createdAt,
        checkRunUrl: run.report?.checkRunUrl ?? null,
      },
    };
  });
}

export function summarizeTestRows(rows: VerifyTestRow[]): VerifyTestCounts {
  const counts: VerifyTestCounts = { ran: 0, e2e: 0, unit: 0, passed: 0, failed: 0, archived: 0 };
  for (const r of rows) {
    if (r.archived) {
      counts.archived++;
      continue;
    }
    if (r.status !== "not_run") counts.ran++;
    counts[r.category]++;
    if (r.status === "pass") counts.passed++;
    if (r.status === "fail" || r.status === "error") counts.failed++;
  }
  return counts;
}

/** Newest run per review, same ordering as latestRunForReview. */
export function latestRunPerReview(runs: VerifyRun[]): VerifyRun[] {
  const byReview = new Map<string, VerifyRun>();
  for (const r of runs) {
    const cur = byReview.get(r.reviewId);
    if (!cur || r.createdAt > cur.createdAt || (r.createdAt === cur.createdAt && r.attempt > cur.attempt)) byReview.set(r.reviewId, r);
  }
  return [...byReview.values()].sort((a, b) => b.createdAt - a.createdAt);
}
