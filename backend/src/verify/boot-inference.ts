// Boot config for repos whose app lives at the root or in a nested directory
// (frontend/, backend/). Every command is re-derived from a template here and validated
// against the tree, so no model output, diff or runner string can become part of a shell command.
import type { DevasignVerifyConfig } from "./contract.js";
import { isPlainDir, nestedPackageDirs, PLAIN_DIR, pmFor, type BootPm } from "./detect.js";
import { RESERVED_SERVER_NAMES } from "./yml.js";

export { PLAIN_DIR };
export type { BootPm };

export type BootPackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

/** The repo root as a package directory: the app is the repository, with no prefix to run it under. */
export const ROOT_DIR = ".";

export type BootCandidates = {
  webApp: { dir: string; framework: "vite" | "next"; port: number } | null;
  servers: Array<{ dir: string; name: string; script: string; port: number }>;
  loginScript: string | null;
  ambiguousWebApps: string[];
  eligibleDirs: string[];
};

const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOGIN_PATH = /^scripts\/devasign-login\.(mjs|js|cjs|sh)$/;
const LOGIN_CMD = /^(?:node|bash) \.\/scripts\/devasign-login\.(?:mjs|js|cjs|sh)$/;
const START_CMD =
  /^(?:npm --prefix (\S+) run (\S+)|pnpm --dir (\S+) run (\S+)|yarn --cwd (\S+) run (\S+)|bun run --cwd (\S+) (\S+)|npm run (\S+)|pnpm run (\S+)|yarn run (\S+)|bun run (\S+))(?: -- --port (\d+) --strictPort)?$/;
const NESTED_FORMS: Array<[BootPm, number]> = [["npm", 1], ["pnpm", 3], ["yarn", 5], ["bun", 7]];
const ROOT_FORMS: Array<[BootPm, number]> = [["npm", 9], ["pnpm", 10], ["yarn", 11], ["bun", 12]];
const PORT_GROUP = 13;
// A dev/start script that builds, tests or lints does not serve the app, whatever it is called.
const NOT_A_START = /(?:^|[\s&|;(])(?:tsc|eslint|prettier|jest|vitest|mocha|ava|cypress|playwright|storybook)\b|\sbuild\b(?![/\\])/;
const TEST_SUFFIXES = ["e2e", "ci", "ephemeral", "mock"];
const PREFERRED_WEB_DIRS = ["frontend", "web", "app", "client"];
const SERVER_DEPS = ["express", "fastify", "koa", "hono"];
const CONFIG_NAMES = [
  "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs",
  "next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs",
];
const ENV_NAMES = [".env.example", ".env.test"];
const MAX_DIRS = 12;
const MAX_SERVERS = 4;
const DEFAULT_PORT = { vite: 5173, next: 3000 } as const;

const portOk = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65535;

function parsePkg(text: string | null | undefined): BootPackageJson | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? (j as BootPackageJson) : null;
  } catch {
    return null;
  }
}

const hasDep = (pkg: BootPackageJson, name: string) => !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);

const isServerPackage = (pkg: BootPackageJson) =>
  SERVER_DEPS.some((d) => hasDep(pkg, d)) ||
  [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})].some((d) => d.startsWith("@nestjs/"));

/** A file of one package: the root package owns the path itself, with no directory prefix. */
const at = (dir: string, name: string) => (dir === ROOT_DIR ? name : `${dir}/${name}`);

/** Every package CI installs: the root manifest, which is always installed, then the top-level ones. */
const packageDirs = (paths: string[]) =>
  paths.includes("package.json") ? [ROOT_DIR, ...nestedPackageDirs(paths)] : nestedPackageDirs(paths);

function configPathFor(dir: string, paths: string[]): string | null {
  for (const name of CONFIG_NAMES) if (paths.includes(at(dir, name))) return at(dir, name);
  return null;
}

/** The only shape a start command ever takes. null when any part fails validation. */
export function startCommandFor(pm: BootPm, dir: string, script: string, port?: number): string | null {
  const root = dir === ROOT_DIR;
  // "." is the repository itself, never an argument: it gets its own form rather than
  // being spelled as a directory, and every other name still goes through the charset gate.
  if (!root && !isPlainDir(dir)) return null;
  if (!SCRIPT_NAME.test(script)) return null;
  if (port !== undefined && !portOk(port)) return null;
  const base =
    pm === "pnpm" ? (root ? `pnpm run ${script}` : `pnpm --dir ${dir} run ${script}`)
    : pm === "yarn" ? (root ? `yarn run ${script}` : `yarn --cwd ${dir} run ${script}`)
    : pm === "bun" ? (root ? `bun run ${script}` : `bun run --cwd ${dir} ${script}`)
    : root ? `npm run ${script}`
    : `npm --prefix ${dir} run ${script}`;
  return port === undefined ? base : `${base} -- --port ${port} --strictPort`;
}

