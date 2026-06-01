// DEVASIGN.md guidance — discovery + hierarchical scoping.
//
// Teams drop DEVASIGN.md files into their repo (the way they'd use AGENTS.md /
// CLAUDE.md) to encode conventions for the review agent. A DEVASIGN.md governs
// only the files under its own directory, and rules compound down the tree:
// the repo-root DEVASIGN.md applies everywhere; frontend/DEVASIGN.md applies
// only under frontend/; frontend/src/DEVASIGN.md only under frontend/src/.
//
// This module holds the two pieces the pipeline needs: a pure resolver that
// maps changed files to the docs that govern them (unit-tested in isolation),
// and a fetcher that reads the docs from the PR's head tree. The LLM step that
// turns scoped docs into findings lives in pipeline.ts.
import { gh } from "../github/app.js";
import { fetchBlob } from "./indexer.js";
import type { Installation, Repository } from "../types.js";

export const DEVASIGN_FILENAME = "DEVASIGN.md";

// Bound the prompt: cap each doc and the number of docs we read so a repo that
// commits an enormous DEVASIGN.md (or hundreds of them) can't blow up the
// review prompt. Tunable; chosen to comfortably hold a real conventions doc.
const PER_DOC_CHAR_CAP = 8_000;
const MAX_DOCS = 15;

export type DevasignDoc = {
  path: string;    // full repo path, e.g. "frontend/DEVASIGN.md"
  content: string; // doc text, capped to PER_DOC_CHAR_CAP
};

// A doc paired with the changed files it governs. `dir` is the directory the
// doc lives in ("" for the repo root) — the scope its rules apply to.
export type DevasignScope = {
  docPath: string;
  dir: string;
  governedFiles: string[];
};

// Directory containing a path. "" for a repo-root file.
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function isDevasignDoc(p: string): boolean {
  return basename(p) === DEVASIGN_FILENAME;
}

// Pure hierarchical resolver. Given every DEVASIGN.md path in the repo and the
// PR's changed paths, return the docs that govern at least one changed file,
// each with the subset of changed files it governs.
//
// A doc at `<dir>/DEVASIGN.md` governs a changed file `f` iff `dir` is the repo
// root ("") or `f` lives under `dir/`. DEVASIGN.md files are never themselves
// "governed" — they're docs, not code under review (doc drift references them
// by path separately). Scopes are returned root-first so the prompt reads
// outermost → innermost.
export function devasignDocsForChangedFiles(
  docPaths: string[],
  changedPaths: string[]
): DevasignScope[] {
  const codeChanges = changedPaths.filter((f) => !isDevasignDoc(f));
  const scopes: DevasignScope[] = [];
  for (const docPath of docPaths) {
    if (!isDevasignDoc(docPath)) continue;
    const dir = dirOf(docPath);
    const prefix = dir === "" ? "" : dir + "/";
    const governedFiles = codeChanges
      .filter((f) => prefix === "" || f.startsWith(prefix))
      .sort();
    if (governedFiles.length) scopes.push({ docPath, dir, governedFiles });
  }
  // Root-first (shallowest dir first), then alphabetical for stable output.
  return scopes.sort(
    (a, b) => a.dir.length - b.dir.length || a.dir.localeCompare(b.dir)
  );
}

// Read every DEVASIGN.md in the repo at the PR head. Uses the same git-tree +
// raw-blob path the indexer uses, so it sees the PR's *proposed* docs: a PR
// that updates its own DEVASIGN.md is judged against the new text (and a doc
// edit that keeps pace with the code won't be flagged as drift).
export async function fetchDevasignDocs(
  repo: Repository,
  install: Installation,
  headSha: string
): Promise<DevasignDoc[]> {
  const tree = await gh<{ tree: Array<{ path: string; type: string; sha: string }> }>(
    install.installationId,
    `/repos/${repo.owner}/${repo.name}/git/trees/${headSha}?recursive=1`
  );
  const docBlobs = tree.tree
    .filter((e) => e.type === "blob" && isDevasignDoc(e.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_DOCS);

  const docs: DevasignDoc[] = [];
  for (const b of docBlobs) {
    try {
      const text = await fetchBlob(repo, install, b.path, b.sha);
      docs.push({ path: b.path, content: text.slice(0, PER_DOC_CHAR_CAP) });
    } catch {
      // A doc that can't be fetched (deleted between events, transient error)
      // is skipped rather than failing the whole guidance pass.
    }
  }
  return docs;
}
