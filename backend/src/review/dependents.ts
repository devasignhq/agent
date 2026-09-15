// Import-graph helpers over the repo index. Stem matching (basename minus
// extension) stands in for a real resolver: it misses barrels and aliases.
import type { RepoIndexEntry } from "../types.js";
import { isTestPath } from "../verify/detect.js";

export type IndexLike = Pick<RepoIndexEntry, "path" | "imports" | "exports" | "summary">;

export function stem(p: string): string {
  return (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
}

export function importsFile(e: IndexLike, definingPath: string): boolean {
  const base = stem(definingPath);
  return e.imports.some((imp) => stem(imp) === base);
}

// Entries that import any target, by file stem or exported symbol name.
export function dependentsOf<T extends IndexLike>(targets: T[], all: T[]): T[] {
  const stems = new Set<string>();
  const targetPaths = new Set<string>();
  for (const t of targets) {
    targetPaths.add(t.path);
    stems.add(stem(t.path));
    for (const ex of t.exports) stems.add(ex);
  }
  return all.filter(
    (e) =>
      !targetPaths.has(e.path) &&
      !isTestPath(e.path) &&
      e.imports.some((imp) => stems.has(stem(imp)))
  );
}

// Resolve an entry's import specifiers to index entries (relative specifiers only).
export function resolvedImports<T extends IndexLike>(entry: T, all: T[]): T[] {
  const byStem = new Map<string, T[]>();
  for (const e of all) {
    const k = stem(e.path);
    byStem.set(k, [...(byStem.get(k) ?? []), e]);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const imp of entry.imports) {
    if (!imp.startsWith(".") && !imp.startsWith("/")) continue;
    for (const e of byStem.get(stem(imp)) ?? []) {
      if (e.path === entry.path || seen.has(e.path)) continue;
      seen.add(e.path);
      out.push(e);
    }
  }
  return out;
}