/** Extra repo paths job.ts must read before calling inferBootCandidates. */
export function inferenceFilesFor(paths: string[]): string[] {
  const out: string[] = [];
  if (paths.includes("pnpm-workspace.yaml")) out.push("pnpm-workspace.yaml");
  if (paths.includes(".node-version")) out.push(".node-version");
  // The root manifest and env files are read anyway; its vite/next config is not.
  const rootCfg = paths.includes("package.json") ? configPathFor(ROOT_DIR, paths) : null;
  if (rootCfg) out.push(rootCfg);
  for (const dir of nestedPackageDirs(paths).slice(0, MAX_DIRS)) {
    out.push(`${dir}/package.json`);
    const cfg = configPathFor(dir, paths);
    if (cfg) out.push(cfg);
    // What port the package says it listens on: the only evidence that ties a proxy
    // target to the package that serves it.
    for (const name of ENV_NAMES) if (paths.includes(`${dir}/${name}`)) out.push(`${dir}/${name}`);
  }
  return out;
}

function globRe(pattern: string): RegExp {
  const src = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${src}$`);
}

function workspacePatterns(files: Record<string, string | null>): string[] {
  const root = parsePkg(files["package.json"]);
  const ws = root?.workspaces;
  const declared = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  const pnpm = [...(files["pnpm-workspace.yaml"] || "").matchAll(/^\s*-\s*['"]?([^'"\s#]+)/gm)].map((m) => m[1]);
  return [...declared, ...pnpm].filter((p) => typeof p === "string" && p.length > 0 && p.length < 100).slice(0, 50);
}

function workflowInstalls(dir: string, texts: string[]): boolean {
  const d = dir.replace(/[.+^${}()|[\]\\*?-]/g, "\\$&");
  const re = new RegExp(`(?:--prefix|--dir|--cwd)\\s+\\.?/?${d}(?![\\w./-])|working-directory:\\s*\\.?/?${d}(?![\\w./-])`);
  return texts.some((t) => re.test(t || ""));
}

/** Whether a workflow reacts to pull requests — a deploy or release file says nothing about PR CI. */
export function runsOnPullRequest(text: string | null | undefined): boolean {
  const src = text || "";
  const m = /^(?:on|"on"|'on')\s*:(.*)$/m.exec(src);
  if (!m) return false;
  const after = src.slice(m.index + m[0].length);
  return /\bpull_request(?:_target)?\b/.test(m[1] + "\n" + (after.split(/\n(?=\S)/)[0] ?? ""));
}

/** JS source with its comments blanked out; string and template literals are left intact. */
function stripComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    // Outside a quote a bare backslash only occurs inside a regex literal, so consuming what
    // it escapes is safe — and stops the `\/` closing `/^~\//` from opening a line comment.
    if (c === "\\") {
      out += c + (text[++i] ?? "");
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

/** Brace depth at `index`, counting only braces outside string literals. */
function depthAt(src: string, index: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

// The shallowest `server:` is the exported config's own: vitest's `test.server` and a
// plugin option of that name sit deeper, and shadowing costs both the port and the servers.
/** The `server: { … }` literal of a vite config, comments removed. */
function serverBlock(text: string | null | undefined): string | null {
  if (!text) return null;
  const src = stripComments(text);
  const found = [...src.matchAll(/\bserver\s*:\s*\{/g)].map((m) => ({ index: m.index, length: m[0].length, depth: depthAt(src, m.index) }));
  if (!found.length) return null;
  const shallowest = Math.min(...found.map((f) => f.depth));
  const m = found.filter((f) => f.depth === shallowest).pop()!;
  const start = m.index + m.length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length && i < start + 8000; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** The dev-server port a vite config pins, at the top level of its server block. */
export function readVitePort(text: string | null | undefined): number | null {
  const block = serverBlock(text);
  if (!block) return null;
  for (const m of block.matchAll(/\bport\s*:\s*(\d+)/g)) {
    // `hmr: { port }` and a proxy target's own port are not the dev-server port.
    if (depthAt(block, m.index) !== 1) continue;
    const n = Number(m[1]);
    return portOk(n) ? n : null;
  }
  return null;
}

/** An explicit `--port`/`-p` in a script, which beats whatever a config file says. */
function scriptPort(script: string | undefined): number | null {
  const m = /(?:^|\s)(?:-p|--port)[=\s](\d+)(?=\s|$)/.exec(script || "");
  const n = m ? Number(m[1]) : NaN;
  return portOk(n) ? n : null;
}

/** Localhost ports the web app's dev proxy points at, excluding its own. */
function proxyPorts(framework: "vite" | "next", text: string | null, ownPort: number): number[] {
  const scope = framework === "vite" ? serverBlock(text) : text && stripComments(text);
  if (!scope) return [];
  const out = new Set<number>();
  for (const m of scope.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)) {
    const n = Number(m[1]);
    if (n !== ownPort && portOk(n)) out.add(n);
  }
  return [...out];
}

/** The ports a package itself claims: its start script's flags and its own env examples. */
function declaredPorts(dir: string, script: string, files: Record<string, string | null>): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => {
    if (portOk(n)) out.add(n);
  };
  const flag = scriptPort(script);
  if (flag) add(flag);
  for (const m of (script || "").matchAll(/\bPORT\s*=\s*(\d+)/g)) add(Number(m[1]));
  for (const name of ENV_NAMES) {
    for (const m of (files[at(dir, name)] || "").matchAll(/^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*_)?PORT\s*=\s*"?(\d+)/gm)) add(Number(m[1]));
  }
  return out;
}

function slug(dir: string): string | null {
  const s = dir.toLowerCase().replace(/[_.]/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
  // A reserved name is dropped by the runner's own parser, so pairing one here would
  // promise a server that never starts.
  return SERVER_NAME.test(s) && !RESERVED_SERVER_NAMES.has(s) ? s : null;
}

const runnable = (scripts: Record<string, string>, name: string) =>
  typeof scripts[name] === "string" && scripts[name].trim().length > 0 && SCRIPT_NAME.test(name) && !NOT_A_START.test(scripts[name]);

/** dev:e2e/start:ci… first, then dev, then start. Never a script whose command builds, tests or lints. */
function serverScript(scripts: Record<string, string>): string | null {
  for (const suffix of TEST_SUFFIXES) for (const prefix of ["dev", "start"]) {
    const name = `${prefix}:${suffix}`;
    if (runnable(scripts, name)) return name;
  }
  for (const name of ["dev", "start"]) if (runnable(scripts, name)) return name;
  return null;
}

type Candidate = { dir: string; pkg: BootPackageJson; scripts: Record<string, string>; configText: string | null };

export function inferBootCandidates(args: {
  paths: string[];
  files: Record<string, string | null>;
  mode: "separate" | "extend";
  workflowTexts: string[];
}): BootCandidates {
  const { paths, files, mode } = args;
  const dirs = nestedPackageDirs(paths).slice(0, MAX_DIRS);
  const patterns = workspacePatterns(files);
  // Only a pull-request workflow says what CI installs for a PR; a deploy or
  // publish workflow installs whatever it ships, wherever that lives.
  const workflowTexts = args.workflowTexts.filter(runsOnPullRequest);
  const covered = (d: string) => patterns.some((p) => globRe(p).test(d));
  const rootless = !paths.includes("package.json");
  // CI only installs a nested package when we write the workflow ourselves and can add
  // the step, when the root workspaces cover it, or when their own PR CI installs it.
  // A root manifest is installed by every workflow there is, ours and theirs alike.
  const eligibleDirs = [
    ...(rootless ? [] : [ROOT_DIR]),
    ...dirs.filter((d) => mode === "separate" || covered(d) || (rootless && workflowInstalls(d, workflowTexts))),
  ];

  const packages: Candidate[] = [];
  for (const dir of eligibleDirs) {
    const pkg = parsePkg(files[at(dir, "package.json")]);
    if (!pkg) continue;
    const cfg = configPathFor(dir, paths);
    packages.push({ dir, pkg, scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}, configText: cfg ? files[cfg] ?? null : null });
  }

  let pool = packages
    .map((p) => {
      const framework = hasDep(p.pkg, "next") ? "next" : hasDep(p.pkg, "vite") ? "vite" : null;
      if (!framework || !runnable(p.scripts, "dev")) return null;
      // A flag in the dev script wins: it is what the CLI actually binds.
      const port = scriptPort(p.scripts.dev) ?? (framework === "vite" ? readVitePort(p.configText) : null) ?? DEFAULT_PORT[framework];
      return { ...p, framework, port };
    })
    .filter((p): p is Candidate & { framework: "vite" | "next"; port: number } => !!p);

  if (pool.length > 1) {
    // Every workflow installs the root, so it names no directory and wins no tie-break.
    const installed = pool.filter((p) => p.dir !== ROOT_DIR && workflowInstalls(p.dir, workflowTexts));
    if (installed.length) pool = installed;
  }
  if (pool.length > 1) {
    const preferred = pool.filter((p) => PREFERRED_WEB_DIRS.includes(p.dir.toLowerCase()));
    if (preferred.length) pool = preferred;
  }
  if (pool.length > 1) {
    // A root manifest that owns vite for a root vitest workspace is a container, not the app:
    // any nested candidate beats it, whatever that directory happens to be called.
    const nested = pool.filter((p) => p.dir !== ROOT_DIR);
    if (nested.length) pool = nested;
  }
  const web = pool.length === 1 ? pool[0] : null;

  const servers: BootCandidates["servers"] = [];
  if (web) {
    const ports = proxyPorts(web.framework, web.configText, web.port);
    // The root is never a second process: a repo whose only package is the root has
    // nothing else to boot, and one with nested packages serves its API from them.
    const backends = packages
      .filter((p) => p.dir !== web.dir && p.dir !== ROOT_DIR && isServerPackage(p.pkg))
      .map((p) => ({ dir: p.dir, name: slug(p.dir), script: serverScript(p.scripts), scripts: p.scripts }))
      .filter((p): p is { dir: string; name: string; script: string; scripts: Record<string, string> } => !!p.name && !!p.script);
    // One proxy target and one server package is the only pairing we can trust, and only
    // when that package itself names the port: nothing else in the tree says who listens.
    if (ports.length === 1 && backends.length === 1) {
      const b = backends[0];
      if (declaredPorts(b.dir, b.scripts[b.script] ?? "", files).has(ports[0])) servers.push({ dir: b.dir, name: b.name, script: b.script, port: ports[0] });
    }
  }

  const loginPath = paths.find((p) => LOGIN_PATH.test(p));

  return {
    webApp: web ? { dir: web.dir, framework: web.framework, port: web.port } : null,
    servers: servers.slice(0, MAX_SERVERS),
    loginScript: loginPath ? `${loginPath.endsWith(".sh") ? "bash" : "node"} ./${loginPath}` : null,
    ambiguousWebApps: pool.length > 1 ? pool.map((p) => p.dir) : [],
    eligibleDirs,
  };
}

/** The verify-block keys the candidates justify. Never returns env or services. */
export function bootConfigFrom(candidates: BootCandidates, paths: string[], files: Record<string, string | null>): Partial<DevasignVerifyConfig> {
  const dirs = new Set(packageDirs(paths));
  const out: Partial<DevasignVerifyConfig> = {};
  const web = candidates.webApp;
  if (web && dirs.has(web.dir) && portOk(web.port)) {
    // Vite takes the port from us (--strictPort); next reads it from its own dev script.
    const start = startCommandFor(pmFor(web.dir, paths), web.dir, "dev", web.framework === "vite" ? web.port : undefined);
    // Last gate before the command is committed: it must be one we could have written.
    if (start && isKnownStartCommand(start, paths, files)) {
      out.start = start;
      out.url = `http://localhost:${web.port}`;
      out.ready = "/";
    }
  }
  if (out.start) {
    const servers: NonNullable<DevasignVerifyConfig["servers"]> = [];
    for (const s of candidates.servers.slice(0, MAX_SERVERS)) {
      if (!dirs.has(s.dir) || !SERVER_NAME.test(s.name) || RESERVED_SERVER_NAMES.has(s.name) || !portOk(s.port)) continue;
      const start = startCommandFor(pmFor(s.dir, paths), s.dir, s.script);
      if (start && isKnownStartCommand(start, paths, files)) servers.push({ name: s.name, start, url: `http://localhost:${s.port}`, ready: "/" });
    }
    if (servers.length) out.servers = servers;
  }
  if (candidates.loginScript && LOGIN_CMD.test(candidates.loginScript)) out.login = { script: candidates.loginScript };
  return out;
}

/** Exactly the shapes startCommandFor produces, for a script this tree really has. */
export function isKnownStartCommand(cmd: string, paths: string[], files: Record<string, string | null>): boolean {
  const m = START_CMD.exec(cmd);
  if (!m) return false;
  const nested = NESTED_FORMS.find(([, i]) => m[i] !== undefined);
  const form = nested ?? ROOT_FORMS.find(([, i]) => m[i] !== undefined);
  if (!form) return false;
  const [pm, i] = form;
  const dir = nested ? m[i] : ROOT_DIR;
  const script = nested ? m[i + 1] : m[i];
  const port = m[PORT_GROUP] === undefined ? undefined : Number(m[PORT_GROUP]);
  if (!packageDirs(paths).includes(dir) || pmFor(dir, paths) !== pm) return false;
  const scripts = parsePkg(files[at(dir, "package.json")])?.scripts;
  if (!scripts || typeof scripts[script] !== "string") return false;
  return startCommandFor(pm, dir, script, port) === cmd;
}
