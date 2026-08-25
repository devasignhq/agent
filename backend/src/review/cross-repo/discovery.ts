// Finds sibling-repo code that might consume what this PR changed.
//
// Two lanes: the stored repo index (cheap, but its imports/exports are
// LLM-produced and unverified) and GitHub code search (wider, often unavailable).
// Neither is treated as evidence — every candidate is confirmed against real
// bytes before it reaches the model, and a candidate whose needle does not
// appear in those bytes is dropped.
import { db } from "../../db.js";
import { selectRepoContext } from "../../bounties/criteria-context.js";
import { fetchBlob } from "../indexer.js";
import { MAX_QUERIES_PER_REVIEW, buildSearchQuery, searchCode } from "./code-search.js";
import { ownerOf, repoNameOf, routeLiterals, symbolVariants } from "./naming.js";
import type { Installation, RepoIndexEntry, RepoTopology } from "../../types.js";

export const MAX_CANDIDATE_FILES = 12;
export const MAX_SNIPPET_CHARS = 3_000;
export const EXCERPT_RADIUS = 20;
const MAX_SEARCH_NEEDLES = 3;

export type Needle = {
  name: string;
  variants: string[];
  kind: "symbol" | "route";
};

export type CandidateSnippet = {
  repoFullName: string;
  path: string;
  sha: string;
  line: number;
  excerpt: string;
  matchedOn: string;
  lane: "index" | "search";
};

export type ParityProbe = {
  repoFullName: string;
  status: "present" | "absent" | "unknown";
  searched: string;
};

export function needlesFor(name: string, kind: "symbol" | "route"): Needle {
  return {
    name,
    kind,
    variants: kind === "route" ? routeLiterals(name) : symbolVariants(name),
  };
}

// The bytes decide, not the index. Returns null when no needle actually appears.
export function excerptAround(
  text: string,
  variants: string[],
  opts: { radius?: number; maxChars?: number } = {}
): { excerpt: string; line: number; matchedOn: string } | null {
  const radius = opts.radius ?? EXCERPT_RADIUS;
  const maxChars = opts.maxChars ?? MAX_SNIPPET_CHARS;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const hit = variants.find((v) => v && lines[i].includes(v));
    if (!hit) continue;
    const from = Math.max(0, i - radius);
    const to = Math.min(lines.length, i + radius + 1);
    let excerpt = lines.slice(from, to).join("\n");
    if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars);
    return { excerpt, line: i + 1, matchedOn: hit };
  }
  return null;
}

type SiblingIndex = { fullName: string; repoId: string; entries: RepoIndexEntry[] };

// One scan over repoIndex for every sibling at once — never one per symbol.
export function loadSiblingIndexes(siblingNames: string[]): SiblingIndex[] {
  const byId = new Map<string, string>();
  for (const fullName of siblingNames) {
    const owner = ownerOf(fullName);
    const name = repoNameOf(fullName);
    const row = db.find("repositories", (r) => r.owner === owner && r.name === name);
    if (!row) continue;
    const state = row.indexState ?? "none";
    if (state !== "ready" && state !== "stale") continue;
    byId.set(row.id, fullName);
  }
  if (!byId.size) return [];
  // Seeded from byId, not from the rows: a repo whose index is built but empty
  // still belongs in the result, so callers can tell "index has nothing in it"
  // apart from "we have no index for this repo".
  const out = new Map<string, SiblingIndex>();
  for (const [repoId, fullName] of byId) out.set(fullName, { fullName, repoId, entries: [] });
  for (const e of db.filter("repoIndex", (x) => byId.has(x.repoId))) {
    out.get(byId.get(e.repoId)!)!.entries.push(e);
  }
  return [...out.values()];
}

type Candidate = { fullName: string; entry: RepoIndexEntry; score: number; matchedOn: string };

export function rankCandidates(
  siblings: SiblingIndex[],
  needles: Needle[],
  publishedName: string | undefined,
  limit: number
): Candidate[] {
  const out: Candidate[] = [];
  const allVariants = needles.flatMap((n) => n.variants);

  for (const sib of siblings) {
    const seen = new Set<string>();
    for (const entry of sib.entries) {
      let score = 0;
      let matchedOn = "";
      if (publishedName) {
        const importsIt = entry.imports.some(
          (i) => i === publishedName || i.startsWith(`${publishedName}/`)
        );
        if (importsIt) {
          score += 40;
          matchedOn = publishedName;
        }
      }
      for (const v of allVariants) {
        if (entry.exports.includes(v)) {
          score += 20;
          matchedOn = matchedOn || v;
        }
        if (entry.imports.some((i) => i.includes(v))) {
          score += 10;
          matchedOn = matchedOn || v;
        }
      }
      if (score > 0) {
        seen.add(entry.path);
        out.push({ fullName: sib.fullName, entry, score, matchedOn });
      }
    }

    // Third and weakest signal: the existing lexical ranker, run per sibling so
    // attribution survives. Only fills seats the exact signals left empty.
    const lexical = selectRepoContext(allVariants.join(" "), sib.entries, { files: 3, manifest: 0 });
    for (const file of lexical.files) {
      if (seen.has(file.path)) continue;
      const entry = sib.entries.find((e) => e.path === file.path);
      if (!entry) continue;
      out.push({ fullName: sib.fullName, entry, score: 1, matchedOn: "lexical" });
    }
  }

  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path)
    )
    .slice(0, limit);
}

