// Pure view logic for the Tests page (filters, sort, evidence chips, drawer
// detail). React-free so node --test drives it offline.
import type { BrowserSetupEntry, ResultStatus, RunView, RunViewArtifact, TestAdoption, TestEvidenceKind, TestOrigin, VerifyTestCounts, VerifyTestRow } from "./api.ts";
import { recordingFromVideo, type Recording } from "./verify-view.ts";

export type TestStatus = ResultStatus | "not_run";
export type TestCategory = "unit" | "e2e";

export type TestFilters = {
  repo: string | null;
  category: TestCategory | null;
  status: TestStatus | null;
  origin: TestOrigin | null;
  review: string | null;
  archived: boolean;
  q: string;
};

export const EMPTY_FILTERS: TestFilters = { repo: null, category: null, status: null, origin: null, review: null, archived: false, q: "" };

export function testName(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg[seg.length - 1] ?? path;
}

// A runner "error" is a test that threw — to the user that is a failure.
const isFailure = (s: TestStatus) => s === "fail" || s === "error";

export function statusTone(status: TestStatus): "ok" | "danger" | "warn" | "nit" | "mute" {
  if (status === "pass") return "ok";
  if (isFailure(status)) return "danger";
  if (status === "flaky") return "warn";
  if (status === "skipped") return "nit";
  return "mute";
}

export function statusLabel(status: TestStatus): string {
  if (isFailure(status)) return "FAIL";
  if (status === "not_run") return "not run";
  return status;
}

export function categoryLabel(c: TestCategory): string {
  return c === "e2e" ? "e2e" : "unit";
}

