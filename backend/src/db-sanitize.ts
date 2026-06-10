// Scrub values to their nearest Postgres-storable form on the way to `jsonb`.
//
// JavaScript strings can hold code units that Postgres `jsonb` (and `json`)
// reject outright, so the INSERT throws rather than storing the row:
//   - U+0000 (NUL)              -> ERROR: unsupported Unicode escape sequence
//                                 ("... cannot be converted to text")
//   - unpaired UTF-16 surrogate -> ERROR: invalid input syntax for type json
// Both routinely appear in the free-form text we persist - raw PR diffs, LLM
// verdict/rationale/evidence, and comment bodies. Because the write-through
// flushes the whole dataset in one transaction, a single offending byte used to
// roll back the batch and (with the old infinite re-stage retry) stall ALL
// persistence indefinitely while the in-memory snapshot drifted ahead of
// Postgres. Scrubbing here means a poison byte can never freeze the flush.
//
// Pure - no db / network - so it's unit-testable offline (mirrors the extracted
// decisions.ts / progress-comment.ts helpers). Works at the UTF-16 code-unit
// level (no regex with literal control chars) so this source stays plain ASCII.

const NUL = 0x0000;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
// U+FFFD REPLACEMENT CHARACTER (the standard substitute for malformed text).
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** Strip NULs and replace any unpaired surrogate with U+FFFD. */
export function sanitizeString(s: string): string {
  // Fast path: the overwhelming majority of strings are clean, so scan once and
  // return the original (no allocation) unless something actually needs fixing.
  let dirty = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === NUL || (c >= HIGH_SURROGATE_START && c <= LOW_SURROGATE_END)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return s;

  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === NUL) continue; // drop NULs
    if (c >= HIGH_SURROGATE_START && c <= HIGH_SURROGATE_END) {
      const next = s.charCodeAt(i + 1);
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) {
        out += s[i] + s[i + 1]; // valid pair (emoji, etc.) -> keep intact
        i++;
        continue;
      }
      out += REPLACEMENT_CHAR; // lone high surrogate
      continue;
    }
    if (c >= LOW_SURROGATE_START && c <= LOW_SURROGATE_END) {
      out += REPLACEMENT_CHAR; // lone low surrogate
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Deep-clean a value for `jsonb` storage. Recurses through arrays and plain
 * objects sanitizing every string; numbers/booleans/null/undefined pass
 * through. Returns the ORIGINAL reference when nothing needed changing, so the
 * common case (clean rows) allocates nothing - this runs per row on every flush.
 */
export function sanitizeForJsonb<T>(value: T): T {
  return clean(value) as T;
}

function clean(v: unknown): unknown {
  if (typeof v === "string") return sanitizeString(v);
  if (v === null || typeof v !== "object") return v;

  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const c = clean(item);
      if (c !== item) changed = true;
      return c;
    });
    return changed ? out : v;
  }

  // Non-plain objects (Date, etc.) have no enumerable own keys we'd rewrite, so
  // they round-trip unchanged. Our rows are plain JSON-shaped data regardless.
  const obj = v as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const c = clean(obj[k]);
    if (c !== obj[k]) changed = true;
    out[k] = c;
  }
  return changed ? out : v;
}

/**
 * Whether a failed write is the database REJECTING the data (a poison row that
 * retrying can never fix) versus a transient/connection problem (worth a retry).
 * Keys off the Postgres SQLSTATE class:
 *   - 22xxx - data exception (incl. 22P05 untranslatable character)
 *   - 23xxx - integrity constraint violation
 * Everything else (no code, connection resets, admin shutdown, ...) is treated
 * as transient. Lets the write-through quarantine poison rows instead of letting
 * one of them block the whole batch forever.
 */
export function isUnstorableDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
}
