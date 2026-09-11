// What a generated test's author is shown of the code at the PR head, since a name it never saw
// is a guess: for a browser test, the screens the flow passes through — the entry and the
// components it mounts; for a unit or component test, the code it calls and what that imports.
import { posix } from "node:path";
import { isTestPath } from "./detect.js";

export type SourceFile = { path: string; content: string; truncated: boolean };

// Characters bind (roughly 35K tokens); the file count only stops a swarm of tiny modules.
export const APP_SOURCE_LIMITS = { files: 60, fileChars: 12_000, totalChars: 140_000, depth: 8 };

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

type Limits = typeof APP_SOURCE_LIMITS;
type Reader = (path: string) => Promise<string | null>;

// The files an author is shown, read breadth first within one budget.
function crawler(tree: ReadonlySet<string>, readFile: Reader, lim: Limits) {
  const seen = new Set<string>();
  const out: SourceFile[] = [];
  let total = 0;
  const take = async (paths: string[]) => {
    // Deduped before the seen check: two files in one batch often import the same module.
    const fresh = [...new Set(paths)].filter((p) => tree.has(p) && !seen.has(p) && !isTestPath(p) && !p.startsWith(".devasign/") && !p.includes("node_modules/"));
    for (const p of fresh) seen.add(p);
    const read = await Promise.all(fresh.map(async (path) => ({ path, content: await readFile(path) })));
    return read.filter((f): f is { path: string; content: string } => typeof f.content === "string");
  };
  const add = (f: { path: string; content: string }): boolean => {
    const room = Math.min(lim.fileChars, lim.totalChars - total);
    if (out.length >= lim.files || room <= 0) return false;
    const truncated = f.content.length > room;
    out.push({ path: f.path, content: truncated ? f.content.slice(0, room) : f.content, truncated });
    total += Math.min(f.content.length, room);
    return true;
  };
  // Breadth first; false once the budget is spent.
  const crawl = async (start: Array<{ path: string; content: string }>, follow: (path: string) => boolean): Promise<boolean> => {
    let frontier = start;
    for (let depth = 0; frontier.length; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        if (!add(f)) return false;
        next.push(...localImports(f.path, f.content, tree).filter(follow));
      }
      if (depth >= lim.depth) break;
      frontier = await take(next);
    }
    return true;
  };
  return { out, take, crawl };
}

/** The test's own target files first, then the screens from the entry down, then the modules they import. */
export async function appSourceFor(args: { targetFiles: string[]; tree: ReadonlySet<string>; read: Reader; limits?: Limits }): Promise<SourceFile[]> {
  const { out, take, crawl } = crawler(args.tree, args.read, args.limits ?? APP_SOURCE_LIMITS);
  const isUi = (p: string) => UI_FILE.test(p);
  const indexHtml = args.tree.has("index.html") ? await args.read("index.html") : null;
  if (!(await crawl(await take([...args.targetFiles, ...entryPaths(args.tree, indexHtml)]), isUi))) return out;
  // Then the plain modules the screens import: labels, templates and sample data live there,
  // and a name the author never saw is still a guess however well it knows the screen.
  const imported = out.flatMap((f) => localImports(f.path, f.content, args.tree)).filter((p) => !isUi(p));
  await crawl(await take(imported), (p) => !isUi(p));
  return out;
}

// A unit or component test calls the code directly, so its author needs that code and what it
// leans on — the constants, types and contexts it imports — rather than the screens around it.
export const UNIT_SOURCE_LIMITS: Limits = { files: 16, fileChars: 12_000, totalChars: 48_000, depth: 2 };

/**
 * The runner's config — whether it names a DOM environment or a setup file decides what the test
 * must declare itself — then the test's target files and what they import, two levels down.
 */
export async function sourceUnderTest(args: { targetFiles: string[]; config?: string; tree: ReadonlySet<string>; read: Reader; limits?: Limits }): Promise<SourceFile[]> {
  const { out, take, crawl } = crawler(args.tree, args.read, args.limits ?? UNIT_SOURCE_LIMITS);
  await crawl(await take([...(args.config ? [args.config] : []), ...args.targetFiles]), () => true);
  return out;
}

const STARTER = /(templates?|samples?|examples?|presets?|demos?|fixtures?|starters?|seeds?)/i;
const EXPORTED = /export\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
const STORAGE_KEY = /localStorage\.(?:setItem|getItem)\(\s*['"]([^'"]+)['"]/g;

// zustand's `persist(creator, { name })`. A block-bodied creator, a trailing comma and look-alike
// `{ name }` objects defeat a single regex, so walk the call's top-level arguments instead.
export function persistKey(content: string): string | undefined {
  const at = content.search(/\bpersist\s*\(/);
  if (at < 0) return undefined;
  const args: string[] = [];
  let depth = 0;
  let start = content.indexOf("(", at) + 1;
  for (let i = start - 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === "/" && content[i + 1] === "/") i = content.indexOf("\n", i) < 0 ? content.length : content.indexOf("\n", i);
    else if (ch === "/" && content[i + 1] === "*") i = content.indexOf("*/", i + 2) < 0 ? content.length : content.indexOf("*/", i + 2) + 1;
    else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < content.length && content[j] !== ch) j += content[j] === "\\" ? 2 : 1;
      i = j;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) {
      args.push(content.slice(start, i));
      break;
    } else if (ch === "," && depth === 1) {
      args.push(content.slice(start, i));
      start = i + 1;
    }
  }
  const options = args.filter((a) => a.trim()).at(-1) ?? "";
  return /^\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/.exec(options)?.[1];
}

/**
 * Built-in data and saved state a browser test can start from, found in the source it is shown.
 * Buried among forty files, a template menu reads as one screen of many; listed, it is a way in.
 */
export function waysIn(source: readonly SourceFile[], tree: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of source) {
    const names = UI_FILE.test(f.path) ? [] : [...f.content.matchAll(EXPORTED)].map((m) => m[1]).filter((n) => STARTER.test(n));
    if (names.length) {
      const importers = source.filter((s) => s.path !== f.path && localImports(s.path, s.content, tree).includes(f.path));
      const shownBy = importers.filter((s) => UI_FILE.test(s.path)).map((s) => s.path);
      // With no screen importing it, say what does: sample data often reaches the page only
      // through a template, and a test that assumes it loads by default starts from nothing.
      const via = shownBy.length
        ? ` — shown by ${shownBy.join(", ")}`
        : importers.length
          ? ` — used by ${importers.map((s) => s.path).join(", ")}, not by any screen directly`
          : "";
      out.push(`\`${names.join("`, `")}\` in ${f.path}${via}`);
    }
    const persisted = persistKey(f.content);
    if (persisted) out.push(`${f.path} persists its store under "${persisted}" (zustand \`persist\`)`);
    const keys = [...new Set([...f.content.matchAll(STORAGE_KEY)].map((m) => m[1]))];
    if (keys.length) out.push(`${f.path} reads or writes localStorage ${keys.map((k) => `"${k}"`).join(", ")}`);
  }
  if (!out.length) return [];
  return ["## Ways into a populated state", "Found in the source below. Start from one of these unless a criterion is about building that data itself.", ...out.map((w) => `- ${w}`)];
}
