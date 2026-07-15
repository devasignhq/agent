// USDC ⇄ stroops conversion is BigInt-exact and the contract's min/max bounds are
// enforced. Run: node --import tsx/esm --test src/stellar/amount.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usdcToStroops,
  stroopsToUsdcString,
  stroopsToUsdcNumber,
  assertBountyAmount,
  isValidBountyAmount,
  MIN_BOUNTY_STROOPS,
  MAX_BOUNTY_STROOPS,
  STROOPS_PER_USDC,
} from "./amount.js";

test("usdcToStroops: whole and decimal amounts", () => {
  assert.equal(usdcToStroops(100), 1_000_000_000n); // 100 * 1e7
  assert.equal(usdcToStroops(1), STROOPS_PER_USDC);
  assert.equal(usdcToStroops("0.01"), 100_000n);
  assert.equal(usdcToStroops("100.50"), 1_005_000_000n);
  assert.equal(usdcToStroops("0.0000001"), 1n); // 7th decimal = 1 stroop
});

test("usdcToStroops: rejects malformed / over-precise amounts", () => {
  assert.throws(() => usdcToStroops("abc"));
  assert.throws(() => usdcToStroops("1.23456789")); // 8 decimals
  assert.throws(() => usdcToStroops(-5));
  assert.throws(() => usdcToStroops(Number.NaN));
});

test("stroops → USDC string trims trailing zeros", () => {
  assert.equal(stroopsToUsdcString(1_000_000_000n), "100");
  assert.equal(stroopsToUsdcString(100_000n), "0.01");
  assert.equal(stroopsToUsdcString(1_005_000_000n), "100.5");
  assert.equal(stroopsToUsdcString(0n), "0");
  assert.equal(stroopsToUsdcNumber(1_005_000_000n), 100.5);
});

test("round-trips exactly for a spread of amounts (already-normalized inputs)", () => {
  for (const a of ["0.01", "1", "42", "100", "100.5", "999999", "0.1234567"]) {
    assert.equal(stroopsToUsdcString(usdcToStroops(a)), a);
  }
});

test("bounty amount bounds", () => {
  assert.equal(isValidBountyAmount(MIN_BOUNTY_STROOPS), true);
  assert.equal(isValidBountyAmount(MAX_BOUNTY_STROOPS), true);
  assert.equal(isValidBountyAmount(MIN_BOUNTY_STROOPS - 1n), false);
  assert.equal(isValidBountyAmount(MAX_BOUNTY_STROOPS + 1n), false);
  assert.throws(() => assertBountyAmount(0n));
  assert.throws(() => assertBountyAmount(MAX_BOUNTY_STROOPS + 1n));
  assert.doesNotThrow(() => assertBountyAmount(usdcToStroops(100)));
});
