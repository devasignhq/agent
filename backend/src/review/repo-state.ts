// Repository state the criteria pass needs but the diff doesn't show: ignore
// rules for the paths the diff writes to, and a read-only file lookup pinned to
// the PR head. Network access is injected so all of this tests offline.
import { posix } from "node:path";
import type { Criterion } from "../types.js";
import { checkIgnore, type IgnoreFile, type IgnoreMode } from "./ignore-rules.js";
import { numberLines } from "./diff-format.js";
import { wrapUntrusted } from "../untrusted.js";

export type ReadFileAt = (path: string) => Promise<string | null>;
export type RepoEntry = { kind: "file"; content: string } | { kind: "dir"; entries: string[] } | null;
export type ReadRepoPath = (path: string) => Promise<RepoEntry>;

const IGNORE_CRITERION_RE = /ignor|untracked|\btracked\b|commit|check(?:ed)?[- ]in|version control|build context/i;
const DOCKER_RE = /docker|container|build context/i;
const GCLOUD_RE = /gcloud|cloud build|cloud run|app engine|cloud functions/i;

const FILE_EXTS = new Set(
  "yaml yml json toml ini conf cfg txt log csv tsv pem key crt p12 pfx sqlite sqlite3 db lock md out tmp bak sh js mjs cjs ts py rb go rs xml html sql gz zip tar tfstate tfvars properties plist".split(
    " "
  )
);
const MAX_CANDIDATES = 25;
const MAX_IGNORE_FETCHES = 24;

export function criteriaNeedIgnoreFacts(criteria: Pick<Criterion, "text">[]): boolean {
  return criteria.some((c) => IGNORE_CRITERION_RE.test(c.text));
}

function looksLikeFile(segment: string): boolean {
  if (/^\.[\w-][\w.-]*$/.test(segment)) return true;
  const ext = /\.([A-Za-z0-9]+)$/.exec(segment)?.[1];
  return !!ext && FILE_EXTS.has(ext.toLowerCase());
}

function cleanRel(p: string): string | null {
  const n = posix.normalize(p).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!n || n === "." || n.startsWith("../") || n.startsWith("/")) return null;
  return n;
}

// Path-like literals on one added line, resolved against the file's directory.
// A leading `$VAR/`, `${VAR}/` or `$(…)/` is read as "relative to the script".
export function pathsInLine(line: string, fileDir: string): string[] {
  if (/^\s*(?:import|export)\b|\brequire\(/.test(line)) return [];
  const text = line.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ");
  const out: string[] = [];
  for (const m of text.matchAll(/[\w.\-/]+/g)) {
    let token = m[0];
    const prev = m.index! > 0 ? text[m.index! - 1] : "";
    let varRelative = false;
    if (prev === "$" || prev === "{") {
      const slash = token.indexOf("/");
      if (slash === -1) continue;
      token = token.slice(slash);
      varRelative = true;
    }
    if (token.startsWith("/")) {
      if (!varRelative && !/[)}]/.test(prev)) continue;
      token = token.replace(/^\/+/, "");
      varRelative = true;
    }
    const last = token.split("/").pop() ?? "";
    if (last.endsWith(".") || !looksLikeFile(last)) continue;
    const resolved = new Set<string>();
    const add = (p: string) => {
      const c = cleanRel(p);
      if (c) resolved.add(c);
    };
    if (token.startsWith("./") || token.startsWith("../") || varRelative || !token.includes("/")) {
      add(posix.join(fileDir, token));
    } else {
      add(token);
      if (fileDir && !token.startsWith(fileDir + "/")) add(posix.join(fileDir, token));
    }
    out.push(...resolved);
  }
  return out;
}

export type WriteCandidate = { path: string; from: string; inDiff: boolean };

// Paths the diff writes to: path literals in added lines first (the generated
// artefacts a script emits never appear in the diff), then the changed files.
export function diffWriteCandidates(diff: string): WriteCandidate[] {
  const literals: WriteCandidate[] = [];
  const changed: WriteCandidate[] = [];
  const seen = new Set<string>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (file && !seen.has(file)) {
        seen.add(file);
        changed.push({ path: file, from: file, inDiff: true });
      }
      continue;
    }
    if (!file || !line.startsWith("+") || /ignore$/.test(file)) continue;
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    for (const p of pathsInLine(line.slice(1), dir)) {
      if (seen.has(p)) continue;
      seen.add(p);
      literals.push({ path: p, from: file, inDiff: false });
    }
  }
  return [...literals, ...changed].slice(0, MAX_CANDIDATES);
}

function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

type IgnoreKind = { name: ".gitignore" | ".dockerignore" | ".gcloudignore"; label: string; mode: IgnoreMode; cascade: boolean };

const KINDS: Record<string, IgnoreKind> = {
  git: { name: ".gitignore", label: "ignored by git", mode: "git", cascade: true },
  docker: { name: ".dockerignore", label: "excluded from the Docker build context", mode: "anchored", cascade: false },
  gcloud: { name: ".gcloudignore", label: "excluded from the gcloud upload", mode: "git", cascade: false },
};

