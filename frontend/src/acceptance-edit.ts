// Row operations for the acceptance-criteria editor on the funding page.
// Pure, so they unit-test without a DOM (the frontend test runner globs only
// src/**/*.test.ts — .tsx is never picked up, so any logic worth testing has to
// live in a .ts module).
//
// Every operation returns a NEW array: the editor renders from React state and
// mutating in place would skip the re-render.
//
// Order is load-bearing downstream — the backend seeds review criteria from
// this list positionally as `bounty-1..N` — so moveRow is a real operation, not
// a cosmetic one.

/** Mirrors backend MAX_CRITERIA (bounties/acceptance.ts); the API rejects more. */
export const MAX_CRITERIA = 12;
/** Mirrors backend MAX_CRITERION_CHARS. */
export const MAX_CRITERION_CHARS = 300;

export function addRow(rows: string[]): string[] {
  if (rows.length >= MAX_CRITERIA) return rows;
  return [...rows, ""];
}

export function removeRow(rows: string[], index: number): string[] {
  if (index < 0 || index >= rows.length) return rows;
  return rows.filter((_, i) => i !== index);
}

export function editRow(rows: string[], index: number, text: string): string[] {
  if (index < 0 || index >= rows.length) return rows;
  const next = [...rows];
  next[index] = text;
  return next;
}

/** Move a row one slot up or down. A no-op at the boundaries. */
export function moveRow(rows: string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * What actually gets sent. Mirrors the backend's validateAcceptance
 * normalization so the sponsor sees the same list the server will store —
 * blank rows the editor allows while typing are dropped here, not rejected.
 */
export function normalizeForSave(rows: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = row.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** True when the editor holds changes not yet reflected in `saved`. */
export function isDirty(rows: string[], saved: string[]): boolean {
  const a = normalizeForSave(rows);
  return a.length !== saved.length || a.some((text, i) => text !== saved[i]);
}

/** Rows the backend would reject outright, so the UI can flag them inline. */
export function overLongRows(rows: string[]): number[] {
  return rows.map((r, i) => (r.trim().length > MAX_CRITERION_CHARS ? i : -1)).filter((i) => i !== -1);
}
