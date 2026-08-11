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
  assert.equal(parseBountyCommand("bounty 2 days"), null); // window claims the only number, leaving no amount
  assert.equal(parseBountyCommand("bounty $0 3 days"), null); // zero amount
  assert.equal(parseBountyCommand("bounty $100 0 days"), null); // zero duration
  assert.equal(parseBountyCommand("bounty $100 9999 days"), null); // absurd duration
  assert.equal(parseBountyCommand("bounty $100 60 weeks"), null); // 420 days > cap
  assert.equal(parseBountyCommand(""), null);
});

// --- Typo / spacing / phrasing tolerance -------------------------------------

test("the user's headline case parses", () => {
  // "Bounties 100 USDC 2 dys" should read as bounty $100, 2 days.
  assert.deepEqual(parseBountyCommand("Bounties 100 USDC 2 dys"), { amountUsdc: 100, deliveryDays: 2 });
});

test("tolerates amount spacing and currency words in any position", () => {
  const want = { amountUsdc: 100, deliveryDays: 2 };
  assert.deepEqual(parseBountyCommand("bounty $ 100 2 days"), want); // space after $
  assert.deepEqual(parseBountyCommand("bounty 100 USDC 2 days"), want); // USDC after amount
  assert.deepEqual(parseBountyCommand("bounty USDC 100 2 days"), want); // USDC before amount
  assert.deepEqual(parseBountyCommand("bounty 100 usd 2 days"), want); // usd
  assert.deepEqual(parseBountyCommand("bounty 100 dollars 2 days"), want); // dollars
  assert.deepEqual(parseBountyCommand("bounty 100USDC 2 days"), want); // no gap before USDC
  assert.deepEqual(parseBountyCommand("bounty $1,000 2 days"), { amountUsdc: 1000, deliveryDays: 2 }); // thousands comma
});

test("tolerates duration typos, abbreviations, and weeks", () => {
  assert.deepEqual(parseBountyCommand("bounty $100 2 dys"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty $100 2 dayss"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty $100 2d"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty $100 1 week"), { amountUsdc: 100, deliveryDays: 7 });
  assert.deepEqual(parseBountyCommand("bounty $100 2 weeks"), { amountUsdc: 100, deliveryDays: 14 });
  assert.deepEqual(parseBountyCommand("bounty $100 2 wks"), { amountUsdc: 100, deliveryDays: 14 });
});

test("tolerates keyword plurals and 1–2 letter typos", () => {
  const want = { amountUsdc: 100, deliveryDays: 2 };
  assert.deepEqual(parseBountyCommand("bounties $100 2 days"), want);
  assert.deepEqual(parseBountyCommand("bouny $100 2 days"), want);
  assert.deepEqual(parseBountyCommand("bunty $100 2 days"), want);
  assert.deepEqual(parseBountyCommand("boutny $100 2 days"), want);
});

test("tolerates connector words and amount/window order", () => {
  assert.deepEqual(parseBountyCommand("bounty $100 in 2 days"), { amountUsdc: 100, deliveryDays: 2 });
  assert.deepEqual(parseBountyCommand("bounty of $50 for 3 days"), { amountUsdc: 50, deliveryDays: 3 });
  assert.deepEqual(parseBountyCommand("bounty $50 within 1 week"), { amountUsdc: 50, deliveryDays: 7 });
  assert.deepEqual(parseBountyCommand("$100 bounty in 2 days"), { amountUsdc: 100, deliveryDays: 2 }); // amount first
});

test("keyword leniency does not fire on casual mentions or near-words", () => {
  // Needs BOTH a clear amount and a window — one alone is ignored.
  assert.equal(parseBountyCommand("we should bounty this someday"), null);
  assert.equal(parseBountyCommand("a bounty would be great, maybe 100 someday"), null); // amount, no window
  assert.equal(parseBountyCommand("bounty this in 3 days if you can"), null); // window, no amount
  // "county" is edit-distance 1 from "bounty" but must not trigger a bounty.
  assert.equal(parseBountyCommand("the county fair spent $100 over 2 days"), null);
  // "bout" is a real word and should not trigger a bounty.
  assert.equal(parseBountyCommand("I had a bout of flu, $100 for 2 days"), null);
  // PR/issue references should not be parsed as bare amounts.
  assert.equal(parseBountyCommand("bounty 2 days for PR-123"), null);
  assert.equal(parseBountyCommand("bounty 2 days in org/repo/123"), null);
});

test("looksLikeBountyCommand is a cheap keyword gate", () => {
  assert.equal(looksLikeBountyCommand("bounty $100 2 days"), true);
  assert.equal(looksLikeBountyCommand("nothing here"), false);
});

// NUM used to end in an unbounded [\d,]*, and AMOUNT_ANCHORED[1] puts it before a
// suffix that fails — so a long digit run made the engine rescan from every digit
// position. This exact body took 15,740ms; it now takes ~16ms. The 1s budget sits
// ~60x above the fixed cost and ~15x below the broken one, so it stays decisive
// without turning flaky on a loaded CI box. Node is single-threaded: those 15
// seconds were the whole API, and on Linear this parse runs before the authority
// check (bounties/webhooks.ts:217 vs :249).
test("a maximum-size comment parses in linear time", () => {
  const body = "bounty 2 days " + "1".repeat(64_980); // GitHub's ~65k comment ceiling
  const started = process.hrtime.bigint();
  const parsed = parseBountyCommand(body);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(parsed, "the command still parses");
  assert.ok(elapsedMs < 1000, `parsing took ${elapsedMs.toFixed(0)}ms — the scan is quadratic again`);
});

// The bound must not narrow what the parser accepts: the largest escrowable
// amount (MAX_BOUNTY_STROOPS in stellar/amount.ts) is 13 characters with commas.
test("the bounded number still covers the largest escrowable amount", () => {
  assert.deepEqual(parseBountyCommand("bounty 1,000,000,000 usdc 2 days"), {
    amountUsdc: 1_000_000_000,
    deliveryDays: 2,
  });
});