// Test seam: reading a sibling's bytes is the only part of discovery that needs
// the network, and it is the step the "index never becomes evidence" rule turns on.
type BlobReader = (fullName: string, install: Installation, path: string, sha: string) => Promise<string>;

const defaultBlobReader: BlobReader = (fullName, install, path, sha) =>
  fetchBlob({ owner: ownerOf(fullName), name: repoNameOf(fullName) }, install, path, sha);

let blobReader: BlobReader = defaultBlobReader;

export function __setBlobReaderForTests(fn: BlobReader | null): void {
  blobReader = fn ?? defaultBlobReader;
}

async function snippetFor(
  install: Installation,
  fullName: string,
  path: string,
  sha: string,
  variants: string[],
  lane: "index" | "search"
): Promise<CandidateSnippet | null> {
  try {
    const text = await blobReader(fullName, install, path, sha);
    const found = excerptAround(text, variants);
    if (!found) return null;
    return { repoFullName: fullName, path, sha, lane, ...found };
  } catch {
    return null;
  }
}

export async function discoverCandidates(args: {
  install: Installation;
  topology: RepoTopology | null;
  siblingNames: string[];
  needles: Needle[];
  publishedName?: string;
  selfFullName: string;
  // Repos this review is allowed to quote. Code search answers across the whole
  // installation, private repos included, so its hits must be filtered against
  // this rather than trusted.
  allowedRepos: Set<string>;
  deadline: number;
}): Promise<{ snippets: CandidateSnippet[]; searchesRun: number; indexedSiblings: string[] }> {
  const { install, needles, siblingNames, selfFullName } = args;
  const allVariants = needles.flatMap((n) => n.variants);
  if (!allVariants.length) return { snippets: [], searchesRun: 0, indexedSiblings: [] };

  const siblings = loadSiblingIndexes(siblingNames);
  const ranked = rankCandidates(siblings, needles, args.publishedName, MAX_CANDIDATE_FILES);

  const snippets: CandidateSnippet[] = [];
  for (const c of ranked) {
    if (Date.now() > args.deadline) break;
    const s = await snippetFor(install, c.fullName, c.entry.path, c.entry.sha, allVariants, "index");
    if (s) snippets.push(s);
  }

  let searchesRun = 0;
  const canSearch = args.topology?.codeSearch.status === "ok";
  if (canSearch && snippets.length < MAX_CANDIDATE_FILES) {
    const owner = args.topology!.owner;
    const isOrg = args.topology!.isOrg;
    const already = new Set(snippets.map((s) => `${s.repoFullName}:${s.path}`));
    for (const needle of needles.slice(0, MAX_SEARCH_NEEDLES)) {
      if (searchesRun >= MAX_QUERIES_PER_REVIEW) break;
      if (Date.now() > args.deadline) break;
      const q = buildSearchQuery({
        needle: needle.variants[0] || needle.name,
        owner,
        isOrg,
        excludeRepo: selfFullName,
      });
      const hits = await searchCode(install.installationId, q);
      searchesRun += 1;
      for (const hit of hits.slice(0, 3)) {
        if (snippets.length >= MAX_CANDIDATE_FILES) break;
        if (hit.fullName === selfFullName) continue;
        if (!args.allowedRepos.has(hit.fullName)) continue;
        if (already.has(`${hit.fullName}:${hit.path}`)) continue;
        already.add(`${hit.fullName}:${hit.path}`);
        const s = await snippetFor(install, hit.fullName, hit.path, hit.sha, allVariants, "search");
        if (s) snippets.push(s);
      }
    }
  }

  return { snippets, searchesRun, indexedSiblings: siblings.map((s) => s.fullName) };
}

// Parity can only speak about siblings we actually looked inside. A sibling with
// no built index is "unknown", never "absent" — claiming absence over a repo we
// never read would be an affirmative false claim.
export function probeParity(
  siblingNames: string[],
  featureName: string
): ParityProbe[] {
  const variants = symbolVariants(featureName);
  const indexes = loadSiblingIndexes(siblingNames);
  const indexed = new Map(indexes.map((s) => [s.fullName, s]));
  return siblingNames.map((fullName) => {
    const sib = indexed.get(fullName);
    if (!sib) {
      return {
        repoFullName: fullName,
        status: "unknown" as const,
        searched: "no index for this repo — nothing was read, so nothing is claimed",
      };
    }
    // An index that holds zero files is still zero files read. Searching nothing
    // and reporting "absent" would be an affirmative claim about a repo we never
    // looked inside, which is the one thing parity must never do.
    if (!sib.entries.length) {
      return {
        repoFullName: fullName,
        status: "unknown" as const,
        searched: "index is built but contains no indexable files — nothing was read",
      };
    }
    const searched = `exports and imports of ${sib.entries.length} indexed files for ${variants.join(", ")}`;
    const present = sib.entries.some(
      (e) => e.exports.some((x) => variants.includes(x)) || variants.some((v) => e.summary.includes(v))
    );
    return { repoFullName: fullName, status: present ? "present" : "absent", searched };
  });
}
