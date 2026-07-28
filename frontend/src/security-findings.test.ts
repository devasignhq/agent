// Unit tests for the Security page's pure logic (security-findings.ts):
// filtering, stats, chart series, surface breakdown, similar findings, SLA.
// Run either of:
//   npm test
//   node --experimental-strip-types --test src/security-findings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecurityFinding, SecurityScanSummary } from "./api.ts";
import {
  ageLabel,
  chipCounts,
  computeStats,
  displayId,
  filterFindings,
  mergeDeltaPeak,
  mergeDeltaSeries,
  overallGate,
  similarFindings,
  slaLabel,
  sortFindings,
  surfaceBreakdown,
} from "./security-findings.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: Math.random().toString(36).slice(2),
  fingerprint: "abc123def456",
  repoId: "r1",
  repo: "acme/pay",
  path: "api/pay.ts",
  class: "missing-authz",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "t",
  concern: "c",
  state: "open",
  firstDetectedAt: NOW - DAY,
  lastSeenAt: NOW,
  detectedSha: "s",
  model: "m",
  activity: [],
  bounty: null,
  ...over,
});

const scan = (over: Partial<SecurityScanSummary> = {}): SecurityScanSummary => ({
  id: Math.random().toString(36).slice(2),
  repoId: "r1",
  trigger: "merge",
  full: false,
  prNumber: 487,
  status: "completed",
  startedAt: NOW - DAY,
  finishedAt: NOW - DAY + 40_000,
  filesScanned: 10,
  cacheHits: 5,
  introduced: 2,
  resolved: 1,
  stillOpen: 4,
  ...over,
});

test("filterFindings: chips select the right states, repo filter scopes", () => {
  const rows = [
    finding({ state: "new" }),
    finding({ state: "open", severity: "high" }),
    finding({ state: "bounty" }),
    finding({ state: "accepted" }),
    finding({ state: "resolved" }),
    finding({ state: "open", repoId: "r2" }),
  ];
  assert.equal(filterFindings(rows, { chip: "new", repoId: "all" }).length, 1);
  // all open = new + open + bounty (+ r2's open), never accepted/resolved
  assert.equal(filterFindings(rows, { chip: "all", repoId: "all" }).length, 4);
  assert.equal(filterFindings(rows, { chip: "all", repoId: "r1" }).length, 3);
  assert.equal(filterFindings(rows, { chip: "critical", repoId: "all" }).length, 3);
  assert.equal(filterFindings(rows, { chip: "bounty", repoId: "all" }).length, 1);
  assert.equal(filterFindings(rows, { chip: "accepted", repoId: "all" }).length, 1);
  const counts = chipCounts(rows, "all");
  assert.equal(counts.all, 4);
  assert.equal(counts.accepted, 1);
});

test("sortFindings: severity first, then recency", () => {
  const a = finding({ severity: "low", lastSeenAt: NOW });
  const b = finding({ severity: "critical", lastSeenAt: NOW - DAY });
  const c = finding({ severity: "critical", lastSeenAt: NOW });
  const out = sortFindings([a, b, c]);
  assert.deepEqual(out.map((f) => f.id), [c.id, b.id, a.id]);
});

test("computeStats: open/new/resolved-30d/mean-time-to-fix", () => {
  const rows = [
    finding({ state: "new" }),
    finding({ state: "open" }),
    finding({ state: "resolved", firstDetectedAt: NOW - 5 * DAY, resolvedAt: NOW - DAY }), // 4d to fix
    finding({ state: "resolved", firstDetectedAt: NOW - 3 * DAY, resolvedAt: NOW - DAY }), // 2d to fix
    finding({ state: "resolved", resolvedAt: NOW - 60 * DAY, firstDetectedAt: NOW - 65 * DAY }), // outside 30d
  ];
  const s = computeStats(rows, [scan()], NOW);
  assert.equal(s.open, 2);
  assert.equal(s.introducedByLastMerge, 1);
  assert.equal(s.lastMergePr, 487);
  assert.equal(s.resolved30d, 2);
  assert.equal(s.meanTimeToFixDays, 3); // mean of 4d and 2d
});

test("mergeDeltaSeries: oldest→newest, capped, repo-scoped, skips queued", () => {
  const scans = [
    scan({ startedAt: NOW - 3 * DAY, prNumber: 485 }),
    scan({ startedAt: NOW - 2 * DAY, prNumber: 486 }),
    scan({ startedAt: NOW - DAY, prNumber: 487 }),
    scan({ startedAt: NOW, status: "queued", prNumber: 488 }),
    scan({ startedAt: NOW, repoId: "r2", prNumber: 999 }),
  ];
  const out = mergeDeltaSeries(scans, "r1", 2);
  assert.deepEqual(out.map((c) => c.label), ["#486", "#487"]);
  assert.equal(out[1].introduced, 2);
  // Only the newest column is flagged "now" (the dashed highlight).
  assert.deepEqual(out.map((c) => c.now), [false, true]);
});

