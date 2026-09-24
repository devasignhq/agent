// `git check-ignore -v` semantics over ignore files fetched from the PR head, so
// the review can answer "is this path ignored?" without a checkout. Pure.
import { posix } from "node:path";

export type IgnoreFile = { path: string; content: string };

type Rule = {
  source: string;
  line: number;
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
};

export type IgnoreMatch = { ignored: boolean; source: string; line: number; pattern: string };

// "git": nested .gitignore cascade, unanchored patterns match at any depth.
// "anchored": .dockerignore — every pattern is relative to the context root.
export type IgnoreMode = "git" | "anchored";

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          i += 1;
          if (glob[i + 1] === "/") {
            i += 1;
            out += "(?:.*/)?";
          } else {
            out += ".*";
          }
          continue;
        }
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (ch === "\\" && i + 1 < glob.length) {
      i += 1;
      out += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

export function parseIgnoreFile(file: IgnoreFile, mode: IgnoreMode = "git"): Rule[] {
  const rules: Rule[] = [];
  file.content.split(/\r?\n/).forEach((rawLine, idx) => {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) return;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/") && line.length > 1) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) return;
    const anchored = mode === "anchored" || line.includes("/");
    const body = line.replace(/^\/+/, "");
    const re = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globToRegex(body)}$`);
    rules.push({ source: file.path, line: idx + 1, pattern: rawLine.trim(), negate, dirOnly, re });
  });
  return rules;
}

function baseDirOf(ignorePath: string): string {
  const dir = posix.dirname(ignorePath);
  return dir === "." ? "" : dir;
}

function lastMatch(rules: Rule[], rel: string, isDir: boolean): Rule | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) return r;
  }
  return null;
}

// Deeper ignore files override shallower ones; within a file the last match wins.
function matchOne(path: string, isDir: boolean, files: Array<{ base: string; rules: Rule[] }>): Rule | null {
  for (const f of files) {
    if (f.base && path !== f.base && !path.startsWith(f.base + "/")) continue;
    const rel = f.base ? path.slice(f.base.length + 1) : path;
    if (!rel) continue;
    const hit = lastMatch(f.rules, rel, isDir);
    if (hit) return hit;
  }
  return null;
}

// A file under an excluded directory stays ignored even if a later rule
// negates the file itself — git never descends into the excluded directory.
export function checkIgnore(path: string, ignoreFiles: IgnoreFile[], mode: IgnoreMode = "git"): IgnoreMatch | null {
  const clean = posix.normalize(path).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!clean || clean.startsWith("../")) return null;
  const files = ignoreFiles
    .map((f) => ({ base: baseDirOf(f.path), rules: parseIgnoreFile(f, mode) }))
    .sort((a, b) => b.base.length - a.base.length);
  const parts = clean.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const hit = matchOne(dir, true, files);
    if (hit && !hit.negate) return { ignored: true, source: hit.source, line: hit.line, pattern: hit.pattern };
  }
  const hit = matchOne(clean, false, files);
  if (!hit) return null;
  return { ignored: !hit.negate, source: hit.source, line: hit.line, pattern: hit.pattern };
}
