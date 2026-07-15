// Parse the bounty command a sponsor comments on a GitHub issue / Linear ticket:
//   "bounty $100 2 days"   →  { amountUsdc: 100, deliveryDays: 2 }
// The amount may omit the "$" and carry up to 7 decimals; the duration accepts
// "2 days", "2 day", or "2d". Anything that doesn't match returns null (so a
// comment like "I'll bounty this later" is ignored). Mirrors the exact-match
// discipline of review/eligibility.ts:isReviewTriggerComment.

export type BountyCommand = { amountUsdc: number; deliveryDays: number };

// keyword · optional "$" · amount · duration (N days | N day | Nd)
const BOUNTY_CMD = /\bbounty\b\s+\$?\s*(\d+(?:\.\d{1,7})?)\s+(\d+)\s*(?:days?|d)\b/i;

const MAX_DELIVERY_DAYS = 365;

export function parseBountyCommand(body: string): BountyCommand | null {
  const s = (body || "").trim();
  if (!s) return null;
  const m = s.match(BOUNTY_CMD);
  if (!m) return null;
  const amountUsdc = Number(m[1]);
  const deliveryDays = Number(m[2]);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;
  if (!Number.isInteger(deliveryDays) || deliveryDays <= 0 || deliveryDays > MAX_DELIVERY_DAYS) {
    return null;
  }
  return { amountUsdc, deliveryDays };
}

/** Cheap pre-check so callers can skip work on comments with no keyword. */
export function looksLikeBountyCommand(body: string): boolean {
  return /\bbounty\b/i.test(body || "");
}
