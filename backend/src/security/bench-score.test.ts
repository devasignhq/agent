// Unit tests for the benchmark scorer and the local index builder. No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/bench-score.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectionMatchesCase, headline, rates, scoreRun, type BenchCase, type BenchDetection } from "./bench-score.js";
import { buildLocalIndex, parseExports, parseRelativeImports } from "./local-index.js";

const R1: BenchCase = {
  id: "R1",
  kind: "real",
  path: "src/routes/invoices.ts",
  symbol: "invoicesRouter",
  classAliases: ["idor", "missing-authz", "tenant-isolation"],
  proof: "runtime",
};
const D1: BenchCase = {
  id: "D1",
  kind: "decoy",
  path: "src/routes/admin.ts",
  symbol: "adminRouter",
  classAliases: ["missing-authz"],
  proof: "runtime",
};
const CASES = [R1, D1];

const det = (over: Partial<BenchDetection> = {}): BenchDetection => ({
  path: "src/routes/invoices.ts",
  class: "idor",
  symbol: "invoicesRouter",
  title: "t",
  severity: "high",
  verification: "confirmed",
  ...over,
});

test("matching is by path plus class alias, and tolerates a made-up class when the symbol lines up", () => {
  assert.equal(detectionMatchesCase(det(), R1), true);
  assert.equal(detectionMatchesCase(det({ class: "Missing AuthZ" }), R1), true);
  assert.equal(detectionMatchesCase(det({ class: "wildly-invented" }), R1), true);
  assert.equal(detectionMatchesCase(det({ class: "wildly-invented", symbol: undefined }), R1), false);
  assert.equal(detectionMatchesCase(det({ path: "src/routes/admin.ts" }), R1), false);
});

test("a confirmed detection on a real case is surfaced; on a decoy it is a false report", () => {
  const score = scoreRun({
    tree: "vulnerable",
    cases: CASES,
    detections: [det(), det({ path: "src/routes/admin.ts", class: "missing-authz", symbol: "adminRouter" })],
  });
  assert.deepEqual(
    score.cases.map((c) => [c.caseId, c.outcome]),
    [
      ["R1", "surfaced"],
      ["D1", "surfaced"],
    ]
  );
  const h = headline(score, CASES);
  assert.equal(h.realSurfaced, 1);
  assert.equal(h.decoysSurfaced, 1);
  assert.equal(h.noise, 0);
});

test("held-back detections are scored by how they were held, and the best one wins", () => {
  const refuted = scoreRun({ tree: "fixed", cases: [R1], detections: [det({ verification: "refuted" })] });
  assert.equal(refuted.cases[0].outcome, "refuted");

  const held = scoreRun({
    tree: "fixed",
    cases: [R1],
    detections: [det({ verification: "unverifiable", holdReason: "evidence_not_in_file" })],
  });
  assert.equal(held.cases[0].outcome, "evidence_not_in_file");

  const mixed = scoreRun({
    tree: "vulnerable",
    cases: [R1],
    detections: [det({ verification: "refuted" }), det({ verification: "confirmed" })],
  });
  assert.equal(mixed.cases[0].outcome, "surfaced");
});

test("a failed scan is reported as unknown, never as a clean file", () => {
  const score = scoreRun({ tree: "vulnerable", cases: [R1], detections: [], scanFailedPaths: [R1.path] });
  assert.equal(score.cases[0].outcome, "scan_failed");
  assert.equal(headline(score, [R1]).scanFailed, 1);

  const clean = scoreRun({ tree: "vulnerable", cases: [R1], detections: [] });
  assert.equal(clean.cases[0].outcome, "not_detected");
});

test("detections matching no case are counted as noise", () => {
  const score = scoreRun({
    tree: "vulnerable",
    cases: CASES,
    detections: [det({ path: "src/lib/money.ts", class: "weak-crypto", symbol: "formatCents" })],
  });
  assert.equal(score.noise.length, 1);
  assert.equal(score.cases.every((c) => c.outcome === "not_detected"), true);
});

test("rates report how often each case surfaced across runs", () => {
  const surfaced = scoreRun({ tree: "vulnerable", cases: [R1], detections: [det()] });
  const missed = scoreRun({ tree: "vulnerable", cases: [R1], detections: [] });
  assert.deepEqual(rates([surfaced, missed, surfaced]), [{ caseId: "R1", runs: 3, surfaced: 2, rate: 2 / 3 }]);
});

test("the local index records relative specifiers as written and exported names", () => {
  const content = [
    'import { Router } from "express";',
    'import { findInvoice } from "../db/invoices.js";',
    'const lazy = await import("./late.js");',
    "export function invoicesRouter() {}",
    "export const LIMIT = 5;",
    "export { helper as publicHelper };",
  ].join("\n");
  assert.deepEqual(parseRelativeImports(content), ["../db/invoices.js", "./late.js"]);
  assert.deepEqual(parseExports(content).sort(), ["LIMIT", "invoicesRouter", "publicHelper"]);
});

test("buildLocalIndex keeps tree-relative paths, hashes content and derives static flags", async () => {
  const rows = await buildLocalIndex("bench", [
    { path: "src/routes/search.ts", content: 'const sql = `select * from t where a = ${req.query.q}`;' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "src/routes/search.ts");
  assert.equal(rows[0].language, "typescript");
  assert.match(rows[0].sha, /^[0-9a-f]{40}$/);
  assert.ok((rows[0].staticFlags ?? []).length > 0, "expected static flags from the file's own bytes");
  assert.deepEqual(rows[0].securityFlags, []);
});

test("buildLocalIndex takes imports, exports and flags from a summariser when given one", async () => {
  const rows = await buildLocalIndex(
    "bench",
    [{ path: "src/app.ts", content: "export const x = 1;" }],
    async () => ({ summary: "wires the app", exports: ["createApp"], imports: ["./routes/a.js"], securityFlags: ["handles-auth"] })
  );
  assert.equal(rows[0].summary, "wires the app");
  assert.deepEqual(rows[0].exports, ["createApp"]);
  assert.deepEqual(rows[0].imports, ["./routes/a.js"]);
  assert.deepEqual(rows[0].securityFlags, ["handles-auth"]);
});