export type IgnoreFact = {
  path: string;
  from: string;
  inDiff: boolean;
  kind: IgnoreKind["name"];
  label: string;
  match: { source: string; line: number; pattern: string; ignored: boolean } | null;
  checked: string[];
  // Ignore files that exist or may exist but could not be read — the answer is unknown.
  unreadable: string[];
};

export async function gatherIgnoreFacts(args: {
  diff: string;
  criteria: Pick<Criterion, "text">[];
  read: ReadFileAt;
}): Promise<IgnoreFact[]> {
  if (!args.diff || !criteriaNeedIgnoreFacts(args.criteria)) return [];
  const candidates = diffWriteCandidates(args.diff);
  if (!candidates.length) return [];
  const text = args.criteria.map((c) => c.text).join("\n");
  const kinds = [KINDS.git];
  if (DOCKER_RE.test(text)) kinds.push(KINDS.docker);
  if (GCLOUD_RE.test(text)) kinds.push(KINDS.gcloud);

  const wanted = new Set<string>();
  for (const c of candidates) for (const d of ancestorDirs(c.path)) for (const k of kinds) wanted.add(join(d, k.name));
  const fetched = new Map<string, string>();
  const unreadable = new Set<string>([...wanted].slice(MAX_IGNORE_FETCHES));
  await Promise.all(
    [...wanted].slice(0, MAX_IGNORE_FETCHES).map(async (p) => {
      try {
        const content = await args.read(p);
        if (content != null) fetched.set(p, content);
      } catch {
        unreadable.add(p);
      }
    })
  );

  const facts: IgnoreFact[] = [];
  for (const k of kinds) {
    for (const c of candidates) {
      const all = ancestorDirs(c.path).map((d) => join(d, k.name));
      const present = all.filter((p) => fetched.has(p));
      const unknown = all.filter((p) => unreadable.has(p));
      // Docker and gcloud read one file: the one at the build-context root.
      const files: IgnoreFile[] = (k.cascade ? present : present.slice(-1)).map((p) => ({ path: p, content: fetched.get(p)! }));
      if (!files.length && !unknown.length && k !== KINDS.git) continue;
      const m = files.length ? checkIgnore(c.path, files, k.mode) : null;
      facts.push({
        path: c.path,
        from: c.from,
        inDiff: c.inDiff,
        kind: k.name,
        label: k.label,
        match: m,
        checked: files.map((f) => f.path),
        unreadable: m?.ignored ? [] : unknown,
      });
    }
  }
  return facts;
}

export function renderRepoStateSection(facts: IgnoreFact[]): string {
  if (!facts.length) return "";
  const lines = facts.map((f) => {
    const origin = f.inDiff ? "changed in this diff" : `written by ${f.from}`;
    const head = `- \`${f.path}\` (${origin}): `;
    if (f.match?.ignored) return `${head}${f.label} — \`${f.match.source}:${f.match.line}\` \`${f.match.pattern}\``;
    if (f.unreadable.length) {
      return `${head}UNKNOWN whether ${f.label} — could not read ${f.unreadable.map((u) => `\`${u}\``).join(", ")}; use read_repo_file`;
    }
    if (f.match) return `${head}NOT ${f.label} — re-included by \`${f.match.source}:${f.match.line}\` \`${f.match.pattern}\``;
    const checked = f.checked.length ? `checked ${f.checked.map((c) => `\`${c}\``).join(", ")}` : `no ${f.kind} exists at the root or in any parent directory`;
    return `${head}NOT ${f.label} (${checked})`;
  });
  return (
    "# Repository state outside the diff (read at the PR head)\n" +
    "Resolved the way `git check-ignore -v` resolves them, against the ignore files as they exist at the PR head " +
    "— including rules that predate this PR. Treat these as facts about the repository.\n" +
    lines.join("\n")
  );
}

const READ_CAP = 30_000;
const DIR_CAP = 200;

// A traversal outside the repo, or an absolute path, never reaches the fetcher.
export function normaliseRepoPath(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^\/+/, "");
  if (s === "" || s === ".") return "";
  if (s.split("/").includes("..")) return null;
  return cleanRel(s);
}

export async function runRepoRead(input: unknown, read: ReadRepoPath, token?: string): Promise<string> {
  const path = normaliseRepoPath((input as { path?: unknown } | null)?.path);
  if (path == null) return "Refused: the path must be repo-relative and stay inside the repository.";
  let entry: RepoEntry;
  try {
    entry = await read(path);
  } catch (err) {
    return `Could not read \`${path || "/"}\` at the PR head: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!entry) return `\`${path || "/"}\` does not exist at the PR head.`;
  if (entry.kind === "dir") {
    const shown = entry.entries.slice(0, DIR_CAP).join("\n");
    const more = entry.entries.length > DIR_CAP ? `\n… ${entry.entries.length - DIR_CAP} more` : "";
    return `Directory \`${path || "/"}\` at the PR head:\n${wrapUntrusted("DIR_LISTING", shown + more, token)}`;
  }
  const truncated = entry.content.length > READ_CAP;
  const body = numberLines(entry.content.slice(0, READ_CAP), 1);
  return (
    `File \`${path}\` at the PR head${truncated ? ` (first ${READ_CAP} chars of ${entry.content.length})` : ""}:\n` +
    wrapUntrusted("FILE_CONTENT", body, token)
  );
}
