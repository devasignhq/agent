// Unified-diff formatting helpers for the review prompts. The review stages
// show the model a diff whose lines carry a pre-computed "N | " gutter in
// NEW-file coordinates, so findings cite a real line number instead of the
// model counting lines itself (which it does badly). Pure string/parse module —
// no db / network / LLM — so it unit-tests offline:
//   node --import tsx/esm --test src/review/diff-format.test.ts
//
// Gutter contract (mirrored by the stage prompts' "line numbers" sections):
// - Added (`+`) and context (` `) lines get "N | " where N is the 1-based line
//   in the new version of the file.
// - Removed (`-`) lines get a blank gutter of the same width — they don't exist
//   in the new file, so they must never be assigned a number.
// - File headers (diff --git/index/---/+++/mode lines) and hunk headers (@@)
//   pass through un-guttered.

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse the @@ headers of a single file's patch. Tolerates the short form
// ("@@ -3 +4 @@" — a count of 1) that git emits for single-line hunks.
export function parseDiffHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const line of patch.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// Split a whole unified diff into per-file hunk lists, keyed by the new-file
// path from the "+++ b/<path>" header. Deleted files ("+++ /dev/null") and
// patch-less entries (binary, pure renames) contribute no key.
export function parseDiffHunksByFile(diff: string): Map<string, DiffHunk[]> {
  const byFile = new Map<string, DiffHunk[]>();
  let current: DiffHunk[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
      } else {
        const path = target.startsWith("b/") ? target.slice(2) : target;
        current = byFile.get(path) ?? [];
        byFile.set(path, current);
      }
      continue;
    }
    if (current) {
      const m = HUNK_RE.exec(line);
      if (m) {
        current.push({
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return byFile;
}

// Re-anchor a pre-diff (old-file) line number onto the post-diff file. Lines
// inside a hunk map positionally (clamped to the hunk); lines between hunks
// shift by the net add/remove delta of every earlier hunk.
export function mapOldLineToNew(oldLine: number, hunks: DiffHunk[]): number {
  let delta = 0;
  for (const h of hunks) {
    if (oldLine < h.oldStart) return oldLine + delta;
    if (oldLine < h.oldStart + h.oldLines) {
      const offset = oldLine - h.oldStart;
      return h.newStart + Math.min(offset, Math.max(h.newLines - 1, 0));
    }
    delta += h.newLines - h.oldLines;
  }
  return oldLine + delta;
}

// Prefix each line of `content` with a right-aligned "N | " gutter starting at
// `start`. Used for whole-file excerpts (not diffs), e.g. re-verify context.
export function numberLines(content: string, start: number): string {
  const lines = content.split("\n");
  const width = String(start + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
    .join("\n");
}

// Add "N | " gutters (new-file numbering) to a unified diff. See the gutter
// contract at the top of this file.
export function formatRawDiff(diff: string): string {
  const lines = diff.split("\n");
  // Gutter width: widest new-file line number any hunk can reach, so the pipe
  // column is stable across the whole diff.
  let maxLine = 1;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      maxLine = Math.max(maxLine, newStart + Math.max(newLines - 1, 0));
    }
  }
  const width = String(maxLine).length;
  const blank = `${" ".repeat(width)} | `;

  const out: string[] = [];
  let newLineNo: number | null = null; // null = outside any hunk
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      newLineNo = Number(m[3]);
      out.push(line);
      continue;
    }
    if (
      newLineNo === null ||
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      // File-level metadata (also terminates the current hunk).
      if (
        line.startsWith("diff --git") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("index ")
      ) {
        newLineNo = null;
      }
      out.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${String(newLineNo).padStart(width)} | ${line}`);
      newLineNo++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // Removed lines and "\ No newline at end of file" markers have no
      // new-file line number.
      out.push(`${blank}${line}`);
    } else {
      // Context line (leading space, or empty context line).
      out.push(`${String(newLineNo).padStart(width)} | ${line}`);
      newLineNo++;
    }
  }
  return out.join("\n");
}

// Truncate a unified diff to at most ~`cap` characters, cutting at a hunk or
// file boundary so the model never sees half a hunk. Falls back to a raw slice
// only when the very first hunk alone exceeds the cap. Returns the (possibly
// unchanged) text plus whether anything was dropped.
export function truncateDiffAtHunkBoundary(
  diff: string,
  cap: number
): { text: string; truncated: boolean } {
  if (diff.length <= cap) return { text: diff, truncated: false };
  const lines = diff.split("\n");
  let offset = 0;
  let lastBoundary = 0; // char offset where cutting keeps only complete hunks
  for (const line of lines) {
    if (offset > cap) break;
    if (HUNK_RE.test(line) || line.startsWith("diff --git")) {
      // Everything before this header is a run of complete hunks/files.
      lastBoundary = offset;
    }
    offset += line.length + 1;
  }
  if (lastBoundary <= 0) {
    return { text: diff.slice(0, cap), truncated: true };
  }
  return { text: diff.slice(0, lastBoundary).replace(/\n+$/, ""), truncated: true };
}

// Strip "N | " / blank-gutter prefixes that leaked from the numbered context
// into a model-emitted code field (evidenceCode.code, suggestedChange.original/
// suggested). The prompts forbid the leak; this enforces it mechanically so a
// rendered before/after diff never carries gutter artifacts.
export function stripGutterArtifacts(code: string): string {
  const lines = code.split("\n");
  const gutterish = lines.filter((l) => /^\s*\d+ \| /.test(l) || /^\s+\| /.test(l));
  // Only strip when the gutter pattern dominates the block — a lone "5 | x"
  // might be legitimate code (e.g. a bit-or expression in a table row).
  if (gutterish.length < Math.max(2, Math.ceil(lines.length / 2))) return code;
  return lines.map((l) => l.replace(/^\s*\d* \| /, "")).join("\n");
}
