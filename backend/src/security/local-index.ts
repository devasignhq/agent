// Builds RepoIndexEntry rows for a directory on disk, so the audit pipeline can
// be run over a local tree with no GitHub and no indexer job. Paths are relative
// to the tree root: isTestPath and isStructurallySensitivePath both read paths,
// so a row carrying a checkout-absolute path would score differently from prod.
import { createHash } from "node:crypto";
import type { RepoIndexEntry } from "../types.js";
import { IMPORT_LEAD } from "../verify/imports.js";
import { computeStaticSecurityFlags } from "./static-flags.js";

const SPECIFIER = new RegExp(`(?:${IMPORT_LEAD})(['"\`])([^'"\`\\n]+)\\1`, "g");
const EXPORTED = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:function|class|const|let|var|type|interface|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;

export function blobSha(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

// Relative specifiers only, as written — resolvedImports (review/dependents.ts)
// ignores bare ones, so recording them would not change any bundle.
export function parseRelativeImports(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(SPECIFIER)) {
    const spec = m[2];
    if (spec.startsWith(".") || spec.startsWith("/")) out.add(spec);
  }
  return [...out];
}

export function parseExports(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(EXPORTED)) out.add(m[1]);
  for (const m of content.matchAll(/^[ \t]*export[ \t]*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
};

export type LocalFile = { path: string; content: string };

// `summary` and `securityFlags` are the summariser's, not ours: an eval that wants
// prod parity passes `summarise`, and one running offline leaves them empty (the
// candidate gate still fires on staticFlags and the path rules).
export async function buildLocalIndex(
  repoId: string,
  files: LocalFile[],
  summarise?: (
    file: LocalFile
  ) => Promise<{ summary: string; exports: string[]; imports: string[]; securityFlags: string[] } | null>
): Promise<RepoIndexEntry[]> {
  const out: RepoIndexEntry[] = [];
  for (const file of files) {
    const summarised = summarise ? await summarise(file) : null;
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    out.push({
      id: `local-${blobSha(`${repoId}:${file.path}`).slice(0, 16)}`,
      repoId,
      path: file.path,
      sha: blobSha(file.content),
      size: Buffer.byteLength(file.content, "utf8"),
      language: LANG[ext] ?? ext ?? "",
      summary: summarised?.summary ?? "",
      exports: summarised?.exports ?? parseExports(file.content),
      imports: summarised?.imports ?? parseRelativeImports(file.content),
      securityFlags: summarised?.securityFlags ?? [],
      staticFlags: computeStaticSecurityFlags(file.path, file.content),
      indexedAt: 0,
      model: summarise ? "summariser" : "static",
    } as RepoIndexEntry);
  }
  return out;
}
