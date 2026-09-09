// Where a review-comment thread can legally be anchored.
//
// GitHub's POST /pulls/{n}/comments accepts either `line` + `side` (a line that
// is part of the diff) or `subject_type: "file"` (the whole file). Anything
// else 422s with "line must be part of the diff" — and unlike the web UI, the
// REST API will NOT accept an arbitrary line of a changed file. So we work out
// up front which anchors are legal and degrade rather than let a create fail.
//
// Pure — no db / network / LLM:
//   node --import tsx/esm --test src/review/anchor.test.ts
import { parseDiffHunksByFile } from "./diff-format.js";

export type LineRange = { from: number; to: number };
/** New-file path -> the RIGHT-side line ranges GitHub will accept a comment on. */
export type LineIndex = Map<string, LineRange[]>;

export type AnchorFailure = "no-path" | "path-not-in-diff" | "line-outside-diff";

export type Anchor =
  | { kind: "line"; path: string; line: number; side: "RIGHT"; snappedFrom?: number }
  | { kind: "file"; path: string }
  | { kind: "none"; reason: AnchorFailure };

// How far off a model-supplied line may be before we stop trusting it. A finding
// that cites a `-` line or one just past a hunk edge is still about that hunk;
// beyond a handful of lines the anchor would be a lie, so we drop to file level.
export const SNAP_WITHIN = 5;

// A hunk's new-file span covers its added AND context lines — exactly the set
// GitHub accepts on the RIGHT side. Pure-deletion hunks (newLines === 0) have no
// right-side line at all.
export function commentableLines(diff: string): LineIndex {
  const out: LineIndex = new Map();
  for (const [path, hunks] of parseDiffHunksByFile(diff)) {
    const ranges = hunks
      .filter((h) => h.newLines > 0)
      .map((h) => ({ from: h.newStart, to: h.newStart + h.newLines - 1 }))
      .sort((a, b) => a.from - b.from);
    if (ranges.length) out.set(path, ranges);
  }
  return out;
}

function nearestLegalLine(line: number, ranges: LineRange[]): number {
  let best = ranges[0].from;
  let bestDist = Math.abs(line - best);
  for (const r of ranges) {
    const clamped = Math.min(Math.max(line, r.from), r.to);
    const dist = Math.abs(line - clamped);
    if (dist < bestDist) {
      best = clamped;
      bestDist = dist;
    }
  }
  return best;
}

// Fallback chain, in order:
//   1. no path                      -> none        (renders in the summary card)
//   2. path not in the diff         -> none        (a file-level comment on a file
//                                                   outside the diff also 422s)
//   3. line inside a hunk           -> line
//   4. line within SNAP_WITHIN      -> line, with snappedFrom set so the caller
//                                     can say "nearest diff line to x:N"
//   5. path in diff, no usable line -> file
export function resolveAnchor(
  item: { path?: string; line?: number },
  index: LineIndex,
  opts: { snapWithin?: number } = {}
): Anchor {
  const path = item.path?.trim();
  if (!path) return { kind: "none", reason: "no-path" };
  const ranges = index.get(path);
  if (!ranges?.length) return { kind: "none", reason: "path-not-in-diff" };

  const line = item.line;
  if (typeof line === "number" && Number.isInteger(line) && line > 0) {
    for (const r of ranges) {
      if (line >= r.from && line <= r.to) return { kind: "line", path, line, side: "RIGHT" };
    }
    const snap = nearestLegalLine(line, ranges);
    if (Math.abs(snap - line) <= (opts.snapWithin ?? SNAP_WITHIN)) {
      return { kind: "line", path, line: snap, side: "RIGHT", snappedFrom: line };
    }
  }
  return { kind: "file", path };
}
