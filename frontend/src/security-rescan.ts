// Pure logic for the Security page's "Rescan" picker — which repos are already
// scanning, what the popup starts with ticked, and how to word the progress and
// result lines. Extracted from screen-security.tsx so `node --test` can drive it
// offline (the house pattern; see security-findings.ts / live-bus.ts). No React.
//
// Run: node --experimental-strip-types --test src/security-rescan.test.ts
import type { SecurityRepoView, SecurityScanBatch, SecurityScanSummary } from "./api.ts";

/**
 * Repos with a run in flight. The single source of truth for "is this repo
 * scanning" — the backstop poll, the progress line and the picker all read it,
 * so they can never disagree about which repos are busy.
 *
 * Note this is keyed by repo. The old page-level `scanning` boolean was global,
 * which is why one stuck run disabled the button for every repo at once.
 */
export function scanningRepoIds(scans: SecurityScanSummary[]): Set<string> {
  return new Set(
    scans.filter((s) => s.status === "queued" || s.status === "running").map((s) => s.repoId)
  );
}

/** A repo can be re-scanned unless it already has a run in flight. */
export function selectableRepos(
  repos: SecurityRepoView[],
  scanning: Set<string>
): SecurityRepoView[] {
  return repos.filter((r) => !scanning.has(r.id));
}

/**
 * What the popup opens with ticked: just the repo the dashboard is filtered to,
 * if it names one and is free; otherwise everything that can be scanned.
 */
export function defaultSelection(
  repos: SecurityRepoView[],
  scanning: Set<string>,
  repoFilter: string
): Set<string> {
  const free = selectableRepos(repos, scanning);
  if (repoFilter !== "all") {
    const hit = free.find((r) => r.id === repoFilter);
    if (hit) return new Set([hit.id]);
  }
  return new Set(free.map((r) => r.id));
}

function plural(n: number): string {
  return n === 1 ? "repository" : "repositories";
}

/**
 * The in-progress line under the page header. This is where scan progress
 * lives now that the button always reads "Rescan" — the button no longer
 * doubles as a status display.
 */
export function scanProgressLabel(
  repos: SecurityRepoView[],
  scanning: Set<string>
): string | null {
  // Only count repos still on the page; a scan row for a repo that has since
  // been removed from the installation shouldn't show up as progress.
  const busy = repos.filter((r) => scanning.has(r.id)).length;
  if (busy === 0) return null;
  return `Scanning ${busy} of ${repos.length} ${plural(repos.length)}…`;
}

/** One-line outcome for the notice after the picker submits. */
export function summarizeRescan(batch: SecurityScanBatch): string {
  const parts: string[] = [];
  if (batch.queued.length > 0) {
    parts.push(`Re-scan queued for ${batch.queued.length} ${plural(batch.queued.length)}`);
  }
  if (batch.skipped.length > 0) {
    parts.push(`${batch.skipped.length} already scanning`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing to scan.";
}
