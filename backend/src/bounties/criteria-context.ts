// Picks the slice of a repo's index that is relevant to a bounty's issue, so
// the criteria draft is grounded in the actual codebase.
//
// The review pipeline's equivalent (gatherHolisticContext) is DIFF-driven:
// touched files -> their dependents -> a manifest. A bounty has no diff — the
// work hasn't been written yet — so relevance has to come from the issue text
// instead. This is deliberately a cheap lexical ranker rather than a second LLM
// call: retrieval that costs a model round-trip would double the latency of a
// job a sponsor is actively waiting on.
//
// Pure and deterministic (no DB, no I/O, stable tie-breaks) so it unit-tests
// offline and produces the same ranking run to run.
import type { RepoIndexEntry } from "../types.js";
// Type-only, so this module stays runtime-independent of the review pipeline.
import type { IngestedSource } from "../review/pipeline.js";

export type IndexedFile = Pick<RepoIndexEntry, "path" | "summary" | "exports" | "size">;

export const RELEVANT_FILES_CAP = 12;
export const MANIFEST_CAP = 25;
export const SUMMARY_CHAR_CAP = 400;
export const TOTAL_CHAR_CAP = 24_000;

// A token matching more than this share of the index carries no signal — in a
// repo where every file is a "service", "service" cannot discriminate. Damping
// these out is what stops a generic issue from flattening the whole ranking.
export const DF_CUTOFF = 0.3;
// ...but only once there are enough files for a share to mean anything. Below
// this, 30% is a couple of files and damping would delete the only signal there
// is (in a 3-file index every real match looks "too frequent"). A small index
// can't be flattened anyway — we're showing most of it regardless.
export const DF_MIN_ENTRIES = 20;

// Points by where a token hits. A file the issue NAMES outranks everything;
// after that, path > exported symbol > prose.
const PATH_HINT_POINTS = 50;
const PATH_TOKEN_POINTS = 6;
const EXPORT_TOKEN_POINTS = 4;
const SUMMARY_TOKEN_POINTS = 1;
const SUMMARY_POINTS_CAP = 8;
// Backticked or identifier-shaped tokens are far likelier to be real symbols
// than prose words, so they count for more wherever they land.
const IDENTIFIER_WEIGHT = 3;

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|cs|cc|cpp)$/i;

// Filenames as written in an issue body ("see backend/src/db.ts", "`links.ts`").
const PATH_HINT_RE =
  /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|c|cc|cpp|h|hpp|css|scss|html|vue|svelte|sql|md|ya?ml|toml|json)\b/gi;

const STOPWORDS = new Set([
  // common English
  "the","and","for","that","this","with","from","have","has","had","not","but","are","was","were","been",
  "being","its","it's","you","your","our","their","they","them","there","then","than","when","what","which",
  "who","whom","how","why","all","any","can","could","should","would","will","shall","may","might","must",
  "into","onto","out","off","over","under","after","before","during","while","about","above","below","between",
  "each","every","some","such","only","own","same","too","very","just","also","because","however","therefore",
  "does","did","done","doing","get","got","make","made","see","seen","use","used","using","via","per","upon",
  // generic to issue-writing and code, so they never discriminate
  "code","file","files","function","functions","method","class","module","should","issue","bug","fix","fixes",
  "add","added","adds","support","need","needs","want","error","errors","change","changes","update","updates",
  "implement","currently","instead","expected","actual","behavior","behaviour","please","thanks","repo",
  "repository","project","app","application","new","old","user","users","test","tests",
]);

