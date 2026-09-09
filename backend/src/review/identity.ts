// When are two findings the same finding?
//
// A finding's identity used to be a hash of the model's wording. The wording is
// the one thing about a finding that is NOT stable: re-run the review and the
// same bug comes back phrased differently, and two stages that spot the same
// bug phrase it differently from each other. Observed live (verify-demo#5): a
// deferral re-described on the next push was announced as fixed and reopened as
// a new thread, and one rethrow on line 45 produced three threads.
//
// So identity is a match, not a hash. Two findings are the same when they sit in
// the same file, within a few lines of each other, and share evidence that
// survives rewording: a long quoted span (the TODO text, a log message), the
// suggested change's original code, the defect class, or enough of the same
// vocabulary. Pure — no db / network / LLM:
//   node --import tsx/esm --test src/review/identity.test.ts
import { normalizeSlug } from "../security/fingerprint.js";

// How far apart two lines may be and still be "the same place". Covers the
// model citing the opening vs closing line of a block, and a later push
// inserting a handful of lines above a finding.
export const LINE_WINDOW = 8;
// Overlap coefficient of concern vocabulary needed when the lines are near.
export const NEAR_OVERLAP = 0.4;
// ...and when one side has no line at all: the wording must nearly coincide.
export const FAR_OVERLAP = 0.7;
// A quoted span shorter than this (normalized) is an identifier, not evidence:
// `listHandler` appears in every finding about the file.
export const MIN_SPAN = 16;

export type FindingIdentity = {
  path?: string;
  line?: number;
  concern: string;
  // suggestedChange.original — the code the reviewer wants replaced.
  original?: string;
  defectClass?: string;
};

const STOP = new Set(
  "the a an and or of to in on is it its this that these those for with as by be are was were not no so at from into then than but if which when now still also has have had does did can could would should may might will just very only into out over under".split(" ")
);

export function conceptTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

// Spans the model quoted verbatim, in either quote style — a TODO comment, a
// log message, an error string. Normalized so punctuation and case drift can't
// split them; short ones dropped so a bare identifier never counts.
export function quotedSpans(text: string): Set<string> {
  const out = new Set<string>();
  // A single quote counts only when it isn't an apostrophe: "description's …
  // ticket's" would otherwise read as one span and swallow the double-quoted
  // TODO sitting between them.
  for (const m of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|(?<![A-Za-z])'([^'\n]{2,})'(?![A-Za-z])/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    const norm = normalizeSlug(raw);
    if (norm.length >= MIN_SPAN) out.add(norm);
  }
  return out;
}

/** Overlap coefficient: shared vocabulary relative to the smaller concern. */
export function similarity(a: string, b: string): number {
  const ta = conceptTokens(a);
  const tb = conceptTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

function sharesSpan(a: string, b: string): boolean {
  const sa = quotedSpans(a);
  if (!sa.size) return false;
  for (const s of quotedSpans(b)) if (sa.has(s)) return true;
  return false;
}

export function sameFinding(a: FindingIdentity, b: FindingIdentity): boolean {
  if ((a.path ?? "") !== (b.path ?? "")) return false;
  // null = can't tell (a side has no line); false = definitely elsewhere.
  const near =
    a.line == null || b.line == null ? null : Math.abs(a.line - b.line) <= LINE_WINDOW;
  if (near === false) return false;

  if (a.original && b.original && normalizeSlug(a.original) === normalizeSlug(b.original)) {
    return true;
  }
  if (sharesSpan(a.concern, b.concern)) return true;

  const overlap = similarity(a.concern, b.concern);
  if (near && a.defectClass && a.defectClass === b.defectClass && overlap >= 0.25) return true;
  return near ? overlap >= NEAR_OVERLAP : overlap >= FAR_OVERLAP;
}

/** Best match for `target` among `candidates`, by shared vocabulary; null if none qualifies. */
export function bestMatch<T>(
  target: FindingIdentity,
  candidates: T[],
  identityOf: (c: T) => FindingIdentity
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const id = identityOf(c);
    if (!sameFinding(target, id)) continue;
    const score =
      similarity(target.concern, id.concern) -
      (target.line != null && id.line != null ? Math.abs(target.line - id.line) / 100 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
