// Pure logic for the Security page — filtering, sorting, stats, chart series —
// extracted from screen-security.tsx so `node --test` can drive it offline
// (the house pattern; see live-bus.ts / bounty-csv.ts). No React, no DOM.
//
// Run: node --experimental-strip-types --test src/security-findings.test.ts
import type {
  AttackSurface,
  GateResult,
  SecurityFinding,
  SecurityScanSummary,
  SecuritySeverity,
} from "./api.ts";

// ── severity / state presentation ───────────────────────────────────────────

export const SEVERITIES: readonly SecuritySeverity[] = ["critical", "high", "medium", "low"];

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function severityRank(sev: string): number {
  return SEV_RANK[sev] ?? 2;
}

// State → short label + pill tone (tone maps onto the .vln-tag modifiers).
export const STATE_LABEL: Record<string, { label: string; tone: "new" | "ok" | "plain" | "none" }> = {
  new: { label: "new", tone: "new" },
  open: { label: "open", tone: "none" },
  issue_created: { label: "issue open", tone: "none" },
  bounty: { label: "bounty", tone: "ok" },
  fix_ready: { label: "fix PR ready", tone: "ok" },
  resolved: { label: "resolved", tone: "plain" },
  accepted: { label: "accepted risk", tone: "plain" },
  false_positive: { label: "false positive", tone: "plain" },
  snoozed: { label: "snoozed", tone: "plain" },
};

// States that count as "open work" on the dashboard.
export const OPEN_STATES = ["new", "open", "issue_created", "bounty", "fix_ready", "snoozed"];

export function isOpenState(state: string): boolean {
  return OPEN_STATES.includes(state);
}

// ── filtering ───────────────────────────────────────────────────────────────

export type FilterChip = "new" | "all" | "critical" | "bounty" | "accepted";

export const CHIPS: ReadonlyArray<{ key: FilterChip; label: string }> = [
  { key: "new", label: "New" },
  { key: "all", label: "All open" },
  { key: "critical", label: "Critical" },
  { key: "bounty", label: "Bounty-backed" },
  { key: "accepted", label: "Accepted risk" },
];

export function chipMatches(chip: FilterChip, f: SecurityFinding): boolean {
  switch (chip) {
    case "new":
      return f.state === "new";
    case "all":
      return isOpenState(f.state);
    case "critical":
      return f.severity === "critical" && isOpenState(f.state);
    case "bounty":
      return f.state === "bounty" || f.state === "fix_ready";
    case "accepted":
      return f.state === "accepted";
  }
}

// ── free-text search ────────────────────────────────────────────────────────

// Everything the row puts on screen (plus the fingerprint the display id is cut
// from), flattened into one lowercase blob. Keeps the matcher honest: if a
// column is visible, typing what's in it finds the row.
export function findingHaystack(f: SecurityFinding): string {
  return [
    displayId(f),
    f.fingerprint,
    f.title,
    f.concern,
    f.path,
    f.line == null ? "" : `:${f.line}`,
    f.symbol ?? "",
    f.class,
    f.cwe ?? "",
    f.repo,
    f.surface,
    f.severity,
    f.state,
    STATE_LABEL[f.state]?.label ?? "",
    f.introducedByPr == null ? "" : `#${f.introducedByPr}`,
    f.introducedByAuthor ? `@${f.introducedByAuthor}` : "",
    f.issueNumber == null ? "" : `#${f.issueNumber}`,
    f.assigneeLogin ? `@${f.assigneeLogin}` : "",
    f.bounty?.code ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

// Whitespace-separated terms, ALL of which must appear somewhere in the row —
// so "critical pay" narrows instead of widening. A blank query matches
// everything, which is what lets the search box start empty.
export function matchesQuery(f: SecurityFinding, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = findingHaystack(f);
  return terms.every((t) => hay.includes(t));
}

export function filterFindings(
  findings: SecurityFinding[],
  opts: { chip: FilterChip; repoId: string | "all"; query?: string }
): SecurityFinding[] {
  const query = opts.query ?? "";
  return findings.filter(
    (f) =>
      (opts.repoId === "all" || f.repoId === opts.repoId) &&
      chipMatches(opts.chip, f) &&
      matchesQuery(f, query)
  );
}

// Counts respect the search too — otherwise a chip promising 12 opens a list of
// 2 and the search looks broken.
export function chipCounts(
  findings: SecurityFinding[],
  repoId: string | "all",
  query = ""
): Record<FilterChip, number> {
  const scoped = findings.filter(
    (f) => (repoId === "all" || f.repoId === repoId) && matchesQuery(f, query)
  );
  const counts = { new: 0, all: 0, critical: 0, bounty: 0, accepted: 0 } as Record<FilterChip, number>;
  for (const chip of ["new", "all", "critical", "bounty", "accepted"] as FilterChip[]) {
    counts[chip] = scoped.filter((f) => chipMatches(chip, f)).length;
  }
  return counts;
}

// Severity first (critical → low), then most recently seen.
export function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return b.lastSeenAt - a.lastSeenAt;
  });
}

