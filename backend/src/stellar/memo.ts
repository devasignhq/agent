// Payout-memo validation (MEMO_TEXT semantics). A contributor may attach a memo
// to their payout wallet — typically an exchange deposit memo — and the memo
// rides the payout transaction envelope as MEMO_TEXT, whose hard protocol limit
// is 28 BYTES of UTF-8 (not 28 characters). Pure module so it unit-tests without
// the Stellar SDK.

export const MEMO_TEXT_MAX_BYTES = 28;

export type MemoCheck = { ok: true; memo: string } | { ok: false; reason: "too_long" };

/**
 * Normalize + validate a payout memo. Trims surrounding whitespace; an
 * empty/absent memo is valid and normalizes to "" (meaning "no memo").
 */
export function validateMemo(raw: unknown): MemoCheck {
  const memo = typeof raw === "string" ? raw.trim() : "";
  if (Buffer.byteLength(memo, "utf8") > MEMO_TEXT_MAX_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, memo };
}
