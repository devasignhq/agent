// Parse the bounty command a sponsor comments on a GitHub issue / Linear ticket:
//   "bounty $100 2 days"  →  { amountUsdc: 100, deliveryDays: 2 }
//
// Sponsors type this by hand, so the parser reads intent rather than insisting on
// one exact form — it forgives the typos and spacings people actually use. All of
// these resolve to { amountUsdc: 100, deliveryDays: 2 }:
//   "bounty $100 2 days"        "Bounties 100 USDC 2 dys"     "bouny $ 100 in 2 days"
//   "$100 bounty for 2 days"    "bounty 100 dollars 2d"       "bunty $100 2 days"
//
// The leniency is safe: only an authorized sponsor can trigger it — a repo owner,
// member or collaborator on GitHub (webhooks.ts:MAINTAINER_ASSOCIATIONS), a
// workspace admin or the connector on Linear
// (webhooks.ts:authorizeLinearBountyAuthor) — and the amount/window it reads are shown
// back in the Fund/Cancel confirm comment (botcomment.ts:renderConfirmBody) before
// a cent of USDC is escrowed — so a misread is one maintainer edit away, never a
// lost payment.
//
// What it tolerates:
//   • keyword — plural/stem and 1–2 letter slips ("bounties", "bouny", "bunty", "boutny")
//   • amount  — "$100", "$ 100", "100 USDC", "USDC 100", "100 dollars", "$1,000"
//   • window  — "2 days", "2 day", "2d", "2 dys", "2 weeks", "2 wks" (weeks count ×7)
//   • filler  — connector words between the pieces ("in", "for", "within")
// Word order is flexible; anything without a clear amount AND window returns null,
// so casual mentions ("we should bounty this someday") stay ignored.

import { isValidBountyAmount, usdcToStroops } from "../stellar/amount.js";

export type BountyCommand = { amountUsdc: number; deliveryDays: number };

const MAX_DELIVERY_DAYS = 365;

// A number with optional thousands commas and up to USDC's 7 decimals.
//
// The {0,29} bound is load-bearing, not cosmetic. AMOUNT_ANCHORED[1] puts NUM in
// front of a suffix that usually fails, so an unbounded [\d,]* made the engine
// walk to the end of the body and back at every digit position — quadratic. A
// 65k-char comment (GitHub's ceiling) blocked the event loop for ~16 seconds;
// bounded, the per-position work is constant and the whole scan is linear.
// 30 characters is far above any real amount: the most this system will escrow
// is 1,000,000,000 USDC (MAX_BOUNTY_STROOPS in stellar/amount.ts) — 13 with commas.
//
// (?![\d,]) stops the bound truncating a run at its HEAD: without it, a 65k-digit
// run matched its first 30 digits and read as 1.1e29. It costs at most 30 attempts
// per position, sits before the decimal group, and "." isn't in [\d,] — so "12.50"
// and "1,000" still parse.
//
// It does NOT make an over-long run unmatchable, and don't let this comment imply
// otherwise. A match can still begin INSIDE a run and take its last ≤30 characters:
// AMOUNT_ANCHORED[1] has no leading lookbehind at all, and AMOUNT_BARE's omits ","
// so any position after a comma is a legal start. What actually keeps a truncated
// run from parsing is the amount range check in parseBountyCommand — meaning is
// enforced there, deliberately, not in this regex. Tightening NUM with a leading
// (?<![\d,.]) would close those two holes but also stop "bounty,100 usdc 2 days"
// parsing, which is why it isn't here.
const NUM = String.raw`\d[\d,]{0,29}(?![\d,])(?:\.\d{1,7})?`;

// "<n> <word>" pairs (e.g. "2 days", "3d"); the word is classified as a time unit
// afterwards. The lookbehind stops us latching onto the fractional tail of a
// decimal — the "50" in "$12.50" must not read as a duration.
const DURATION_SCAN = new RegExp(String.raw`(?<![\d.])(\d+)\s*([a-z]+)`, "gi");

// Amount, most-specific anchor first; the bare-number fallback only runs when no
// currency marker ($ / USDC / USD / dollars) is present in the leftover text.
const AMOUNT_ANCHORED: RegExp[] = [
  new RegExp(String.raw`\$\s*(${NUM})`, "i"), // $100, $ 100, $1,000
  new RegExp(String.raw`(${NUM})\s*(?:usdc|usd|dollars?|bucks?)`, "i"), // 100 USDC, 100 dollars
  new RegExp(String.raw`(?:usdc|usd)\s*(${NUM})`, "i"), // USDC 100
];
const AMOUNT_BARE = new RegExp(String.raw`(?<![\d.$#\-/])(${NUM})`, "i");

