// USDC amount arithmetic. USDC on Stellar has 7 decimals, so on-chain amounts are
// i128 "stroops" where 1 USDC = 10^7 stroops. All conversions use BigInt only —
// never float — so amounts round-trip exactly. The escrow contract enforces a
// min of 0.01 USDC and a max of 1,000,000,000 USDC; we mirror those bounds here
// so the API rejects bad amounts before building a transaction that would revert.

export const USDC_DECIMALS = 7;
export const STROOPS_PER_USDC = 10_000_000n; // 10^7
export const MIN_BOUNTY_STROOPS = 100_000n; // 0.01 USDC
export const MAX_BOUNTY_STROOPS = 10_000_000_000_000_000n; // 1e16 = 1,000,000,000 USDC

/**
 * Convert a decimal USDC amount to i128 stroops (BigInt). Accepts a number (e.g.
 * `100` from a `bounty $100` command) or a decimal string (e.g. `"100.50"`).
 * Throws on a malformed amount or more than 7 decimal places.
 */
export function usdcToStroops(usdc: number | string): bigint {
  let s: string;
  if (typeof usdc === "number") {
    if (!Number.isFinite(usdc) || usdc < 0) throw new Error(`invalid USDC amount: ${usdc}`);
    // toFixed(7) avoids scientific notation and caps at the supported precision.
    s = usdc.toFixed(USDC_DECIMALS);
  } else {
    s = usdc.trim();
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid USDC amount: ${usdc}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC supports at most ${USDC_DECIMALS} decimals: ${usdc}`);
  }
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * STROOPS_PER_USDC + BigInt(fracPadded || "0");
}

/** Precise decimal-string rendering of a stroop amount, trailing zeros trimmed. */
export function stroopsToUsdcString(stroops: bigint | string): string {
  const v = typeof stroops === "bigint" ? stroops : BigInt(stroops);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const s = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${s}` : s;
}

/** Convenience number for display/UI (safe for realistic bounty magnitudes). */
export function stroopsToUsdcNumber(stroops: bigint | string): number {
  return Number(stroopsToUsdcString(stroops));
}

export function isValidBountyAmount(stroops: bigint): boolean {
  return stroops >= MIN_BOUNTY_STROOPS && stroops <= MAX_BOUNTY_STROOPS;
}

/** Throw unless `stroops` is within the contract's accepted [min, max] range. */
export function assertBountyAmount(stroops: bigint): void {
  if (stroops < MIN_BOUNTY_STROOPS) {
    throw new Error(`bounty amount below the ${stroopsToUsdcString(MIN_BOUNTY_STROOPS)} USDC minimum`);
  }
  if (stroops > MAX_BOUNTY_STROOPS) {
    throw new Error(`bounty amount above the ${stroopsToUsdcString(MAX_BOUNTY_STROOPS)} USDC maximum`);
  }
}