// ── stats ───────────────────────────────────────────────────────────────────

export type SecurityStats = {
  open: number;
  openCritical: number;
  introducedByLastMerge: number; // state "new"
  lastMergePr: number | null;
  resolved30d: number;
  meanTimeToFixDays: number | null; // over findings resolved in the last 30d
};

export function computeStats(
  findings: SecurityFinding[],
  scans: SecurityScanSummary[],
  now: number
): SecurityStats {
  const open = findings.filter((f) => isOpenState(f.state));
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const resolved30 = findings.filter(
    (f) => f.state === "resolved" && (f.resolvedAt ?? 0) >= cutoff
  );
  const fixTimes = resolved30
    .map((f) => (f.resolvedAt ?? 0) - f.firstDetectedAt)
    .filter((ms) => ms > 0);
  const meanMs = fixTimes.length
    ? fixTimes.reduce((a, b) => a + b, 0) / fixTimes.length
    : null;
  const lastMerge = scans
    .filter((s) => s.trigger === "merge" && s.status === "completed")
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return {
    open: open.length,
    openCritical: open.filter((f) => f.severity === "critical").length,
    introducedByLastMerge: findings.filter((f) => f.state === "new").length,
    lastMergePr: lastMerge?.prNumber ?? null,
    resolved30d: resolved30.length,
    meanTimeToFixDays: meanMs === null ? null : Math.round((meanMs / 86_400_000) * 10) / 10,
  };
}

// ── introduced-vs-resolved chart ────────────────────────────────────────────

export type MergeDeltaCol = {
  label: string;      // "#487" or a short trigger label
  introduced: number;
  // Stacked segments, critical → low, zero-count severities omitted. Falls back
  // to a single "unknown" segment for runs written before the split was stored.
  segments: Array<{ severity: SecuritySeverity | "unknown"; count: number }>;
  resolved: number;
  running: boolean;
  now: boolean;       // the most recent column — highlighted in the chart
  // Nothing introduced and nothing resolved: the column draws no bars, so the
  // chart has to say why rather than render a silent blank.
  noop: boolean;
  // Set when the run never scanned at all (plan-gated, no install token, index
  // not built) — a different kind of flat from "scanned, nothing changed".
  skipped?: SecurityScanSummary["skipped"];
};

// Why a run scanned nothing, in the tooltip's words.
export const SKIP_REASON_LABEL: Record<
  NonNullable<SecurityScanSummary["skipped"]>,
  string
> = {
  no_install: "skipped — no GitHub installation",
  plan_locked: "skipped — audits are a Pro/Max feature",
  index_not_built: "skipped — repo index not built yet",
  repo_not_found: "failed — repository not found",
};

// Last `limit` scan runs (any trigger), oldest → newest, as chart columns.
export function mergeDeltaSeries(
  scans: SecurityScanSummary[],
  repoId: string | "all",
  limit: number
): MergeDeltaCol[] {
  const rows = scans
    .filter((s) => repoId === "all" || s.repoId === repoId)
    .filter((s) => s.status === "completed" || s.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-limit);
  return rows.map((s, i) => {
    const split = s.introducedBySeverity ?? {};
    const segments = SEVERITIES.map((severity) => ({
      severity: severity as SecuritySeverity | "unknown",
      count: split[severity] ?? 0,
    })).filter((seg) => seg.count > 0);
    const known = segments.reduce((n, seg) => n + seg.count, 0);
    // A legacy run has a total but no split — show it as one neutral segment
    // rather than dropping the bar entirely.
    if (known < s.introduced) {
      segments.push({ severity: "unknown", count: s.introduced - known });
    }
    return {
      label: s.prNumber ? `#${s.prNumber}` : s.trigger === "manual" ? "scan" : s.trigger,
      introduced: s.introduced,
      segments,
      resolved: s.resolved,
      running: s.status === "running",
      now: i === rows.length - 1,
      noop: s.introduced === 0 && s.resolved === 0,
      ...(s.skipped ? { skipped: s.skipped } : {}),
    };
  });
}

