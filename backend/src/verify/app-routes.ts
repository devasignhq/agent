// The URLs a browser test may open. An author shown only app.tsx reads `path={ROUTE_PATHS.workflow}`
// and never "/workflow", so it guesses "/" — which redirects, and the spec waits out its timeout.
import { codeSpans } from "./code-spans.js";

type Source = { path: string; content: string };

export type AppRoute = { path: string; renders?: string; redirectsTo?: string };

// Enough to show the shape of an app; a 300-route table would crowd out the source itself.
const MAX_ROUTES = 40;
// Under three, a "/foo" is a string that happens to look like a URL, not a URL table.
const TABLE_MIN = 3;

const CODE_FILE = /\.(tsx|ts|jsx|js|mjs|cjs)$/;
const NOT_SOURCE = /\.d\.ts$|\.(test|spec)\.[jt]sx?$/;
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CONST_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=/g;
const ENTRY = /(?:^|[{,])\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')\s*:\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$.]*))/g;
const SCALAR = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$.]*))/;
const ROUTE_TAG = /<Route\b/g;
const PATH_PROP_ANCHOR = /\bpath\s*:/g;
const PATH_ATTR = /\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\})/;
const TO_ATTR = /\bto\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\})/;
const ELEMENT_ATTR = /\belement\s*=\s*\{\s*<\s*([A-Za-z_$][\w$.]*)/;
const COMPONENT_ATTR = /\bComponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)/;
const PATH_PROP = /(?:^|[{,])\s*path\s*:\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$.]*))/;
const ELEMENT_PROP = /\belement\s*:\s*<\s*([A-Za-z_$][\w$.]*)/;
const COMPONENT_PROP = /\bComponent\s*:\s*([A-Za-z_$][\w$]*)/;
// A 6.4 data route names no component at all; its own fields are what make it a route.
const DATA_ROUTE = /\b(?:lazy|loader|errorElement)\s*:/;
const REDIRECT = /^(?:Navigate|Redirect)$/;

// `text` keeps string bodies so values can be read; `code` blanks them too, so a `<Route` or brace
// inside a string cannot steer the scan. Comments are gone from both, being nobody's route.
type Views = { text: string; code: string; depth: Int32Array };

function views(content: string): Views {
  const { code: isCode, literals } = codeSpans(content);
  const inLiteral = new Uint8Array(content.length);
  for (const [open, close] of literals) for (let i = open; i <= close && i < content.length; i++) inLiteral[i] = 1;
  const depth = new Int32Array(content.length);
  let text = "";
  let code = "";
  let level = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const blank = c === "\n" ? "\n" : " ";
    const live = isCode[i] === 1;
    text += live || inLiteral[i] ? c : blank;
    code += live ? c : blank;
    const k = live ? c : " ";
    if (k === "}" || k === "]" || k === ")") level--;
    depth[i] = level;
    if (k === "{" || k === "[" || k === "(") level++;
  }
  return { text, code, depth };
}

// From `from` to the end of the object around it, with anything nested blanked: a parent route
// must not borrow its child's element, nor a table its inner object's keys.
function sameLevel(v: Views, from: number): string {
  const base = v.depth[from];
  let out = "";
  for (let i = from; i < v.code.length; i++) {
    const c = v.code[i];
    if (v.depth[i] < base && (c === "}" || c === "]" || c === ")")) break;
    out += v.depth[i] === base ? v.text[i] : c === "\n" ? "\n" : " ";
  }
  return out;
}

// The whole object holding `at`, not just what follows it: `{ element: <X />, path: "/" }` puts
// the element the other side of the anchor, and a data route's `lazy` may sit anywhere in it.
function objectAround(v: Views, at: number): string {
  const base = v.depth[at];
  for (let i = at - 1; i >= 0 && v.depth[i] >= base - 1; i--) {
    if (v.code[i] === "{" && v.depth[i] === base - 1) return sameLevel(v, i + 1);
  }
  return sameLevel(v, at);
}

// The opening tag's attributes, braces and all: `element={<Navigate to="/x" />}` holds the `/>`
// that would otherwise end the tag three attributes early.
function tagEnd(v: Views, at: number): number {
  let level = 0;
  for (let i = at; i < v.code.length; i++) {
    const c = v.code[i];
    if (c === "{") level++;
    else if (c === "}") level--;
    else if (c === ">" && level === 0) return i + 1;
  }
  return v.code.length;
}

type Decl = { name: string; literal?: string; expr?: string };

// A `"…"` / `'…'` / expression capture triple.
function valueOf(m: RegExpMatchArray, i: number): { literal?: string; expr?: string } {
  const lit = m[i] ?? m[i + 1];
  return lit !== undefined ? { literal: lit } : { expr: m[i + 2] };
}

