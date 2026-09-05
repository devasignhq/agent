// Which characters of a JS/TS source are in genuine code position. Used to stop
// the planner's import rewriter from editing module-looking text that is data —
// an assertion's expected message, a comment, or source inside a template.
//
// Hand-rolled on purpose: `typescript` is a devDependency, so ts.createScanner
// is not reachable from the running server.

export type CodeSpans = {
  // 1 where the character is code. Literal delimiters and their contents,
  // comments, and regex bodies are 0; the inside of a `${…}` hole is 1.
  code: Uint8Array;
  // Opening quote/backtick index → index of its matching closer.
  literals: Map<number, number>;
};

// After one of these a `/` starts a regex, not a division.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

/** End index of the closing quote, or -1: a string never crosses a raw newline. */
function quoteEnd(src: string, open: number, quote: string): number {
  for (let k = open + 1; k < src.length; k++) {
    const ch = src[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === quote) return k;
    if (ch === "\n") return -1;
  }
  return -1;
}

/** End index of the closing slash, or -1. Character classes may contain `/`. */
function regexEnd(src: string, open: number): number {
  let inClass = false;
  for (let k = open + 1; k < src.length; k++) {
    const ch = src[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "\n") return -1;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return k;
  }
  return -1;
}

// Ambiguity resolves toward regex: a regex read as division lets a quote inside
// it desynchronise the scan, while a division read as regex un-does itself at
// the newline bound in regexEnd.
function looksLikeRegex(src: string, prev: string, prevEnd: number): boolean {
  if (!prev) return true;
  if (!/[\w$)\]'"`]/.test(prev)) return true;
  if (!/[\w$]/.test(prev)) return false;
  let start = prevEnd;
  while (start > 0 && /[\w$]/.test(src[start - 1])) start--;
  return REGEX_KEYWORDS.has(src.slice(start, prevEnd));
}

export function codeSpans(src: string): CodeSpans {
  const code = new Uint8Array(src.length).fill(1);
  const literals = new Map<number, number>();
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) code[k] = 0;
  };
  // One entry per open template literal. `hole` is the brace depth of its `${`,
  // or -1 while we are in the template's text.
  const templates: Array<{ open: number; hole: number }> = [];
  let depth = 0;
  let prev = "";
  let prevEnd = 0;
  let i = 0;

  while (i < src.length) {
    const top = templates[templates.length - 1];
    const c = src[i];

    if (top && top.hole < 0) {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(i, i + 2);
        top.hole = depth;
        prev = "{";
        prevEnd = i + 2;
        i += 2;
        continue;
      }
      if (c === "`") {
        code[i] = 0;
        literals.set(top.open, i);
        templates.pop();
        prev = "`";
        prevEnd = i + 1;
        i++;
        continue;
      }
      code[i] = 0;
      i++;
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/") {
      const end = looksLikeRegex(src, prev, prevEnd) ? regexEnd(src, i) : -1;
      if (end > 0) {
        blank(i, end + 1);
        i = end + 1;
      } else {
        i++;
      }
      prev = "/";
      prevEnd = i;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quoteEnd(src, i, c);
      if (end > 0) {
        literals.set(i, end);
        blank(i, end + 1);
        i = end + 1;
      } else {
        // Unterminated on this line: ordinary code, and the scan resyncs.
        i++;
      }
      prev = c;
      prevEnd = i;
      continue;
    }
    if (c === "`") {
      templates.push({ open: i, hole: -1 });
      code[i] = 0;
      i++;
      continue;
    }
    if (c === "{") {
      depth++;
      prev = "{";
      prevEnd = i + 1;
      i++;
      continue;
    }
    if (c === "}") {
      if (top && top.hole === depth) {
        top.hole = -1;
        code[i] = 0;
        i++;
        continue;
      }
      depth--;
      prev = "}";
      prevEnd = i + 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevEnd = i + 1;
    }
    i++;
  }
  return { code, literals };
}

/**
 * True when a matched import specifier is real code: the quotes the regex paired
 * are one literal's own delimiters, and the statement leading them is not itself
 * inside a string or comment.
 */
export function isRewritableSpecifier(spans: CodeSpans, offset: number, lead: string, spec: string): boolean {
  const quoteAt = offset + lead.length;
  if (spans.literals.get(quoteAt) !== quoteAt + 1 + spec.length) return false;
  // Leads that begin with (?:^|\n)[ \t]* start at the keyword once trimmed; the
  // call-shaped leads have no leading space, so trimStart is a no-op there.
  return spans.code[offset + (lead.length - lead.trimStart().length)] === 1;
}
