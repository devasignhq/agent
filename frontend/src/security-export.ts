// CSV/PDF export of security findings.
//
// Pure data + formatting, free of React and the DOM (the house pattern; see
// bounty-csv.ts): column order, escaping and section ordering live here so
// `node --test` can drive them offline. The browser halves are download.ts
// (CSV) and security-export-pdf.ts (drawing only).
//
// The file this produces is handed to a coding agent for bulk triage, which is
// why it carries far more than the on-screen table: the table truncates to six
// columns for density, but an agent acting on a finding needs the concern,
// evidence, remediation and regression test in full.
import type { SecurityFinding } from "./api.ts";
import { guardFormula, toCsv } from "./bounty-csv.ts";
import { displayId, STATE_LABEL } from "./security-findings.ts";

// Resolves a repo's default branch from the overview (the export modules never
// hold the whole overview, just this closure).
export type RepoBranchLookup = (repoId: string) => string | undefined;

const short = (sha: string) => sha.slice(0, 7);

// Every text cell goes through this: most optional fields are `| null` or
// `| undefined`, and interpolating one of those writes a literal "undefined".
// guardFormula matters more here than for transactions — finding prose is
// LLM-authored free text that can plausibly open with "=" or "-".
const text = (value?: string | null) => guardFormula(value ?? "");

const iso = (ms: number) => new Date(ms).toISOString();

// GitHub blob URL for a finding's file — extracted from the Dashboard's
// repoFileUrl so the page link, the CSV column and the PDF location line share
// one builder. Falls back to HEAD when the branch is unknown, to the repo root
// when there's no path, and to null when there's no repo slug at all.
export function findingFileUrl(f: SecurityFinding, branchOf: RepoBranchLookup): string | null {
  if (!f.repo) return null;
  const base = `https://github.com/${f.repo}`;
  if (!f.path) return base;
  const branch = branchOf(f.repoId) ?? "HEAD";
  return `${base}/blob/${branch}/${f.path}${f.line ? `#L${f.line}` : ""}`;
}

// Mirrors the table's origin cell ("#487 @alice · ab12cd3", or "audit" for a
// finding first seen by a full scan) so the export reads like the screen it
// came from. The split PR/author/sha columns exist alongside it for machines.
//
// "audit" means the absence of PR provenance, so it only appears when there is
// no PR reference — a PR with an unknown author is just "#487", never
// "#487 audit".
export function originLabel(f: SecurityFinding): string {
  const head = [
    f.introducedByPr ? `#${f.introducedByPr}` : "",
    f.introducedByAuthor ? `@${f.introducedByAuthor}` : f.introducedByPr ? "" : "audit",
  ]
    .filter(Boolean)
    .join(" ");
  return f.introducedSha ? `${head} · ${short(f.introducedSha)}` : head;
}

// Structured fields flattened to multi-line text, one shape shared by the CSV
// cell and the PDF block so the two exports can't tell different stories.
export function dataflowText(f: SecurityFinding): string {
  const d = f.dataflow;
  if (!d) return "";
  const lines = [`source: ${d.source}`, `sink: ${d.sink}`];
  d.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  return lines.join("\n");
}

export function exploitText(f: SecurityFinding): string {
  return (f.exploitNarrative ?? []).map((step, i) => `${i + 1}. ${step}`).join("\n");
}

// Same screen-word rule as the transactions CSV: export the label the page
// shows, but fall back to the raw wire value rather than "" if a state is
// added to the backend before this map learns it.
const stateLabel = (f: SecurityFinding) => STATE_LABEL[f.state]?.label ?? f.state;

const bountyLabel = (f: SecurityFinding) =>
  f.bounty ? `${f.bounty.code} · ${f.bounty.status} · ${f.bounty.amountUsdc} USDC` : "";

export const FINDINGS_CSV_HEADERS = [
  // Table parity — the six columns in on-screen order, so a spreadsheet opens
  // looking like the page.
  "Severity",
  "ID",
  "Finding",
  "Surface",
  "Origin",
  "Repo",
  "State",
  "Confidence",
  // Location — what an agent needs to open the right file.
  "Class",
  "CWE",
  "Path",
  "Line",
  "Symbol",
  "File URL",
  // Agent-facing detail — the prose the table has no room for.
  "Concern",
  "Evidence",
  "Dataflow",
  "Exploit Narrative",
  "Blast Radius",
  "Invariant",
  "Remediation",
  "Regression Test",
  "State Reason",
  // Workflow context and provenance keys.
  "Issue URL",
  "Bounty",
  "Introduced By PR",
  "Introduced By Author",
  "Introduced SHA",
  "First Detected (UTC)",
  "Last Seen (UTC)",
  "Detected SHA",
  "Fingerprint",
];