/** Split camelCase / snake_case / kebab-case / dotted paths into lowercase words. */
function splitIdentifier(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function usefulTokens(raw: string): string[] {
  return splitIdentifier(raw).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Every token an index entry can be matched on, bucketed by where it came from. */
type EntryTokens = { path: Set<string>; exports: Set<string>; summary: Set<string>; all: Set<string> };

function tokenizeEntry(entry: IndexedFile): EntryTokens {
  const path = new Set(usefulTokens(entry.path));
  const exports = new Set(entry.exports.flatMap((e) => usefulTokens(e)));
  const summary = new Set(usefulTokens(entry.summary));
  return { path, exports, summary, all: new Set([...path, ...exports, ...summary]) };
}

/**
 * Issue tokens with their weights. Identifier-shaped tokens (backticked, or
 * containing a `/`, `.`, `_`, or an internal capital in the ORIGINAL text)
 * weigh more, since prose rarely produces them by accident.
 */
function tokenizeIssue(issueText: string): Map<string, number> {
  const weights = new Map<string, number>();
  const bump = (token: string, weight: number) => {
    weights.set(token, Math.max(weights.get(token) ?? 0, weight));
  };
  for (const token of usefulTokens(issueText)) bump(token, 1);
  // Second pass over the raw text for the high-signal shapes only.
  const identifierLike = issueText.match(/`[^`]+`|[\w]+[./_][\w./_-]+|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? [];
  for (const raw of identifierLike) {
    for (const token of usefulTokens(raw)) bump(token, IDENTIFIER_WEIGHT);
  }
  return weights;
}

/** Does an index entry's path match a filename the issue named? */
function matchesPathHint(path: string, hint: string): boolean {
  const p = path.toLowerCase();
  const h = hint.toLowerCase().replace(/^\.?\//, "");
  if (p === h) return true;
  if (p.endsWith(`/${h}`)) return true; // issue gave a suffix ("bounties/links.ts")
  if (h.endsWith(`/${p}`)) return true; // issue gave a longer path than we indexed
  return false;
}

function scoreEntry(
  tokens: EntryTokens,
  entry: IndexedFile,
  issueTokens: Map<string, number>,
  pathHints: string[]
): number {
  let score = 0;
  if (pathHints.some((hint) => matchesPathHint(entry.path, hint))) score += PATH_HINT_POINTS;

  let summaryPoints = 0;
  for (const [token, weight] of issueTokens) {
    if (tokens.path.has(token)) score += PATH_TOKEN_POINTS * weight;
    if (tokens.exports.has(token)) score += EXPORT_TOKEN_POINTS * weight;
    if (tokens.summary.has(token)) summaryPoints += SUMMARY_TOKEN_POINTS * weight;
  }
  return score + Math.min(summaryPoints, SUMMARY_POINTS_CAP);
}

export type RepoContextSelection = {
  files: IndexedFile[];
  manifest: Array<{ path: string; summary: string }>;
};

/**
 * Rank `entries` against the issue text.
 *
 * The manifest is returned even when nothing scores — a short tour of the
 * biggest files still gives the model a mental model of the project, and it's
 * free. Callers that have no index at all get `{ files: [], manifest: [] }` and
 * should fall back to issue-only criteria.
 */
export function selectRepoContext(
  issueText: string,
  entries: IndexedFile[],
  caps: { files?: number; manifest?: number } = {}
): RepoContextSelection {
  const fileCap = caps.files ?? RELEVANT_FILES_CAP;
  const manifestCap = caps.manifest ?? MANIFEST_CAP;
  if (!entries.length) return { files: [], manifest: [] };

  const tokenized = entries.map((entry) => ({ entry, tokens: tokenizeEntry(entry) }));

  // Document-frequency damping: drop issue tokens that match too much of the
  // index to discriminate.
  const issueTokens = tokenizeIssue(issueText);
  if (entries.length >= DF_MIN_ENTRIES) {
    const cutoff = entries.length * DF_CUTOFF;
    for (const token of [...issueTokens.keys()]) {
      let df = 0;
      for (const { tokens } of tokenized) if (tokens.all.has(token)) df++;
      if (df > cutoff) issueTokens.delete(token);
    }
  }

  const pathHints = [...new Set(issueText.match(PATH_HINT_RE) ?? [])];

  const scored = tokenized
    .map(({ entry, tokens }) => ({ entry, score: scoreEntry(tokens, entry, issueTokens, pathHints) }))
    .filter((row) => row.score > 0)
    // Deterministic ordering: score, then shorter paths (more central files
    // sort first), then lexicographic. Never rely on DB/array order.
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path)
    );

  const files = scored.slice(0, fileCap).map((row) => row.entry);

  // Manifest: a crude importance proxy (largest code files), minus anything
  // already shown in full above.
  const chosen = new Set(files.map((f) => f.path));
  const manifest = entries
    .filter((e) => !chosen.has(e.path) && CODE_EXT.test(e.path))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, manifestCap)
    .map((e) => ({ path: e.path, summary: truncate(e.summary, SUMMARY_CHAR_CAP) }));

  return { files, manifest };
}

function truncate(text: string, cap: number): string {
  const t = (text || "").trim();
  return t.length <= cap ? t : `${t.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Render a selection as `repo_context` sources for criteria synthesis, under a
 * hard total-character budget (dropped from the tail, so the highest-ranked
 * files always survive).
 */
export function renderRepoContext(
  selection: RepoContextSelection,
  totalCharCap: number = TOTAL_CHAR_CAP
): IngestedSource[] {
  const sources: IngestedSource[] = [];
  let budget = totalCharCap;

  for (const file of selection.files) {
    const exports = file.exports.length ? `Exports: ${file.exports.slice(0, 20).join(", ")}\n` : "";
    const text = `${exports}${truncate(file.summary, SUMMARY_CHAR_CAP)}`;
    if (text.length > budget) break;
    budget -= text.length;
    sources.push({ kind: "repo_context", ref: file.path, text });
  }

  if (selection.manifest.length) {
    const lines = selection.manifest.map((m) => `- ${m.path}: ${m.summary}`);
    let text = "";
    for (const line of lines) {
      if (text.length + line.length + 1 > budget) break;
      text += (text ? "\n" : "") + line;
    }
    if (text) sources.push({ kind: "repo_context", ref: "repository map", text });
  }

  return sources;
}
