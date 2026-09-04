// Pure view logic for the verification UI on the Agent page (verdict badges,
// recording blocks, deep links, revisions). Extracted from screen-agent.tsx so
// `node --test` can drive it offline — no React, no DOM.
import type { CriteriaRevision, Criterion, RunView, RunViewArtifact } from "./api.ts";

export type VerdictTone = "ok" | "danger" | "nit" | "mute";

export function verdictTone(verdict: "pass" | "fail" | "unverifiable" | "pending"): VerdictTone {
  return verdict === "pass" ? "ok" : verdict === "fail" ? "danger" : verdict === "unverifiable" ? "nit" : "mute";
}

export function verdictLabel(verdict: "pass" | "fail" | "unverifiable" | "pending"): string {
  return verdict === "fail" ? "FAIL" : verdict;
}

export type DeepLink = { runId: string | null; criterionId: string | null };

export function parseDeepLink(search: URLSearchParams | string): DeepLink {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  return { runId: p.get("run") || null, criterionId: p.get("criterion") || null };
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function formatFlakeRate(f: { rate: number; flaky: number; total: number } | undefined | null): string | null {
  if (!f || f.total === 0) return null;
  return `flake ${Math.round(f.rate * 100)}% (${f.flaky}/${f.total})`;
}

/** True when a signed URL is gone or about to go; the caller refetches the run view. */
export function isSignedUrlStale(urlExpiresAt: number | null | undefined, now: number, marginMs = 15_000): boolean {
  return !urlExpiresAt || urlExpiresAt - now < marginMs;
}

export function retentionDays(a: Pick<RunViewArtifact, "expiresAt"> & { createdAt?: number }, runCreatedAt: number): number {
  const start = a.createdAt ?? runCreatedAt;
  return Math.max(1, Math.round((a.expiresAt - start) / (24 * 60 * 60 * 1000)));
}

export type Recording = {
  artifactId: string;
  getUrl: string | null;
  posterUrl: string | null;
  urlExpiresAt: number | null;
  expired: boolean;
  expiredAfterDays: number;
  bytes: number;
  attempt?: number;
  trace: { artifactId: string; getUrl: string | null; expired: boolean } | null;
};

export type CriterionVerification = {
  criterionId: string;
  verdict: "pass" | "fail" | "unverifiable" | "pending";
  reason: string;
  flaky: boolean;
  retired: boolean;
  test: { id: string; name: string; level: string; origin: "existing" | "generated" } | null;
  attempts: number;
  durationMs: number;
  recording: Recording | null; // the latest attempt's recording
  attemptRecordings: Recording[]; // every attempt that has one (flaky rows link them all)
  logs: Array<{ artifactId: string; getUrl: string | null; attempt?: number }>;
};

export function verificationForCriterion(view: RunView | null, criterionId: string, now: number = Date.now()): CriterionVerification | null {
  if (!view) return null;
  const v = view.run.verdicts.find((x) => x.criterionId === criterionId) ?? null;
  const tests = (view.plan?.tests ?? []).filter((t) => t.criterionIds.includes(criterionId));
  const results = (view.results ?? []).filter((r) => r.criterionIds.includes(criterionId));
  const testIds = new Set(tests.map((t) => t.id));
  const mine = view.artifacts.filter((a) => a.criterionIds.includes(criterionId) || (a.testId != null && testIds.has(a.testId)));
  const byId = new Map(view.artifacts.map((a) => [a.id, a]));
  const toRecording = (video: RunViewArtifact): Recording => {
    const trace = mine.find((a) => a.kind === "trace" && a.testId === video.testId && a.attempt === video.attempt) ?? null;
    const expired = video.state === "expired" || video.expiresAt <= now;
    return {
      artifactId: video.id,
      getUrl: expired ? null : video.getUrl,
      posterUrl: expired ? null : video.posterUrl ?? (video.posterArtifactId ? byId.get(video.posterArtifactId)?.getUrl ?? null : null),
      urlExpiresAt: video.urlExpiresAt,
      expired,
      expiredAfterDays: retentionDays(video, view.run.createdAt),
      bytes: video.bytes,
      attempt: video.attempt,
      trace: trace ? { artifactId: trace.id, getUrl: trace.state === "expired" || trace.expiresAt <= now ? null : trace.getUrl, expired: trace.state === "expired" || trace.expiresAt <= now } : null,
    };
  };
  const videos = mine.filter((a) => a.kind === "video").sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  const attemptRecordings = videos.map(toRecording);
  const primary = tests[0] ?? null;
  const terminal = ["completed", "failed", "lost", "timed_out", "skipped"].includes(view.run.status);
  return {
    criterionId,
    verdict: v?.verdict ?? (terminal ? "unverifiable" : "pending"),
    reason: v?.reason ?? (terminal ? "no verdict recorded" : ""),
    flaky: !!v?.flaky,
    retired: !!v?.retired,
    test: primary ? { id: primary.id, name: primary.path, level: primary.level, origin: primary.origin } : null,
    attempts: results.reduce((m, r) => Math.max(m, r.attempts.length), 0),
    durationMs: results.reduce((s, r) => s + r.durationMs, 0),
    recording: attemptRecordings.length ? attemptRecordings[attemptRecordings.length - 1] : null,
    attemptRecordings,
    logs: mine.filter((a) => a.kind === "log").map((a) => ({ artifactId: a.id, getUrl: a.state === "expired" ? null : a.getUrl, attempt: a.attempt })),
  };
}

export function verificationCounts(view: RunView | null, criteria: Criterion[]): { pass: number; fail: number; unverifiable: number; pending: number } {
  const counts = { pass: 0, fail: 0, unverifiable: 0, pending: 0 };
  for (const c of criteria) {
    if ((c.kind ?? "code") === "unverifiable" || c.notApplicable || c.supersededBy) continue;
    const v = verificationForCriterion(view, c.id);
    counts[v?.verdict ?? "pending"] += 1;
  }
  return counts;
}

export function traceViewerUrl(traceUrl: string): string {
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`;
}

export function commentUrl(repo: { owner: string; name: string }, prNumber: number, commentId: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}#issuecomment-${commentId}`;
}

export type RevisionRow = {
  revision: number;
  at: number;
  cause: "synthesis" | "comment";
  commentId: number | null;
  changes: string[];
};

export function revisionRows(revisions: CriteriaRevision[]): RevisionRow[] {
  return [...revisions]
    .sort((a, b) => a.revision - b.revision)
    .map((r) => ({
      revision: r.revision,
      at: r.createdAt,
      cause: r.causedByCommentId ? "comment" : "synthesis",
      commentId: r.causedByCommentId,
      changes: r.diff.length
        ? r.diff.map((d) =>
            d.op === "add" ? `added ${d.criterionId}: ${d.after ?? ""}`
            : d.op === "remove" ? `removed ${d.criterionId}: ${d.before ?? ""}`
            : d.op === "reword" ? `reworded ${d.criterionId}: "${d.before ?? ""}" → "${d.after ?? ""}"`
            : `marked ${d.criterionId} not applicable`
          )
        : [`${r.criteria.length} criteria ${r.revision === 1 ? "synthesized" : "recorded"}`],
    }));
}
