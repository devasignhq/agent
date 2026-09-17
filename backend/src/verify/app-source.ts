// What a generated test's author is shown of the code at the PR head, since a name it never saw
// is a guess: for a browser test, the screens the flow passes through — the entry and the
// components it mounts; for a unit or component test, the code it calls and what that imports.
import { posix } from "node:path";
import { isTestPath } from "./detect.js";
import { isRouteModule, routeWindow } from "./app-routes.js";

export type SourceFile = { path: string; content: string; truncated: boolean };

// Characters bind (roughly 35K tokens); the file count only stops a swarm of tiny modules.
export const APP_SOURCE_LIMITS = { files: 60, fileChars: 12_000, totalChars: 140_000, depth: 8 };

const UI_FILE = /\.(tsx|jsx|vue|svelte)$/;
// Above this a route table is a shell with its screens in it, which earns its place on its own.
const ROUTE_TABLE_CHARS = 4_000;
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
type Read = { path: string; content: string };

// Reads each path once, never a test file or vendored code.
function fetcher(tree: ReadonlySet<string>, readFile: Reader) {
  const seen = new Set<string>();
  const take = async (paths: string[], cap = Infinity): Promise<Read[]> => {
    // Deduped before the seen check: two files in one batch often import the same module.
    const fresh = [...new Set(paths)]
      .filter((p) => tree.has(p) && !seen.has(p) && !isTestPath(p) && !p.startsWith(".devasign/") && !p.includes("node_modules/"))
      .slice(0, Math.max(0, cap));
    for (const p of fresh) seen.add(p);
    const read = await Promise.all(fresh.map(async (path) => ({ path, content: await readFile(path) })));
    return read.filter((f): f is Read => typeof f.content === "string");
  };
  return { seen, take };
}

// One budget, spent in the order it is handed files; the file that crosses it is truncated,
// because a half-read screen still names its buttons.
function spender(lim: Limits, reserved = 0) {
  const out: SourceFile[] = [];
  let total = 0;
  let held = reserved;
  const room = (pinned = false) => Math.min(lim.fileChars, lim.totalChars - total - (pinned ? 0 : held));
  const add = (f: Read & { partial?: boolean }, pinned = false): boolean => {
    const fits = room(pinned);
    if (out.length >= lim.files || fits <= 0) return false;
    const truncated = f.content.length > fits || f.partial === true;
    out.push({ path: f.path, content: truncated ? f.content.slice(0, fits) : f.content, truncated });
    total += Math.min(f.content.length, fits);
    if (pinned) held = Math.max(0, held - Math.min(f.content.length, fits));
    return true;
  };
  return { out, add, room };
}

