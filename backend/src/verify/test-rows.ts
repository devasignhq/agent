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
  archived: { at: number } | null;
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

const EVIDENCE_KINDS = new Set<string>(["video", "trace", "screenshot", "log"]);

export function bucketLevel(level: TestLevel): TestCategory {
  return level === "e2e" ? "e2e" : "unit";
}

export function buildTestRows(
  run: VerifyRun,
  plan: VerifyPlan,
  results: VerifyResults | null,
  artifacts: VerifyArtifact[],
  ctx: { repoName: string; review: { id: string; prNumber: number; prTitle: string }; archived?: Array<{ path: string; at: number }> },
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
  return plan.tests.map((t) => {
    const r = resultByTest.get(t.id);
    const at = archivedAt.get(t.path);
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
      archived: at === undefined ? null : { at },
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