test("mergeDeltaSeries: stacks segments critical→low and drops empty severities", () => {
  const out = mergeDeltaSeries(
    [scan({ introduced: 4, introducedBySeverity: { low: 1, critical: 2, high: 1 } })],
    "r1",
    12
  );
  assert.deepEqual(out[0].segments, [
    { severity: "critical", count: 2 },
    { severity: "high", count: 1 },
    { severity: "low", count: 1 },
  ]);
});

test("mergeDeltaSeries: a run with no stored split still renders, as one 'unknown' segment", () => {
  // Rows written before introducedBySeverity existed must not vanish from the
  // chart — they carry a total but no breakdown.
  const out = mergeDeltaSeries([scan({ introduced: 3, introducedBySeverity: undefined })], "r1", 12);
  assert.deepEqual(out[0].segments, [{ severity: "unknown", count: 3 }]);
});

test("mergeDeltaSeries: a partial split is topped up so the segments sum to the total", () => {
  const out = mergeDeltaSeries(
    [scan({ introduced: 5, introducedBySeverity: { critical: 2 } })],
    "r1",
    12
  );
  assert.equal(out[0].segments.reduce((n, s) => n + s.count, 0), 5);
  assert.deepEqual(out[0].segments.at(-1), { severity: "unknown", count: 3 });
});

test("mergeDeltaPeak: the taller side of the axis wins, and never returns 0", () => {
  assert.equal(mergeDeltaPeak(mergeDeltaSeries([scan({ introduced: 2, resolved: 7 })], "r1", 12)), 7);
  assert.equal(mergeDeltaPeak(mergeDeltaSeries([scan({ introduced: 9, resolved: 1 })], "r1", 12)), 9);
  assert.equal(mergeDeltaPeak([]), 1);
});

test("surfaceBreakdown counts open findings per surface with severity split", () => {
  const rows = [
    finding({ surface: "api", severity: "critical" }),
    finding({ surface: "api", severity: "high", state: "new" }),
    finding({ surface: "secrets", state: "resolved" }), // closed → excluded
  ];
  const out = surfaceBreakdown(rows, "all");
  const apiRow = out.find((r) => r.surface === "api")!;
  assert.equal(apiRow.count, 2);
  assert.equal(apiRow.fresh, 1);
  assert.deepEqual(apiRow.bySeverity.map((b) => b.severity), ["critical", "high"]);
  assert.equal(out.find((r) => r.surface === "secrets")!.count, 0);
});

test("similarFindings: same CWE beats same surface, self excluded, capped", () => {
  const me = finding({ cwe: "CWE-89", surface: "api" });
  const cweMatch = finding({ cwe: "CWE-89", surface: "frontend" });
  const surfMatch = finding({ surface: "api" });
  const other = finding({ surface: "deps" });
  const out = similarFindings(me, [me, surfMatch, cweMatch, other]);
  assert.deepEqual(out.map((f) => f.id), [cweMatch.id, surfMatch.id]);
});

test("overallGate fails when any repo gate fails", () => {
  const pass = { gate: { verdict: "pass" as const, rules: [], blockingFindingIds: [] } };
  const fail = { gate: { verdict: "fail" as const, rules: [], blockingFindingIds: [] } };
  assert.equal(overallGate([pass, pass]), "pass");
  assert.equal(overallGate([pass, fail]), "fail");
});

test("slaLabel: critical breaches after a day; closed findings show a dash", () => {
  const overdue = slaLabel(finding({ firstDetectedAt: NOW - 2 * DAY, severity: "critical" }), NOW);
  assert.equal(overdue.breached, true);
  assert.match(overdue.text, /overdue/);
  const fine = slaLabel(finding({ firstDetectedAt: NOW, severity: "high" }), NOW);
  assert.equal(fine.breached, false);
  assert.equal(slaLabel(finding({ state: "resolved" }), NOW).text, "—");
});

test("ageLabel + displayId formatting", () => {
  assert.equal(ageLabel(NOW - 30_000, NOW), "30s");
  assert.equal(ageLabel(NOW - 90 * 60_000, NOW), "1h");
  assert.equal(ageLabel(NOW - 3 * DAY, NOW), "3d");
  assert.equal(displayId(finding({ fingerprint: "abc123def456" })), "VLN-ABC123");
});
