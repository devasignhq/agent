// Unit tests for the findings export logic (security-export.ts): CSV shape,
// formula neutering, URL building, PDF block ordering, filenames.
// Run either of:
//   npm test
//   node --experimental-strip-types --test src/security-export.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecurityFinding } from "./api.ts";
import {
  FINDINGS_CSV_HEADERS,
  dataflowText,
  exploitText,
  exportFilename,
  findingDetailBlocks,
  findingFileUrl,
  findingLocationLine,
  findingMetaLine,
  findingsCsv,
  findingsCsvRows,
  originLabel,
} from "./security-export.ts";

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

const branchOf = (repoId: string) => (repoId === "r1" ? "main" : undefined);

test("findingsCsvRows: every row matches the header width", () => {
  const rows = findingsCsvRows(
    [
      finding(),
      finding({
        line: 42,
        symbol: "handler",
        cwe: "CWE-89",
        evidence: "e",
        dataflow: { source: "req.body", sink: "db.query", steps: ["a", "b"] },
        exploitNarrative: ["one", "two", "three"],
        blastRadius: "all tenants",
        invariant: "inv",
        remediation: "fix",
        regressionTest: "test",
        stateReason: "because",
        issueUrl: "https://github.com/acme/pay/issues/9",
        bounty: { id: "b1", code: "DA-8842", status: "open", amountUsdc: 500 },
        introducedByPr: 487,
        introducedByAuthor: "alice",
        introducedSha: "ab12cd34ef",
      }),
    ],
    branchOf
  );
  for (const row of rows) assert.equal(row.length, FINDINGS_CSV_HEADERS.length);
});

test("findingsCsvRows: formula triggers in LLM prose are neutered", () => {
  const [, row] = findingsCsvRows(
    [finding({ title: "=HYPERLINK(\"http://evil\")", concern: "-rm -rf notes" })],
    branchOf
  );
  assert.equal(row[FINDINGS_CSV_HEADERS.indexOf("Finding")], "'=HYPERLINK(\"http://evil\")");
  assert.equal(row[FINDINGS_CSV_HEADERS.indexOf("Concern")], "'-rm -rf notes");
  // Numeric columns are exempt — a guarded number stops being a number.
  const numbered = findingsCsvRows([finding({ line: 7, introducedByPr: 12 })], branchOf)[1];
  assert.equal(numbered[FINDINGS_CSV_HEADERS.indexOf("Line")], "7");
  assert.equal(numbered[FINDINGS_CSV_HEADERS.indexOf("Introduced By PR")], "12");
});

test("findingsCsv: multi-line concern stays one quoted cell, one row", () => {
  const csv = findingsCsv([finding({ concern: "line one\nline two" })], branchOf);
  assert.ok(csv.includes('"line one\nline two"'));
  // Header + one data row + trailing CRLF — the embedded bare LF must not
  // create a third row (rows are CRLF-terminated, the LF stays inside quotes).
  assert.equal(csv.split("\r\n").length, 3);
});

test("findingsCsvRows: absent optionals export as empty cells, never 'undefined'", () => {
  const [, row] = findingsCsvRows([finding()], branchOf);
  for (const col of ["CWE", "Line", "Symbol", "Evidence", "Dataflow", "Exploit Narrative", "Bounty", "Issue URL"]) {
    assert.equal(row[FINDINGS_CSV_HEADERS.indexOf(col)], "", col);
  }
  assert.ok(!row.includes("undefined"));
});

test("findingFileUrl: branch, HEAD fallback, no-path, no-repo", () => {
  assert.equal(
    findingFileUrl(finding({ line: 42 }), branchOf),
    "https://github.com/acme/pay/blob/main/api/pay.ts#L42"
  );
  assert.equal(
    findingFileUrl(finding({ repoId: "r2" }), branchOf),
    "https://github.com/acme/pay/blob/HEAD/api/pay.ts"
  );
  assert.equal(findingFileUrl(finding({ path: "" }), branchOf), "https://github.com/acme/pay");
  assert.equal(findingFileUrl(finding({ repo: "" }), branchOf), null);
});

test("originLabel: PR provenance vs audit fallback", () => {
  assert.equal(
    originLabel(finding({ introducedByPr: 487, introducedByAuthor: "alice", introducedSha: "ab12cd34ef" })),
    "#487 @alice · ab12cd3"
  );
  assert.equal(originLabel(finding()), "audit");
  assert.equal(originLabel(finding({ introducedSha: "ab12cd34ef" })), "audit · ab12cd3");
});

test("dataflowText / exploitText: numbered steps, empty when absent", () => {
  const f = finding({
    dataflow: { source: "req.body", sink: "db.query", steps: ["taint enters", "reaches sink"] },
    exploitNarrative: ["craft payload", "send it", "read other tenant"],
  });
  assert.equal(dataflowText(f), "source: req.body\nsink: db.query\n1. taint enters\n2. reaches sink");
  assert.equal(exploitText(f), "1. craft payload\n2. send it\n3. read other tenant");
  assert.equal(dataflowText(finding()), "");
  assert.equal(exploitText(finding()), "");
});

test("findingDetailBlocks: full finding yields all blocks in order, sparse omits", () => {
  const full = finding({
    evidence: "e",
    dataflow: { source: "s", sink: "k", steps: [] },
    exploitNarrative: ["x"],
    blastRadius: "b",
    invariant: "i",
    remediation: "r",
    regressionTest: "rt",
    stateReason: "sr",
  });
  assert.deepEqual(
    findingDetailBlocks(full).map((b) => b.label),
    [
      "Concern",
      "Evidence",
      "Dataflow",
      "Exploit narrative",
      "Blast radius",
      "Invariant",
      "Remediation",
      "Regression test",
      "State reason",
    ]
  );
  assert.deepEqual(findingDetailBlocks(finding()).map((b) => b.label), ["Concern"]);
});

test("findingMetaLine / findingLocationLine", () => {
  const f = finding({ cwe: "CWE-89", line: 42, symbol: "handler" });
  assert.equal(
    findingMetaLine(f),
    "critical · confirmed · api · missing-authz · CWE-89 · state: open"
  );
  // No CWE → no dangling separator.
  assert.equal(findingMetaLine(finding()), "critical · confirmed · api · missing-authz · state: open");
  assert.equal(
    findingLocationLine(f, branchOf),
    "acme/pay · api/pay.ts:42 · handler\nhttps://github.com/acme/pay/blob/main/api/pay.ts#L42"
  );
  // Pathless finding: no URL line at all.
  assert.equal(findingLocationLine(finding({ path: "" }), branchOf), "acme/pay");
});

test("exportFilename: date stem, optional repo slug, hostile characters", () => {
  assert.equal(exportFilename("csv", NOW, null), "devasign-security-findings-1970-04-11.csv");
  assert.equal(
    exportFilename("pdf", NOW, "acme/web-app"),
    "devasign-security-findings-acme-web-app-1970-04-11.pdf"
  );
  assert.equal(
    exportFilename("csv", NOW, "we?ird/na me"),
    "devasign-security-findings-we-ird-na-me-1970-04-11.csv"
  );
});
