// The bounty-command parser. Run: node --import tsx/esm --test src/bounties/parse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBountyCommand, looksLikeBountyCommand } from "./parse.js";

test("parses the canonical forms", () => {
  assert.deepEqual(parseBountyCommand("bounty $100 2 days"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty $100 2 day"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty $100 3d"), { amountUsdc: 100, deliveryDays: 3 });
  assert.deepEqual(parseBountyCommand("bounty 50 7 days"), { amountUsdc: 50, deliveryDays: 7 });
  assert.deepEqual(parseBountyCommand("bounty $12.50 1 day"), { amountUsdc: 12.5, deliveryDays: 1 });
});

test("tolerates surrounding text, case, and whitespace", () => {
  assert.deepEqual(parseBountyCommand("  BOUNTY  $100   2   days  please  "), {
    amountUsdc: 100,
    deliveryDays: 2,
  });
  assert.deepEqual(parseBountyCommand("Let's do: bounty $80 5 days 🙏"), {
    amountUsdc: 80,
    deliveryDays: 5,
  });
});

test("returns null for non-commands and bad values", () => {
  assert.equal(parseBountyCommand("I'll add a bounty later"), null);
  assert.equal(parseBountyCommand("bounty $100"), null); // no duration
  assert.equal(parseBountyCommand("bounty 2 days"), null); // no amount (2 read as amount, "days" not a duration)
  assert.equal(parseBountyCommand("bounty $0 3 days"), null); // zero amount
  assert.equal(parseBountyCommand("bounty $100 0 days"), null); // zero duration
  assert.equal(parseBountyCommand("bounty $100 9999 days"), null); // absurd duration
  assert.equal(parseBountyCommand(""), null);
});

test("looksLikeBountyCommand is a cheap keyword gate", () => {
  assert.equal(looksLikeBountyCommand("bounty $100 2 days"), true);
  assert.equal(looksLikeBountyCommand("nothing here"), false);
});
