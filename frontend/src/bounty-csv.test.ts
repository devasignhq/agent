// Unit tests for the transaction CSV export (bounty-csv.ts).
//
// The load-bearing ones are about money. The on-screen table rounds to whole
// dollars, so the tests that pin cents (and the raw-stroops column that stays
// exact past double precision) are the reason this module exists at all. The
// other one to keep is "the amount column is never formula-guarded" — it's the
// regression test for someone later moving guardFormula into csvCell and quietly
// turning every negative amount into text.
//   node --test src/bounty-csv.test.ts
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EscrowTransaction } from "./api.ts";
import {
  TRANSACTION_HEADERS,
  csvCell,
  guardFormula,
  toCsv,
  transactionRows,
  transactionsCsv,
  transactionsCsvFilename,
} from "./bounty-csv.ts";

const ADDRESS = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4TPPZAKQGZ3S4EFVXJT";
const HASH = "3ad9f0c1e2b4a5763ad9f0c1e2b4a5763ad9f0c1e2b4a5763ad9f0c1e2b4a576";

const txn = (over = {}) =>
  ({
    id: "txn_9f3a2b7c1d5e",
    bountyId: "b1",
    githubLogin: "lenny_malcolm",
    kind: "payout",
    signer: "admin",
    status: "confirmed",
    hash: HASH,
    amountStroops: "4507500000", // 450.75 USDC
    dir: "out",
    createdAt: Date.parse("2025-12-14T09:00:00Z"),
    confirmedAt: Date.parse("2025-12-15T10:00:00Z"),
    destAddress: ADDRESS,
    ...over,
  }) as EscrowTransaction;

// Column indices, so a test reads as the column it's about.
const ID = 0, DATE = 1, CONFIRMED = 2, KIND = 3, DIR = 4, STATUS = 5;
const USDC = 6, STROOPS = 7, NOTE = 8, LOGIN = 9, HASH_COL = 10, BOUNTY = 11, DEST = 12;

const row = (over = {}) => transactionRows([txn(over)])[1];

// ─── escaping ────────────────────────────────────────────────────────────────
test("csvCell leaves an ordinary value bare", () => {
  assert.equal(csvCell("payout"), "payout");
  assert.equal(csvCell("450.75"), "450.75");
  assert.equal(csvCell(""), "");
});

test("csvCell quotes commas, quotes and line breaks", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("line1\r\nline2"), '"line1\r\nline2"');
});

test("csvCell quotes padded values so importers can't strip the padding", () => {
  assert.equal(csvCell(" leading"), '" leading"');
  assert.equal(csvCell("trailing "), '"trailing "');
});

test("a newline inside a note doesn't break the row structure", () => {
  const csv = transactionsCsv([txn({ note: "paid out\nsecond line" })]);
  // Rows are CRLF-terminated, so a bare LF inside a quoted field can't split one.
  assert.deepEqual(csv.split("\r\n").length, 3); // header, row, trailing empty
  assert.match(csv, /"paid out\nsecond line"/);
});

test("toCsv terminates every row with CRLF", () => {
  assert.equal(toCsv([["a", "b"], ["c", "d"]]), "a,b\r\nc,d\r\n");
});

// ─── money ───────────────────────────────────────────────────────────────────
test("cents survive — the table rounds to whole dollars, the export must not", () => {
  assert.equal(row({ dir: "out" })[USDC], "-450.75");
  assert.equal(row({ dir: "in" })[USDC], "450.75");
});

test("the amount carries no currency symbol and no thousands separator", () => {
  // A grouping comma would force quoting and defeat numeric import.
  assert.equal(row({ amountStroops: "123456789012345", dir: "in" })[USDC], "12345678.90");
});

test("outbound amounts are negative so the column sums to a net", () => {
  const rows = transactionRows([
    txn({ id: "a", dir: "in", amountStroops: "10000000000" }), // +1000
    txn({ id: "b", dir: "out", amountStroops: "4000000000" }), //  -400
  ]);
  const net = rows.slice(1).reduce((sum, r) => sum + Number(r[USDC]), 0);
  assert.equal(net, 600);
});

test("raw stroops stay exact past double precision", () => {
  // Number(s)/1e7 is lossy above 2^53 stroops; the stroops column is the record
  // that stays true, which is the whole reason it's exported.
  const r = row({ amountStroops: "90071992547409910", dir: "in" });
  assert.equal(r[STROOPS], "90071992547409910");
  assert.equal(r[USDC], "9007199254.74"); // the lossy view, for reference
});