export function filterRows(rows: VerifyTestRow[], f: TestFilters): VerifyTestRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.repo && r.repo.id !== f.repo) return false;
    if (f.category && r.category !== f.category) return false;
    if (!!r.archived !== f.archived) return false;
    if (f.status && r.status !== f.status && !(f.status === "fail" && isFailure(r.status))) return false;
    if (f.origin && r.origin !== f.origin) return false;
    if (f.review && r.review.id !== f.review) return false;
    if (q && !`${r.path} ${r.repo.name} #${r.review.prNumber} ${r.review.prTitle}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function sortRows(rows: VerifyTestRow[]): VerifyTestRow[] {
  return [...rows].sort((a, b) => {
    if (a.run.createdAt !== b.run.createdAt) return b.run.createdAt - a.run.createdAt;
    const af = isFailure(a.status) ? 0 : 1;
    const bf = isFailure(b.status) ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.path.localeCompare(b.path);
  });
}

const EVIDENCE_ORDER: TestEvidenceKind[] = ["video", "trace", "screenshot", "log"];
/** One chip per evidence kind, taken from the highest attempt that has it. */
export function pickEvidence(row: VerifyTestRow): Array<{ artifactId: string; kind: TestEvidenceKind; expired: boolean }> {
  const out: Array<{ artifactId: string; kind: TestEvidenceKind; expired: boolean }> = [];
  for (const kind of EVIDENCE_ORDER) {
    const best = row.evidence.filter((e) => e.kind === kind).sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
    if (best) out.push({ artifactId: best.artifactId, kind, expired: best.expired });
  }
  return out;
}

export function repoOptions(rows: VerifyTestRow[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) seen.set(r.repo.id, r.repo.name);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function markAdopted(rows: VerifyTestRow[], key: string, adopted: TestAdoption): VerifyTestRow[] {
  return rows.map((r) => (r.key === key ? { ...r, adopted } : r));
}

export function countRows(rows: VerifyTestRow[]): VerifyTestCounts {
  const c: VerifyTestCounts = { ran: 0, e2e: 0, unit: 0, passed: 0, failed: 0, archived: 0 };
  for (const r of rows) {
    if (r.archived) {
      c.archived++;
      continue;
    }
    if (r.status !== "not_run") c.ran++;
    c[r.category]++;
    if (r.status === "pass") c.passed++;
    if (isFailure(r.status)) c.failed++;
  }
  return c;
}

/** Applies an archive toggle to every row of `reviewId` whose path is in `paths`. */
export function markArchived(rows: VerifyTestRow[], reviewId: string, paths: string[], archived: boolean, at: number = Date.now()): VerifyTestRow[] {
  const set = new Set(paths);
  return rows.map((r) => (r.review.id === reviewId && set.has(r.path) ? { ...r, archived: archived ? { at } : null } : r));
}

export type BrowserBanner = { text: string; action: string; href: string; repos: string[]; keys: string[] };

// A dismissal names the run that raised the flag, so the next run that re-flags the repo shows it again.
export function bannerKey(e: BrowserSetupEntry): string {
  return `${e.repoId}:${e.lastBrowserless?.runId ?? ""}`;
}

/** The dismissed keys that still match a current entry; the rest belong to superseded runs. */
export function pruneDismissed(setup: BrowserSetupEntry[] | null | undefined, dismissed: Iterable<string>): string[] {
  const live = new Set((setup ?? []).map(bannerKey));
  return [...new Set(dismissed)].filter((k) => live.has(k));
}

// Fix links are absolute on the app's origin; the banner navigates in-app, and only to the setup panel.
function setupPath(fixUrl: string, repoId: string): string {
  try {
    const u = new URL(fixUrl, "http://app.invalid");
    if (u.pathname === "/workflow" && u.searchParams.get("setup") === "browser") return `${u.pathname}${u.search}`;
  } catch {
    // fall through to the path built from the repo id
  }
  return `/workflow?${new URLSearchParams({ repo: repoId, setup: "browser" })}`;
}

// "failing" covers both an app that never came up and browser tests that ran and could not decide.
type BrowserlessCause = "not_configured" | "did_not_start" | "browser_errored" | "runner_outdated";
function bannerCause(e: BrowserSetupEntry): BrowserlessCause {
  if (e.status !== "failing") return e.status === "runner_outdated" ? "runner_outdated" : "not_configured";
  return e.lastBrowserless?.reason === "browser_errored" ? "browser_errored" : "did_not_start";
}

/** Repos whose latest run checked UI criteria without a browser and still need setup, newest first. */
export function browserBanner(setup: BrowserSetupEntry[] | null | undefined, dismissed: ReadonlySet<string> = new Set()): BrowserBanner | null {
  const hit = (setup ?? [])
    .filter((e) => (e.status === "not_configured" || e.status === "failing" || e.status === "runner_outdated") && (e.lastBrowserless?.count ?? 0) > 0)
    .filter((e) => !dismissed.has(bannerKey(e)))
    .sort((a, b) => b.lastBrowserless!.at - a.lastBrowserless!.at);
  if (hit.length === 0) return null;
  const repos = hit.map((e) => e.repo);
  const causes = new Set(hit.map(bannerCause));
  // Mixed causes name none of them, but the status they share still says where to send the maintainer.
  const cause = causes.size === 1 ? [...causes][0] : null;
  const configured = hit.every((e) => e.status === "failing");
  const where = repos.length === 1 ? repos[0] : `${repos.length} repositories`;
  const because =
    cause === "did_not_start" ? " because the app did not start in CI" :
    cause === "browser_errored" ? " because their browser tests could not run" :
    cause === "runner_outdated" ? " because the runner in CI is too old" : "";
  return {
    text: `UI criteria on ${where} were checked without a browser${because}`,
    action: configured ? "see setup" : cause === "runner_outdated" ? "update the runner" : "set up browser tests",
    href: setupPath(hit[0].fixUrl, hit[0].repoId),
    repos,
    keys: hit.map(bannerKey),
  };
}

export type TestDetail = {
  test: { id: string; path: string; level: string; origin: TestOrigin; runner: string; adopted: TestAdoption | null };
  criteria: Array<{ id: string; text: string; verdict: "pass" | "fail" | "unverifiable" | "pending"; reason: string }>;
  result: { status: ResultStatus; durationMs: number; error: string | null; attempts: Array<{ n: number; status: string; durationMs: number; error: string | null }> } | null;
  recordings: Recording[];
  others: Array<{ artifactId: string; kind: TestEvidenceKind; attempt: number | null; getUrl: string | null; expiresAt: number; expired: boolean }>;
};

/** The earliest deletion time among a test's still-live evidence, or null when none is live. */
export function soonestEvidenceExpiry(detail: Pick<TestDetail, "recordings" | "others">): number | null {
  const live = [...detail.recordings, ...detail.others].filter((a) => !a.expired).map((a) => a.expiresAt);
  return live.length ? Math.min(...live) : null;
}

/** Everything the drawer shows for one test of a fully loaded run view. */
export function testDetail(view: RunView | null, testId: string, now: number = Date.now()): TestDetail | null {
  const test = view?.plan?.tests.find((t) => t.id === testId);
  if (!view || !test) return null;
  const mine = view.artifacts.filter((a) => a.testId === testId);
  const videos = mine.filter((a) => a.kind === "video").sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  const isExpired = (a: RunViewArtifact) => a.state === "expired" || a.expiresAt <= now;
  const r = (view.results ?? []).find((x) => x.testId === testId) ?? null;
  const terminal = ["completed", "failed", "lost", "timed_out", "skipped"].includes(view.run.status);
  return {
    test: { id: test.id, path: test.path, level: test.level, origin: test.origin, runner: test.runner, adopted: test.adopted ?? null },
    criteria: test.criterionIds.map((id) => {
      const c = view.criteria.find((x) => x.id === id);
      const v = view.run.verdicts.find((x) => x.criterionId === id);
      return { id, text: c?.text ?? id, verdict: v?.verdict ?? (terminal ? "unverifiable" : "pending"), reason: v?.reason ?? "" };
    }),
    result: r
      ? {
          status: r.status,
          durationMs: r.durationMs,
          error: r.error ?? null,
          attempts: r.attempts.map((a) => ({ n: a.n, status: a.status, durationMs: a.durationMs, error: a.error ?? null })),
        }
      : null,
    recordings: videos.map((v) => recordingFromVideo(view, v, mine, now)),
    others: mine
      .filter((a) => a.kind === "trace" || a.kind === "screenshot" || a.kind === "log")
      .sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
      .map((a) => ({ artifactId: a.id, kind: a.kind as TestEvidenceKind, attempt: a.attempt ?? null, getUrl: isExpired(a) ? null : a.getUrl, expiresAt: a.expiresAt, expired: isExpired(a) })),
  };
}