// Standard Levenshtein edit distance. Only ever run on short tokens (a candidate
// keyword or a unit word), so the DP is trivially cheap.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Does a word read as the "bounty" keyword? Accepts the plural/stem directly and
// allows 1–2 letter slips, but requires a leading "b" so a near-word like
// "county" (edit distance 1) doesn't trip it.
function isBountyWord(token: string): boolean {
  if (token.startsWith("bount")) return true; // bounty, bounties, bounti, bount…
  return (
    token.length >= 5 &&
    token.length <= 8 &&
    token[0] === "b" &&
    levenshtein(token, "bounty") <= 2 // bouny, bunty, bonty, boutny…
  );
}

// Days per unit for a (possibly abbreviated or misspelled) time-unit word, else null.
function unitToDays(word: string): number | null {
  if (word === "d" || word === "dy" || word === "dys") return 1;
  if (word[0] === "d" && (levenshtein(word, "day") <= 1 || levenshtein(word, "days") <= 1)) return 1;
  if (word === "w" || word === "wk" || word === "wks") return 7;
  if (word[0] === "w" && (levenshtein(word, "week") <= 1 || levenshtein(word, "weeks") <= 1)) return 7;
  return null;
}

function hasBountyKeyword(s: string): boolean {
  for (const tok of s.match(/[a-z]+/g) ?? []) {
    if (isBountyWord(tok)) return true;
  }
  return false;
}

// The first "<n> <unit>" whose unit reads as a day/week window, with the span it
// occupies (so the caller can lift it out before reading the amount).
function findDuration(s: string): { days: number; start: number; end: number } | null {
  for (const m of s.matchAll(DURATION_SCAN)) {
    const perUnit = unitToDays(m[2]);
    if (perUnit == null) continue;
    const n = Number(m[1]);
    if (!Number.isInteger(n)) continue;
    const start = m.index ?? 0;
    return { days: n * perUnit, start, end: start + m[0].length };
  }
  return null;
}

function toAmount(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function findAmount(s: string): number | null {
  for (const re of AMOUNT_ANCHORED) {
    const m = s.match(re);
    if (m) return toAmount(m[1]);
  }
  const bare = s.match(AMOUNT_BARE);
  return bare ? toAmount(bare[1]) : null;
}

export function parseBountyCommand(body: string): BountyCommand | null {
  const s = (body || "").trim().toLowerCase();
  if (!s || !hasBountyKeyword(s)) return null;

  // The window is anchored by its unit word, so read it first and lift it out —
  // then whatever number is left is unambiguously the amount. This is what lets
  // "bounty 100 2 days" split into $100 / 2 days without guessing which is which.
  const dur = findDuration(s);
  if (!dur) return null;
  const deliveryDays = dur.days;
  if (!Number.isInteger(deliveryDays) || deliveryDays <= 0 || deliveryDays > MAX_DELIVERY_DAYS) {
    return null;
  }

  const amountUsdc = findAmount(s.slice(0, dur.start) + " " + s.slice(dur.end));
  if (amountUsdc == null || !Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;

  // An amount the escrow cannot hold was never a bounty command — the counterpart
  // to the MAX_DELIVERY_DAYS check above. This, not the regex, is what keeps a
  // truncated digit run from parsing (see NUM): a match that starts inside a long
  // run reads an absurd tail, and it gets rejected here whichever regex found it.
  // Deciding it in the parser also keeps a junk comment ignorable instead of
  // letting createBounty throw on the webhook thread — maybeHandleBountyComment is
  // called unguarded from github/webhooks.ts:182.
  let stroops: bigint;
  try {
    stroops = usdcToStroops(amountUsdc);
  } catch {
    return null; // not representable as USDC (a truncated run lands in exponent form)
  }
  if (!isValidBountyAmount(stroops)) return null;

  return { amountUsdc, deliveryDays };
}

/** Cheap pre-check so callers can skip work on comments with no bounty keyword. */
export function looksLikeBountyCommand(body: string): boolean {
  return hasBountyKeyword((body || "").toLowerCase());
}