// Normalised to one expression, so a quoted attribute and a constant's name resolve the same way.
function value(m: RegExpMatchArray | null, i: number): string | undefined {
  if (!m) return undefined;
  const { literal, expr } = valueOf(m, i);
  return literal !== undefined ? JSON.stringify(literal) : expr;
}

function declarations(v: Views): Decl[] {
  const out: Decl[] = [];
  for (const m of v.code.matchAll(CONST_DECL)) {
    // Past the `=` in `text`, not `code`: a blanked string is spaces, and `\s*` would eat the value.
    let at = (m.index ?? 0) + m[0].length;
    while (/\s/.test(v.text[at] ?? "")) at++;
    if (v.code[at] === "{") {
      for (const e of sameLevel(v, at + 1).matchAll(ENTRY)) {
        out.push({ name: `${m[1]}.${e[1] ?? e[2] ?? e[3]}`, ...valueOf(e, 4) });
      }
    } else {
      const s = SCALAR.exec(v.text.slice(at, at + 200));
      if (s) out.push({ name: m[1], ...valueOf(s, 1) });
    }
  }
  return out;
}

// A name is worth reporting only once it reaches a URL literal: DEFAULT_ROUTE is ROUTE_PATHS.agent
// is "/agent", and an author told "DEFAULT_ROUTE" would type that into goto().
function resolve(expr: string | undefined, consts: Map<string, Decl>): string | undefined {
  let e = expr?.trim();
  for (let hop = 0; e && hop < 6; hop++) {
    const lit = /^(["'])([^"']*)\1$/.exec(e);
    if (lit) return lit[2];
    if (!NAME.test(e)) return undefined;
    const d = consts.get(e);
    if (!d) return undefined;
    if (d.literal !== undefined) return d.literal;
    e = d.expr;
  }
  return undefined;
}

type Raw = { at: number; path: string; renders?: string; to?: string };

function scan(v: Views): Raw[] {
  const out: Raw[] = [];
  for (const m of v.code.matchAll(ROUTE_TAG)) {
    const at = m.index ?? 0;
    const chunk = v.text.slice(at, tagEnd(v, at));
    const path = value(PATH_ATTR.exec(chunk), 1);
    if (!path) continue;
    const el = ELEMENT_ATTR.exec(chunk);
    const name = el?.[1] ?? COMPONENT_ATTR.exec(chunk)?.[1];
    const away = name !== undefined && REDIRECT.test(name);
    out.push({ at, path, renders: away ? undefined : name, to: away ? value(TO_ATTR.exec(chunk.slice(el?.index ?? 0)), 1) : undefined });
  }
  for (const m of v.code.matchAll(PATH_PROP_ANCHOR)) {
    const at = m.index ?? 0;
    const fields = objectAround(v, at);
    const path = value(PATH_PROP.exec(fields), 1);
    const el = ELEMENT_PROP.exec(fields);
    const name = el?.[1] ?? COMPONENT_PROP.exec(fields)?.[1];
    // `output: { path: "/dist" }` is not a route; only a sibling element or route field makes it one.
    if (!path || !(name || DATA_ROUTE.test(fields))) continue;
    const away = name !== undefined && REDIRECT.test(name);
    out.push({ at, path, renders: away ? undefined : name, to: away ? value(TO_ATTR.exec(fields.slice(el?.index ?? 0)), 1) : undefined });
  }
  return out.sort((a, b) => a.at - b.at);
}

const param = (s: string): string => s.replace(/^\[+\.{0,3}([^\]]+)\]+$/, ":$1");

function appDirRoute(p: string): string | null {
  const m = /^(?:src\/)?app\/(?:(.*)\/)?page\.[jt]sx?$/.exec(p);
  if (!m) return null;
  const segs = (m[1] ?? "").split("/").filter(Boolean);
  if (segs.includes("api")) return null;
  return "/" + segs.filter((s) => !s.startsWith("(") && !s.startsWith("@")).map(param).join("/");
}

function pagesDirRoute(p: string): string | null {
  const m = /^(?:src\/)?pages\/(.+)\.(?:[jt]sx?|mjs)$/.exec(p);
  if (!m) return null;
  const segs = m[1].split("/");
  if (segs.some((s) => s === "api" || s.startsWith("_"))) return null;
  if (segs[segs.length - 1] === "index") segs.pop();
  return "/" + segs.map(param).join("/");
}

function treeRoutes(tree: ReadonlySet<string>): AppRoute[] {
  const paths = new Set<string>();
  for (const p of tree) {
    if (NOT_SOURCE.test(p) || p.includes("node_modules/")) continue;
    const url = appDirRoute(p) ?? pagesDirRoute(p);
    if (url) paths.add(url);
  }
  return [...paths].sort().map((path) => ({ path }));
}

/** Every URL the app answers, in declaration order, resolved through the constants that name them. */
export function appRoutes(source: readonly Source[], tree: ReadonlySet<string>): AppRoute[] {
  return collect(source, tree).routes;
}

function collect(source: readonly Source[], tree: ReadonlySet<string>): { routes: AppRoute[]; guessed: boolean } {
  const consts = new Map<string, Decl>();
  const scanned: Raw[][] = [];
  for (const f of source) {
    if (!CODE_FILE.test(f.path) || NOT_SOURCE.test(f.path)) continue;
    const v = views(f.content);
    for (const d of declarations(v)) if (!consts.has(d.name)) consts.set(d.name, d);
    scanned.push(scan(v));
  }
  const out: AppRoute[] = [];
  const seen = new Set<string>();
  for (const raws of scanned) {
    for (const r of raws) {
      const path = resolve(r.path, consts);
      // A path that is not a URL ("*", "", a nested child's "detail") sends a spec nowhere.
      if (!path || !path.startsWith("/") || seen.has(path)) continue;
      seen.add(path);
      const redirectsTo = resolve(r.to, consts);
      out.push({ path, ...(r.renders ? { renders: r.renders } : {}), ...(redirectsTo ? { redirectsTo } : {}) });
    }
  }
  const guessed = !scanned.some((raws) => raws.length);
  return { routes: (guessed ? treeRoutes(tree) : out).slice(0, MAX_ROUTES), guessed };
}

/**
 * The app's URLs, for the prompt. Measured: nine of one run's timeouts were specs that opened "/"
 * and waited on a screen that lives at another path.
 */
export function routeLines(source: readonly Source[], tree: ReadonlySet<string>): string[] {
  const { routes, guessed } = collect(source, tree);
  if (!routes.length) return [];
  const line = (r: AppRoute): string =>
    `- ${r.path}${r.redirectsTo ? ` — redirects to ${r.redirectsTo}` : r.renders ? ` — renders ${r.renders}` : ""}`;
  // A tree-derived map is filenames, not URLs — src/pages/BillingSettings.tsx is as likely to be
  // served at /settings/billing — and an author told it was read off the table types it verbatim.
  const lead = guessed
    ? "Guessed from the file tree, not read from a route table — check each against the source below before opening it."
    : "Read off the app's own route table. Open the path the criterion is about — `/` is a route like any other and may only redirect.";
  return ["## URLs in this app", lead, ...routes.map(line)];
}

// Head-first truncation cuts a shell's <Route> table, which sits at the bottom of a long file —
// the one thing a spec author cannot guess. Keep the window holding the most routes instead.
export function routeWindow(content: string, room: number): string {
  if (content.length <= room) return content;
  const raws = scan(views(content));
  const last = raws.length ? raws[raws.length - 1].at : -1;
  if (last < room) return content.slice(0, room);
  // Widest coverage, earliest on a tie: anchored on the first route, one `<Route>` in a guard
  // component above the table pushed the table itself out, for a window holding no route at all.
  const tail = Math.min(Math.max(400, room >> 3), room);
  let best = 0;
  let covered = 0;
  for (let i = 0, j = 0; i < raws.length; i++) {
    while (j < raws.length && raws[j].at + tail <= raws[i].at + room) j++;
    if (j - i > covered) {
      covered = j - i;
      best = i;
    }
  }
  // Snapped back to a line start, never forward: forward skips the route it anchored on, and a
  // window opening mid-token can leave a quote unbalanced and blank the table it was cut to keep.
  const from = Math.min(raws[best].at, content.length - room);
  const start = content.lastIndexOf("\n", from) + 1;
  return content.slice(start, start + room);
}

/** Whether this module defines the app's URL table, so app-source can pin it into what it shows. */
export function isRouteModule(path: string, content: string): boolean {
  if (!CODE_FILE.test(path) || NOT_SOURCE.test(path)) return false;
  const v = views(content);
  if (scan(v).length >= TABLE_MIN) return true;
  const urls = new Map<string, number>();
  for (const d of declarations(v)) {
    if (!d.literal?.startsWith("/")) continue;
    const table = d.name.includes(".") ? d.name.slice(0, d.name.indexOf(".")) : "";
    urls.set(table, (urls.get(table) ?? 0) + 1);
  }
  return [...urls.values()].some((n) => n >= TABLE_MIN);
}