// The files an author is shown, read breadth first within one budget.
function crawler(tree: ReadonlySet<string>, readFile: Reader, lim: Limits) {
  const { take } = fetcher(tree, readFile);
  const { out, add } = spender(lim);
  // Breadth first; false once the budget is spent.
  const crawl = async (start: Read[], follow: (path: string) => boolean): Promise<boolean> => {
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

/**
 * The source a browser test's author is shown, emitted by relevance rather than by breadth: the
 * test's targets, the module holding the app's URLs, the entry and the screens between it and a
 * target, the labels and sample data those import, then whatever screens are left.
 */
export async function appSourceFor(args: { targetFiles: string[]; tree: ReadonlySet<string>; read: Reader; limits?: Limits }): Promise<SourceFile[]> {
  const lim = args.limits ?? APP_SOURCE_LIMITS;
  const { seen, take } = fetcher(args.tree, args.read);
  const isUi = (p: string) => UI_FILE.test(p);
  const order: string[] = [];
  const content = new Map<string, string>();
  const imports = new Map<string, string[]>();
  // Discovery no longer stops when the budget does: nine unrelated screens spent every character
  // before the crawl ever reached routes.ts, so the spec guessed at "/" and hung on /agent.
  const walk = async (start: Read[], follow: (path: string) => boolean) => {
    let frontier = start;
    for (let depth = 0; frontier.length; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        order.push(f.path);
        content.set(f.path, f.content);
        const imp = localImports(f.path, f.content, args.tree);
        imports.set(f.path, imp);
        next.push(...imp.filter(follow));
      }
      if (depth >= lim.depth) break;
      frontier = await take(next, lim.files - seen.size);
    }
  };
  const indexHtml = args.tree.has("index.html") ? await args.read("index.html") : null;
  const entries = entryPaths(args.tree, indexHtml);
  await walk(await take([...args.targetFiles, ...entries], lim.files), isUi);
  const plain = order.flatMap((p) => imports.get(p) ?? []).filter((p) => !isUi(p));
  await walk(await take(plain, lim.files - seen.size), (p) => !isUi(p));

  const claimed = new Set<string>();
  const ranks: string[][] = [];
  const rank = (paths: string[]) => {
    const fresh = paths.filter((p) => content.has(p) && !claimed.has(p));
    for (const p of fresh) claimed.add(p);
    ranks.push(fresh);
    return fresh;
  };
  // Plain modules pulled in transitively — a template's data often sits one import past the
  // module the screen names.
  const plainUnder = (from: string[]): string[] => {
    const out: string[] = [];
    const queue = from.flatMap((p) => imports.get(p) ?? []).filter((p) => !isUi(p));
    const walked = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (walked.has(p) || !content.has(p)) continue;
      walked.add(p);
      if (!claimed.has(p)) out.push(p);
      queue.push(...(imports.get(p) ?? []).filter((q) => !isUi(q)));
    }
    return out;
  };
  const targets = rank(order.filter((p) => args.targetFiles.includes(p)));
  const routeModules = new Set(order.filter((p) => isRouteModule(p, content.get(p)!)));
  rank([...routeModules]);
  const reaching = targets.length ? ancestors(targets, imports) : null;
  const shell = rank(order.filter((p) => entries.includes(p) || (reaching ? reaching.has(p) && isUi(p) : isUi(p))));
  rank(plainUnder([...targets, ...shell]));
  const rest = rank(order.filter(isUi));
  rank(plainUnder(rest));
  // Anything the rules above missed is still worth its characters, and silently dropping a file
  // the crawl paid to read would show up only as a spec guessing at a name.
  rank(order);

  // Twelve changed screens spend the whole budget on their own, and the thousand characters
  // naming the URLs are worth more to a spec than the twelfth screen's last page.
  const pinned = new Set([...routeModules].filter((p) => content.get(p)!.length <= ROUTE_TABLE_CHARS));
  const { out, add, room } = spender(lim, [...pinned].reduce((n, p) => n + content.get(p)!.length, 0));
  let owed = pinned.size;
  for (const p of ranks.flat()) {
    const c = content.get(p)!;
    // Windowed against the room `add` will actually grant, not fileChars: with less of the shared
    // budget left it head-sliced the window and cut off the very <Route> table it had kept.
    const shown = routeModules.has(p) ? routeWindow(c, room(pinned.has(p))) : c;
    if (add({ path: p, content: shown, partial: shown.length < c.length }, pinned.has(p))) {
      if (pinned.has(p)) owed--;
    } else if (!owed) break;
  }
  return out;
}

// Which of the crawled files lead to a target, however deep: the screens a test's flow passes
// through on its way there, told apart from the screens it never opens.
function ancestors(targets: string[], imports: ReadonlyMap<string, string[]>): Set<string> {
  const parents = new Map<string, string[]>();
  for (const [p, imp] of imports) for (const q of imp) parents.set(q, [...(parents.get(q) ?? []), p]);
  const out = new Set<string>();
  const queue = [...targets];
  for (let i = 0; i < queue.length; i++) {
    for (const p of parents.get(queue[i]) ?? []) {
      if (out.has(p)) continue;
      out.add(p);
      queue.push(p);
    }
  }
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

// A `/` opens a regex literal, not a division, after an operator, an opening bracket, a comma or
// `return`. Its brackets are not code: the `)` in `/[)]/` would otherwise close the call early.
function regexEnd(content: string, at: number): number {
  let k = at - 1;
  while (k >= 0 && /\s/.test(content[k])) k--;
  if (k >= 0 && !"(,=:[!&|?{};+-*%<>~^/".includes(content[k]) && !/\breturn$/.test(content.slice(Math.max(0, k - 5), k + 1))) return at;
  let inClass = false;
  for (let j = at + 1; j < content.length && content[j] !== "\n"; j++) {
    const c = content[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j;
  }
  // No closing slash on the line: a division after all.
  return at;
}

function quoteEnd(content: string, at: number): number {
  const quote = content[at];
  let j = at + 1;
  while (j < content.length && content[j] !== quote) j += content[j] === "\\" ? 2 : 1;
  return j;
}

// A template literal runs to its closing backtick, but a `${}` inside it is code that can hold
// strings and templates of its own: read to the next backtick, `${`(`}` ends the literal early.
function templateEnd(content: string, at: number): number {
  for (let j = at + 1; j < content.length; j++) {
    const c = content[j];
    if (c === "\\") j++;
    else if (c === "`") return j;
    else if (c === "$" && content[j + 1] === "{") {
      let depth = 0;
      for (j += 1; j < content.length; j++) {
        const d = content[j];
        if (d === "`") j = templateEnd(content, j);
        else if (d === '"' || d === "'") j = quoteEnd(content, j);
        else if (d === "{") depth++;
        else if (d === "}" && --depth === 0) break;
      }
    }
  }
  return content.length;
}

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
    else if (ch === "/") i = regexEnd(content, i);
    else if (ch === "`") i = templateEnd(content, i);
    else if (ch === '"' || ch === "'") i = quoteEnd(content, i);
    else if ("([{".includes(ch)) depth++;
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
