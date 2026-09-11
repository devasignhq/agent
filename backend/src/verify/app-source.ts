// A browser test drives the running app, so its author needs the screens the flow passes
// through — the entry and the components it mounts — or every selector is a guess.
import { posix } from "node:path";
import { isTestPath } from "./detect.js";

export type SourceFile = { path: string; content: string; truncated: boolean };

export const APP_SOURCE_LIMITS = { files: 16, fileChars: 12_000, totalChars: 90_000, depth: 3 };

const UI_FILE = /\.(tsx|jsx|vue|svelte)$/;
const CODE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", ".mjs"];
const ENTRY_CANDIDATES = [
  "src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/index.tsx", "src/index.jsx",
  "app/page.tsx", "app/page.jsx", "src/app/page.tsx", "pages/index.tsx", "pages/index.jsx", "src/pages/index.tsx",
];
const MODULE_SCRIPT = /<script\b[^>]*\bsrc=["']\/?([^"'?#]+\.[cm]?[jt]sx?)["']/gi;
const RELATIVE_FROM = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** The module index.html loads (Vite and friends), else whichever conventional entries the tree has. */
export function entryPaths(tree: ReadonlySet<string>, indexHtml: string | null): string[] {
  const fromHtml = [...(indexHtml ?? "").matchAll(MODULE_SCRIPT)].map((m) => posix.normalize(m[1])).filter((p) => tree.has(p));
  return fromHtml.length ? fromHtml : ENTRY_CANDIDATES.filter((p) => tree.has(p)).slice(0, 1);
}

export function resolveRelative(from: string, spec: string, tree: ReadonlySet<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith("..")) return null;
  // NodeNext sources import "./x.js" for x.ts.
  const stem = base.replace(/\.[cm]?js$/, "");
  for (const p of [base, ...CODE_EXTS.map((e) => stem + e), ...CODE_EXTS.map((e) => `${stem}/index${e}`)]) if (tree.has(p)) return p;
  return null;
}

export function localImports(from: string, content: string, tree: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(RELATIVE_FROM)) {
    const p = resolveRelative(from, m[1], tree);
    if (p) out.add(p);
  }
  return [...out];
}

/** The test's own target files first, then the app from its entry down, breadth first. */
export async function appSourceFor(args: {
  targetFiles: string[];
  tree: ReadonlySet<string>;
  read: (path: string) => Promise<string | null>;
  limits?: typeof APP_SOURCE_LIMITS;
}): Promise<SourceFile[]> {
  const lim = args.limits ?? APP_SOURCE_LIMITS;
  const seen = new Set<string>();
  const out: SourceFile[] = [];
  let total = 0;
  const take = async (paths: string[]) => {
    const fresh = paths.filter((p) => args.tree.has(p) && !seen.has(p) && !isTestPath(p) && !p.startsWith(".devasign/") && !p.includes("node_modules/"));
    for (const p of fresh) seen.add(p);
    const read = await Promise.all(fresh.map(async (path) => ({ path, content: await args.read(path) })));
    return read.filter((f): f is { path: string; content: string } => typeof f.content === "string");
  };
  const indexHtml = args.tree.has("index.html") ? await args.read("index.html") : null;
  let frontier = await take([...args.targetFiles, ...entryPaths(args.tree, indexHtml)]);
  for (let depth = 0; frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      const room = Math.min(lim.fileChars, lim.totalChars - total);
      if (out.length >= lim.files || room <= 0) return out;
      const truncated = f.content.length > room;
      out.push({ path: f.path, content: truncated ? f.content.slice(0, room) : f.content, truncated });
      total += Math.min(f.content.length, room);
      next.push(...localImports(f.path, f.content, args.tree).filter((p) => UI_FILE.test(p)));
    }
    if (depth >= lim.depth) break;
    frontier = await take(next);
  }
  return out;
}
