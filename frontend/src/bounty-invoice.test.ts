// Unit tests for the invoice model (bounty-invoice.ts).
//
// The load-bearing ones are the wrapping rules: the column width is measured in
// characters because the page is monospaced, and a Stellar address is a single
// 56-character "word" that has to hard-split rather than overflow the page or
// silently vanish. The degraded path (a payout whose bounty is no longer in the
// list) matters too — a sponsor should still get a coherent document.
//   node --test src/bounty-invoice.test.ts
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoice, invoiceDate, usdc, wrapMono } from "./bounty-invoice.ts";

const ADDRESS = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4TPPZAKQGZ3S4EFVXJT"; // 56 chars

const txn = (over = {}) => ({
  id: "txn_9f3a2b7c1d5e",
  bountyId: "b1",
  githubLogin: "lenny_malcolm",
  kind: "payout" as const,
  signer: "admin" as const,
  status: "confirmed" as const,
  hash: "3ad9f0c1e2b4a576",
  amountStroops: "4500000000",
  dir: "out" as const,
  createdAt: Date.parse("2025-12-14T09:00:00Z"),
  confirmedAt: Date.parse("2025-12-15T10:00:00Z"),
  destAddress: ADDRESS,
  ...over,
});

const bounty = (over = {}) =>
  ({
    id: "b1",
    code: "DA-8842",
    repo: "base-finance/core",
    issueNumber: 8842,
    title: "Add anti-fingerprinting capabilities to avoid bot detection",
    assigneeGithubLogin: "lenny_malcolm",
    assigneeAddress: "GOTHERADDRESS",
    ...over,
  }) as any;

// ─── formatting ──────────────────────────────────────────────────────────────
test("usdc always shows two decimals", () => {
  assert.equal(usdc(450), "450.00 USDC");
  assert.equal(usdc(1234.5), "1,234.50 USDC");
  assert.equal(usdc(0), "0.00 USDC");
});

test("invoiceDate renders the design's day-month-year form in UTC", () => {
  assert.equal(invoiceDate(Date.parse("2025-12-15T10:00:00Z")), "15 December, 2025");
  // Just before midnight UTC must not roll into the next day for west-of-UTC hosts.
  assert.equal(invoiceDate(Date.parse("2025-01-01T23:59:00Z")), "1 January, 2025");
});

// ─── wrapping ────────────────────────────────────────────────────────────────
test("wrapMono breaks on words at the column width", () => {
  assert.deepEqual(
    wrapMono("Add anti-fingerprinting capabilities to avoid bot detection", 37, 2),
    ["Add anti-fingerprinting capabilities", "to avoid bot detection"],
  );
});

test("wrapMono hard-splits a word longer than the column", () => {
  const lines = wrapMono(ADDRESS, 37, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, 37);
  // Nothing may be dropped: a truncated payout address is a wrong document.
  assert.equal(lines.join(""), ADDRESS);
});

test("wrapMono ellipsises when content exceeds maxLines", () => {
  const lines = wrapMono("alpha bravo charlie delta echo foxtrot golf hotel", 12, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"), `expected an ellipsis, got ${lines[1]}`);
  for (const line of lines) assert.ok(line.length <= 12, `line too wide: ${line}`);
});

test("wrapMono handles empty and degenerate input", () => {
  assert.deepEqual(wrapMono("", 37, 2), []);
  assert.deepEqual(wrapMono("anything", 0, 2), []);
  assert.deepEqual(wrapMono("anything", 37, 0), []);
});

// ─── buildInvoice ────────────────────────────────────────────────────────────
test("buildInvoice fills the page from a payout and its bounty", () => {
  const data = buildInvoice({ txn: txn(), bounty: bounty() });
  assert.equal(data.invoiceNumber, "DA-8842");
  // Dated when the payout settled on-chain, not when it was submitted.
  assert.equal(data.date, "15 December, 2025");
  assert.equal(data.billToName, "@lenny_malcolm");
  assert.equal(data.billFrom, "base-finance");
  assert.equal(data.itemTitle, "Task Submission - Issue #8842");
  assert.equal(data.itemDescription, "Add anti-fingerprinting capabilities to avoid bot detection");
  assert.equal(data.amountUsdc, 450);
  assert.equal(data.paymentLine, "450.00 USDC paid from DevAsign Wallet");
});

test("buildInvoice bills the wallet the payout actually went to", () => {
  // destAddress is the signed-at-payout snapshot; the bounty's assigneeAddress
  // can since have been changed by the contributor.
  const data = buildInvoice({ txn: txn(), bounty: bounty() });
  assert.equal(data.walletAddress, ADDRESS);
});

test("buildInvoice falls back to the bounty's address when the snapshot is absent", () => {
  const data = buildInvoice({ txn: txn({ destAddress: null }), bounty: bounty() });
  assert.equal(data.walletAddress, "GOTHERADDRESS");
});

test("buildInvoice degrades when the bounty is missing", () => {
  const data = buildInvoice({ txn: txn(), bounty: null });
  assert.equal(data.invoiceNumber, "TXN_9F3A2B7C"); // short txn id stands in
  assert.equal(data.itemTitle, "Bounty payout");
  assert.equal(data.billFrom, "—");
  // Identity and amount come off the transaction, so they survive.
  assert.equal(data.billToName, "@lenny_malcolm");
  assert.equal(data.amountUsdc, 450);
});

test("buildInvoice puts the on-chain hash in Notes when there's no operator note", () => {
  assert.equal(buildInvoice({ txn: txn(), bounty: bounty() }).notes, "Stellar tx: 3ad9f0c1e2b4a576");
  assert.equal(buildInvoice({ txn: txn({ note: "Q4 milestone" }), bounty: bounty() }).notes, "Q4 milestone");
  assert.equal(buildInvoice({ txn: txn({ hash: null }), bounty: bounty() }).notes, "—");
});

test("buildInvoice states the exact amount rather than rounding it", () => {
  // The table rounds to whole dollars for density; an invoice must not.
  const data = buildInvoice({ txn: txn({ amountStroops: "4507500000" }), bounty: bounty() });
  assert.equal(data.amountUsdc, 450.75);
  assert.equal(usdc(data.amountUsdc), "450.75 USDC");
});