// Tallest stack on either side of the axis, so both halves share one scale.
// Never 0 — callers divide by it.
export function mergeDeltaPeak(cols: MergeDeltaCol[]): number {
  return Math.max(1, ...cols.map((c) => Math.max(c.introduced, c.resolved)));
}

// Every column flat. A legitimate steady state, but indistinguishable from a
// broken pipeline unless the chart says so — so the panel captions itself.
export function mergeDeltaAllZero(cols: MergeDeltaCol[]): boolean {
  return cols.length > 0 && cols.every((c) => c.noop);
}

// ── attack-surface breakdown ────────────────────────────────────────────────

export const SURFACE_META: Record<AttackSurface, { label: string; icon: string; sub: string }> = {
  api: { label: "API & backend", icon: "code", sub: "routes · authz · data access" },
  frontend: { label: "Frontend", icon: "globe", sub: "DOM sinks · client secrets" },
  infra: { label: "Infrastructure", icon: "terminal", sub: "IaC · CI · containers" },
  deps: { label: "Dependencies", icon: "git", sub: "manifests · advisories" },
  secrets: { label: "Secrets", icon: "lock", sub: "committed credentials" },
};

export type SurfaceRow = {
  surface: AttackSurface;
  count: number;          // open findings
  fresh: number;          // of which state "new"
  bySeverity: Array<{ severity: SecuritySeverity; count: number }>;
};

export function surfaceBreakdown(
  findings: SecurityFinding[],
  repoId: string | "all"
): SurfaceRow[] {
  const scoped = findings.filter(
    (f) => (repoId === "all" || f.repoId === repoId) && isOpenState(f.state)
  );
  const surfaces: AttackSurface[] = ["api", "frontend", "infra", "deps", "secrets"];
  return surfaces.map((surface) => {
    const rows = scoped.filter((f) => f.surface === surface);
    return {
      surface,
      count: rows.length,
      fresh: rows.filter((f) => f.state === "new").length,
      bySeverity: SEVERITIES.map((severity) => ({
        severity,
        count: rows.filter((f) => f.severity === severity).length,
      })).filter((b) => b.count > 0),
    };
  });
}

// ── similar findings ────────────────────────────────────────────────────────

// Same CWE first, then same surface; never itself; capped.
export function similarFindings(
  finding: SecurityFinding,
  all: SecurityFinding[],
  cap = 3
): SecurityFinding[] {
  const others = all.filter((f) => f.id !== finding.id);
  const byCwe = finding.cwe ? others.filter((f) => f.cwe === finding.cwe) : [];
  const bySurface = others.filter((f) => f.surface === finding.surface && !byCwe.includes(f));
  return [...byCwe, ...bySurface].slice(0, cap);
}

// ── gate presentation ───────────────────────────────────────────────────────

// Overall verdict across repos: fail if any repo fails.
export function overallGate(repos: Array<{ gate: GateResult }>): "pass" | "fail" {
  return repos.some((r) => r.gate.verdict === "fail") ? "fail" : "pass";
}

// ── misc formatting ─────────────────────────────────────────────────────────

export function ageLabel(fromMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// SLA hint per severity: target fix window from first detection.
const SLA_DAYS: Record<SecuritySeverity, number> = { critical: 1, high: 7, medium: 30, low: 90 };

export function slaLabel(f: SecurityFinding, now: number): { text: string; breached: boolean } {
  if (!isOpenState(f.state)) return { text: "—", breached: false };
  const target = f.firstDetectedAt + SLA_DAYS[f.severity] * 86_400_000;
  const remaining = target - now;
  if (remaining <= 0) {
    return { text: `overdue by ${ageLabel(target, now)}`, breached: true };
  }
  return { text: `fix within ${ageLabel(now * 2 - target, now)}`, breached: false };
}

// Short display id from the fingerprint — stable, human-scannable.
export function displayId(f: SecurityFinding): string {
  return `VLN-${f.fingerprint.slice(0, 6).toUpperCase()}`;
}