test("a sub-cent amount rounds to 0.00 but keeps its exact stroops", () => {
  const r = row({ amountStroops: "1", dir: "out" });
  assert.equal(r[USDC], "-0.00");
  assert.equal(r[STROOPS], "1");
});

// ─── formula injection ───────────────────────────────────────────────────────
test("guardFormula neuters every spreadsheet trigger character", () => {
  assert.equal(guardFormula('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
  assert.equal(guardFormula("@everyone"), "'@everyone");
  assert.equal(guardFormula("+1+1"), "'+1+1");
  assert.equal(guardFormula("-1+1"), "'-1+1");
  assert.equal(guardFormula("payout"), "payout");
});

test("a note that looks like a formula is neutered", () => {
  assert.equal(row({ note: '=HYPERLINK("http://x")' })[NOTE], '\'=HYPERLINK("http://x")');
});

test("the amount column is NEVER formula-guarded", () => {
  // If guardFormula ever migrates into csvCell, every negative amount becomes
  // "'-450.75" — text, not a number — and the export stops being an export.
  assert.equal(row({ dir: "out" })[USDC], "-450.75");
  assert.equal(row({ dir: "out" })[USDC].startsWith("'"), false);
});

// ─── shape ───────────────────────────────────────────────────────────────────
test("the header row is the documented 13 columns in order", () => {
  assert.equal(TRANSACTION_HEADERS.length, 13);
  assert.deepEqual(transactionRows([])[0], TRANSACTION_HEADERS);
  assert.deepEqual(TRANSACTION_HEADERS.slice(0, 3), ["Transaction ID", "Date (UTC)", "Confirmed (UTC)"]);
  assert.deepEqual(TRANSACTION_HEADERS.slice(6, 8), ["Amount (USDC)", "Amount (stroops)"]);
});

test("an empty history exports headers only, and never throws", () => {
  assert.equal(transactionsCsv([]), TRANSACTION_HEADERS.join(",") + "\r\n");
});

test("ids and hashes are exported in full, not truncated for display", () => {
  const r = row();
  assert.equal(r[ID], "txn_9f3a2b7c1d5e"); // not id.slice(0, 10)
  assert.equal(r[HASH_COL], HASH); // not shortHash()
});

test("kind, direction, bounty id and destination are carried through", () => {
  const r = row();
  assert.equal(r[KIND], "payout");
  assert.equal(r[DIR], "out");
  assert.equal(r[BOUNTY], "b1");
  assert.equal(r[DEST], ADDRESS);
  assert.equal(r[LOGIN], "lenny_malcolm");
});

test("status uses the dashboard's vocabulary, not the wire value", () => {
  assert.equal(row({ status: "confirmed" })[STATUS], "COMPLETED");
  assert.equal(row({ status: "pending" })[STATUS], "PENDING");
  assert.equal(row({ status: "failed" })[STATUS], "FAILED");
});

test("the note falls back exactly as the table's row does", () => {
  assert.equal(row({ note: "Bounty DA-8842 payout" })[NOTE], "Bounty DA-8842 payout");
  assert.equal(row({ note: undefined })[NOTE], "payout · @lenny_malcolm");
  assert.equal(row({ note: undefined, githubLogin: null })[NOTE], "payout");
});

test("dates are UTC-stable and never render null/undefined", () => {
  // Just before midnight UTC must not roll a day on a west-of-UTC host.
  assert.equal(row({ createdAt: Date.parse("2025-01-01T23:59:00Z") })[DATE], "2025-01-01");
  assert.equal(row({ confirmedAt: null })[CONFIRMED], "");
});

test("missing optional fields degrade to empty cells", () => {
  const csv = transactionsCsv([
    txn({
      note: undefined,
      hash: null,
      bountyId: null,
      githubLogin: null,
      confirmedAt: null,
      destAddress: null,
    }),
  ]);
  assert.equal(csv.includes("undefined"), false);
  assert.equal(csv.includes("null"), false);
});

// ─── filename ────────────────────────────────────────────────────────────────
test("the filename is date-stamped in UTC", () => {
  assert.equal(
    transactionsCsvFilename(Date.parse("2025-12-15T10:00:00Z")),
    "devasign-transactions-2025-12-15.csv"
  );
  // Same midnight boundary as the Date column, so the two can't disagree.
  assert.equal(
    transactionsCsvFilename(Date.parse("2025-01-01T23:59:00Z")),
    "devasign-transactions-2025-01-01.csv"
  );
});
