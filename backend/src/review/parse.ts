// Robust parsing of model output for the review stages. Pure string module —
// no db / network / LLM — unit-tested offline:
//   node --import tsx/esm --test src/review/parse.test.ts
//
// extractJSON tries, in order:
//   1. JSON inside a ```json fence (models add fences despite instructions)
//   2. the raw text as JSON
//   3. the outermost brace-matched object (string/escape-aware scan)
//   4. truncation repair: close open strings/brackets, trimming a trailing
//      half-written value when needed (max_tokens cuts mid-object; recovering
//      the complete prefix beats discarding a whole verdict)
//
// The prose-bleed guards catch a failure mode where a code field's content
// leaks into a prose field (summary/rationale) mid-generation; they truncate
// the prose at the first bleed signal instead of posting code soup to GitHub.

export function extractJSON(response: string): unknown | null {
  const raw = String(response ?? "").trim();
  if (!raw) return null;

  // Strategy 1: fenced ```json block.
  const fenceMatch = raw.match(/```(?:json)?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Strategy 2: the whole response is JSON.
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  // Strategy 3: outermost matched braces via character scan.
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end !== -1) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  // Strategy 4: repair a truncated object.
  return repairTruncatedJSON(raw.slice(start));
}

// Close the open strings/brackets of a truncated JSON document. Attempt A trims
// the trailing half-written key/value back to the last safe comma first; attempt
// B closes onto the raw text directly.
export function repairTruncatedJSON(truncated: string): unknown | null {
  try {
    let inString = false;
    let escape = false;
    const stack: string[] = [];
    for (let i = 0; i < truncated.length; i++) {
      const ch = truncated[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    if (stack.length === 0) return null; // balanced — nothing to repair

    let repaired = truncated;
    if (inString) repaired += '"';
    const closers = stack
      .map((open) => (open === "{" ? "}" : "]"))
      .reverse()
      .join("");

    try {
      return JSON.parse(trimLastIncompleteValue(repaired) + closers);
    } catch {
      // fall back to direct closure
    }
    try {
      return JSON.parse(repaired + closers);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// Trim a truncated JSON string back to the last comma outside any string
// literal, dropping the half-written trailing key/value pair.
export function trimLastIncompleteValue(json: string): string {
  let inString = false;
  let escape = false;
  let lastSafeComma = -1;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === ",") lastSafeComma = i;
  }
  return lastSafeComma > 0 ? json.slice(0, lastSafeComma) : json;
}

// ---------------------------------------------------------------------------
// Prose-bleed guards
// ---------------------------------------------------------------------------

// Replace code spans (inline `...` and fenced ```...```) with spaces, keeping
// length and newline positions intact, so intentional code quoting in prose is
// never mistaken for a bleed.
function maskInlineCode(text: string): string {
  const chars = text.split("");
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      const stop = end === -1 ? n : end + 3;
      for (let j = i; j < stop; j++) {
        if (chars[j] !== "\n") chars[j] = " ";
      }
      i = stop;
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 ? i + 1 : end + 1;
      for (let j = i; j < stop; j++) {
        if (chars[j] !== "\n") chars[j] = " ";
      }
      i = stop;
    } else {
      i++;
    }
  }
  return chars.join("");
}

function looksLikeCodeLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[)\]}>;,]+$/.test(t)) return true;
  if (/[{};]\s*$/.test(t)) return true;
  if (/=>/.test(t)) return true;
  return /^(const |let |var |function\b|return\b|if\s*\(|else\b|for\s*\(|while\s*\(|switch\s*\(|export\b|import\b|await |async |class\b|try\s*\{?|catch\b|case |throw |\/\/)/.test(
    t
  );
}

// Find where source code bled into a prose field, or -1 when clean. Signals:
// A) a verbatim fingerprint of one of the field's own code blocks appears in
//    the prose; B) a prose character fused directly to a closing brace and a
//    code token; C) a run of 3+ code-shaped lines.
export function findProseCodeBleed(text: string, codeFields: string[]): number {
  if (!text) return -1;
  const masked = maskInlineCode(text);

  let aIdx = -1;
  for (const rawCode of codeFields) {
    const code = rawCode.trim();
    if (code.length < 24) continue;
    for (let k = 0; k + 24 <= code.length; k += 12) {
      const fingerprint = code.slice(k, k + 24);
      if (!/[(){};=]|=>/.test(fingerprint)) continue;
      const idx = masked.indexOf(fingerprint);
      if (idx !== -1) {
        aIdx = aIdx === -1 ? idx : Math.min(aIdx, idx);
        break;
      }
    }
  }

  const fuse = /[A-Za-z0-9.,;:!?)\]'"]\}[A-Za-z_$(]/.exec(masked);
  const bIdx = fuse ? fuse.index + 1 : -1;

  let cIdx = -1;
  let offset = 0;
  let runLen = 0;
  let runStart = -1;
  for (const line of masked.split("\n")) {
    if (looksLikeCodeLine(line)) {
      if (runLen === 0) runStart = offset;
      runLen++;
      if (runLen >= 3) {
        cIdx = runStart;
        break;
      }
    } else {
      runLen = 0;
    }
    offset += line.length + 1;
  }

  const candidates = [aIdx, bIdx, cIdx].filter((i) => i >= 0);
  if (candidates.length === 0) return -1;
  let cut = Math.min(...candidates);
  if (cut === cIdx && bIdx > cIdx) {
    const lineEnd = masked.indexOf("\n", cIdx);
    const limit = lineEnd === -1 ? masked.length : lineEnd;
    if (bIdx < limit) cut = bIdx;
  }
  return cut;
}

// Truncate bled code out of a prose field, restoring a clean text boundary.
export function repairBledProseField(
  text: string | undefined,
  codeFields: string[]
): { text: string | undefined; repaired: boolean } {
  if (typeof text !== "string" || text.length === 0) {
    return { text, repaired: false };
  }
  const cut = findProseCodeBleed(text, codeFields);
  if (cut < 0) return { text, repaired: false };
  const cleaned = text
    .slice(0, cut)
    .replace(/[\s([{<>+\-*/=&|]+$/, "")
    .trimEnd();
  return { text: cleaned, repaired: true };
}