// One row per finding. Multi-line prose stays inside its cell — csvCell quotes
// embedded line breaks per RFC 4180 and every parser that matters round-trips
// them. Numeric-ish columns (Line, Introduced By PR) skip guardFormula so they
// import as numbers.
//
// Left out deliberately: `model` (internal), `activity` (an audit log of up to
// 50 events per finding — it would dwarf the data), `assigneeLogin` and
// `snoozeUntil` (triage workflow noise an agent shouldn't act on). Fingerprint
// is included in full as the stable key an agent should report back against —
// the ID column is only its first six characters.
export const findingsCsvRows = (
  findings: SecurityFinding[],
  branchOf: RepoBranchLookup
): string[][] => [
  FINDINGS_CSV_HEADERS,
  ...findings.map((f) => [
    text(f.severity),
    text(displayId(f)),
    text(f.title),
    text(f.surface),
    text(originLabel(f)),
    text(f.repo),
    text(stateLabel(f)),
    text(f.confidence),
    text(f.class),
    text(f.cwe),
    text(f.path),
    f.line != null ? String(f.line) : "",
    text(f.symbol),
    text(findingFileUrl(f, branchOf)),
    text(f.concern),
    text(f.evidence),
    text(dataflowText(f)),
    text(exploitText(f)),
    text(f.blastRadius),
    text(f.invariant),
    text(f.remediation),
    text(f.regressionTest),
    text(f.stateReason),
    text(f.issueUrl),
    text(bountyLabel(f)),
    f.introducedByPr != null ? String(f.introducedByPr) : "",
    text(f.introducedByAuthor),
    text(f.introducedSha),
    iso(f.firstDetectedAt),
    iso(f.lastSeenAt),
    text(f.detectedSha),
    text(f.fingerprint),
  ]),
];

export const findingsCsv = (findings: SecurityFinding[], branchOf: RepoBranchLookup): string =>
  toCsv(findingsCsvRows(findings, branchOf));

// devasign-security-findings[-owner-name]-YYYY-MM-DD.{csv,pdf}. The repo slug
// is present only when the page is filtered to one repo, and goes through the
// same sanitiser as every other filename ("/" alone would break it). UTC date,
// matching the timestamp columns.
export function exportFilename(
  ext: "csv" | "pdf",
  nowMs: number,
  repoSlug: string | null
): string {
  const stem = `devasign-security-findings${repoSlug ? `-${repoSlug}` : ""}-${iso(nowMs).slice(0, 10)}`;
  return `${stem.replace(/[^A-Za-z0-9._-]+/g, "-")}.${ext}`;
}

// ─── PDF sections ────────────────────────────────────────────────────────────
// The PDF's per-finding detail blocks, computed here so ordering and the
// omission of absent fields are unit-testable; security-export-pdf.ts only
// draws what this returns.

export type DetailBlock = { label: string; text: string };

export function findingDetailBlocks(f: SecurityFinding): DetailBlock[] {
  const blocks: Array<[string, string | null | undefined]> = [
    ["Concern", f.concern],
    ["Evidence", f.evidence],
    ["Dataflow", dataflowText(f)],
    ["Exploit narrative", exploitText(f)],
    ["Blast radius", f.blastRadius],
    ["Invariant", f.invariant],
    ["Remediation", f.remediation],
    ["Regression test", f.regressionTest],
    ["State reason", f.stateReason],
  ];
  return blocks
    .filter((entry): entry is [string, string] => Boolean(entry[1] && entry[1].trim()))
    .map(([label, body]) => ({ label, text: body }));
}

// "critical · confirmed · api · sql-injection · CWE-89 · state: open"
export function findingMetaLine(f: SecurityFinding): string {
  return [f.severity, f.confidence, f.surface, f.class, f.cwe, `state: ${stateLabel(f)}`]
    .filter(Boolean)
    .join(" · ");
}

// "owner/name · src/x.ts:42 · handler()" with the blob URL on a second line
// when the finding names a file (the bare repo URL would only repeat the slug).
export function findingLocationLine(f: SecurityFinding, branchOf: RepoBranchLookup): string {
  const loc = [f.repo, f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "", f.symbol]
    .filter(Boolean)
    .join(" · ");
  const url = f.path ? findingFileUrl(f, branchOf) : null;
  return url ? `${loc}\n${url}` : loc;
}
