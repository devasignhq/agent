// Pure validation for the sponsor-editable acceptance list. No I/O — the route
// layer owns auth, the lock check and the write, so all of this unit-tests
// offline (house style, same shape as submission.ts).
//
// This list is the contract a contributor is paid against, so the rules lean
// strict: reject rather than truncate. Silently dropping the last two criteria
// of an agreement someone is about to escrow money on is worse than a 400.

// Above the prompt's "never exceed 8" (see criteriaSynthesisSystemPrompt's
// bounty block) so a sponsor who wants to add a couple of their own has room.
export const MAX_CRITERIA = 12;
// ~2 lines: long enough to be precise, short enough to stay checkable at a
// glance in a GitHub comment and in the contributor app's list.
export const MAX_CRITERION_CHARS = 300;

export type AcceptanceValidation =
  | { ok: true; acceptance: string[] }
  | { ok: false; error: "not_an_array" | "too_many" | "too_long"; index?: number };

/**
 * Normalize and check a client-supplied acceptance list.
 *
 * Normalization is liberal (non-string entries and blanks are dropped, not
 * rejected) but the size limits are strict, and they apply to the list AFTER
 * normalization so a payload padded with blanks can't trip `too_many`.
 *
 * An EMPTY array is valid: it is what every bounty carries today, and a
 * minimum would let a drafting failure block funding.
 */
export function validateAcceptance(input: unknown): AcceptanceValidation {
  if (!Array.isArray(input)) return { ok: false, error: "not_an_array" };

  const acceptance: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    // Collapse ALL whitespace, not just trim: a criterion renders into both a
    // markdown bullet in the bot comment and an <li> in two apps, and an
    // embedded newline breaks the list in the former.
    const text = entry.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // dedupe case-insensitively, keep first casing
    seen.add(key);
    acceptance.push(text);
  }

  if (acceptance.length > MAX_CRITERIA) return { ok: false, error: "too_many" };
  const overLong = acceptance.findIndex((c) => c.length > MAX_CRITERION_CHARS);
  if (overLong !== -1) return { ok: false, error: "too_long", index: overLong };

  return { ok: true, acceptance };
}
