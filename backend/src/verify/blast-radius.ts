// Implied criteria from the diff's blast radius: when a route, response shape,
// or exported symbol changes and something in this repo consumes it, the
// consumer must keep working. Deterministic — diff + repo index, no model.
import type { Criterion, RepoIndexEntry } from "../types.js";
import { routeLiterals } from "../review/cross-repo/naming.js";
import { isFrontendPath, isTestPath } from "./detect.js";

export type IndexLike = Pick<RepoIndexEntry, "path" | "imports" | "exports" | "summary">;

const ROUTE_RE =
  /^[+-].*\b(?:router|app|server|api|\w+Router|\w+Routes)\.(get|post|put|patch|delete|use)\s*\(\s*["'`](\/[^"'`\s]*)["'`]/;
const PY_ROUTE_RE = /^[+-].*@(?:app|bp|router|\w+_bp)\.(route|get|post|put|patch|delete)\s*\(\s*["'](\/[^"']*)["']/;
const EXPORT_RE =
  /^[+-]\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

export type ChangedSurface = { kind: "route" | "export"; name: string; path: string; line: string };

/** Routes and exported symbols on +/- lines, with the file each belongs to. */
export function changedSurfaces(diff: string): ChangedSurface[] {
  const out: ChangedSurface[] = [];
  const seen = new Set<string>();
  let path = "";
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      path = f[1].trim();
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || !path || isTestPath(path)) continue;
    let m = ROUTE_RE.exec(line) || PY_ROUTE_RE.exec(line);
    if (m && m[1] !== "use") {
      const name = `${m[1].toUpperCase()} ${m[2]}`;
      if (!seen.has(`route:${name}`)) {
        seen.add(`route:${name}`);
        out.push({ kind: "route", name, path, line: line.slice(0, 200) });
      }
      continue;
    }
    m = EXPORT_RE.exec(line);
    if (m) {
      const key = `export:${path}:${m[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "export", name: m[1], path, line: line.slice(0, 200) });
      }
    }
  }
  return out;
}

function stem(p: string): string {
  return (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
}

function consumersOfRoute(route: string, entries: IndexLike[], definingPath: string): IndexLike[] {
  const literals = routeLiterals(route).filter((l) => l.length > 3);
  if (!literals.length) return [];
  return entries.filter(
    (e) => e.path !== definingPath && !isTestPath(e.path) && literals.some((l) => e.summary.includes(l))
  );
}

function consumersOfExport(name: string, definingPath: string, entries: IndexLike[]): IndexLike[] {
  const base = stem(definingPath);
  return entries.filter((e) => {
    if (e.path === definingPath || isTestPath(e.path)) return false;
    const importsFile = e.imports.some((imp) => stem(imp) === base);
    return importsFile && (e.summary.includes(name) || e.imports.some((imp) => imp.includes(name)));
  });
}

function nextId(existing: Criterion[]): number {
  let n = 0;
  for (const c of existing) {
    const m = /(\d+)$/.exec(c.id);
    if (m && Number(m[1]) > n) n = Number(m[1]);
  }
  return n + 1;
}

export function blastRadiusCriteria(args: {
  diff: string;
  entries: IndexLike[];
  existing: Criterion[];
  max?: number;
}): Criterion[] {
  const max = args.max ?? 3;
  if (!args.entries.length || !args.diff) return [];
  const surfaces = changedSurfaces(args.diff);
  const out: Criterion[] = [];
  const existingText = args.existing.map((c) => c.text.toLowerCase());
  let id = nextId(args.existing);
  for (const s of surfaces) {
    if (out.length >= max) break;
    const consumers =
      s.kind === "route" ? consumersOfRoute(s.name, args.entries, s.path) : consumersOfExport(s.name, s.path, args.entries);
    if (!consumers.length) continue;
    const shown = consumers.slice(0, 3).map((c) => `\`${c.path}\``).join(", ");
    const more = consumers.length > 3 ? ` and ${consumers.length - 3} more` : "";
    const text =
      s.kind === "route"
        ? `Existing consumers of \`${s.name}\` (${shown}${more}) still work correctly after this change.`
        : `Existing callers of \`${s.name}\` from \`${s.path}\` (${shown}${more}) keep working after this change.`;
    if (existingText.some((t) => t.includes(s.name.toLowerCase()) && t.includes("existing"))) continue;
    const ui = consumers.some((c) => isFrontendPath(c.path));
    out.push({
      id: String(id++),
      text,
      met: null,
      evidence: null,
      kind: ui ? "ui" : "code",
      implied: true,
      source: { input: "diff", ref: s.path, excerpt: s.line },
    });
  }
  return out;
}
