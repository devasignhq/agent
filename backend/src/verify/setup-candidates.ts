// What the setup panel offers the maintainer to pick from when inference could not decide.
// Every package here is one inferBootCandidates already judged installable, so an answer can
// never name a directory or script the generator would then refuse to build a command for.
import type { RepoVerifyState } from "../types.js";
import { inferBootCandidates, readVitePort, ROOT_DIR, type BootCandidates, type BootPackageJson } from "./boot-inference.js";
import { pmFor, type BootPm } from "./detect.js";

export type SetupCandidates = {
  packages: Array<{
    dir: string;
    pm: BootPm;
    framework: "vite" | "next" | "server" | null;
    scripts: string[];
    port?: number;
    proxyPort?: number;
  }>;
  loginScripts: string[];
  secretNames: string[] | null;
  missingSecrets: string[] | null;
  secretsUrl: string;
};

export const CANDIDATE_LIMITS = { packages: 12, scripts: 40, loginScripts: 10, secrets: 100 } as const;

// Same charset gate startCommandFor applies to a script name: a name it would refuse must
// never be offered as a choice.
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const LOGIN_SCRIPT = /^\w[\w./-]*\.(?:mjs|js|cjs|sh)$/;
const LOGIN_HINT = /(?:^|[_-])(?:login|signin|sign-in|auth|session)/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const CONFIG_NAME = /^(?:vite|next)\.config\.(?:ts|mts|js|mjs|cjs)$/;
const PORT_FLAG = /(?:^|\s)(?:-p|--port)[=\s](\d+)(?=\s|$)/;
const PORT_ENV = /^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*_)?PORT\s*=\s*"?(\d+)/m;
const SERVER_DEPS = ["express", "fastify", "koa", "hono"];
const ENV_NAMES = [".env.example", ".env.test"];

const portOk = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65535;
const at = (dir: string, name: string) => (dir === ROOT_DIR ? name : `${dir}/${name}`);

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

function frameworkOf(pkg: BootPackageJson): "vite" | "next" | "server" | null {
  if (hasDep(pkg, "next")) return "next";
  if (hasDep(pkg, "vite")) return "vite";
  const deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
  return SERVER_DEPS.some((d) => deps.includes(d)) || deps.some((d) => d.startsWith("@nestjs/")) ? "server" : null;
}

function configTextFor(dir: string, paths: string[], files: Record<string, string | null>): string | null {
  const path = paths.find((p) => {
    const rest = dir === ROOT_DIR ? p : p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : null;
    return rest !== null && CONFIG_NAME.test(rest);
  });
  return path ? files[path] ?? null : null;
}

/** What the package says it listens on: its own dev/start flags, its config, then its env examples. */
function portOf(dir: string, pkg: BootPackageJson, framework: string | null, cfg: string | null, files: Record<string, string | null>): number | undefined {
  for (const name of ["dev", "start"]) {
    const cmd = pkg.scripts?.[name] ?? "";
    for (const re of [PORT_FLAG, /\bPORT\s*=\s*(\d+)/]) {
      const m = re.exec(cmd);
      if (m && portOk(Number(m[1]))) return Number(m[1]);
    }
  }
  if (framework === "vite") {
    const p = readVitePort(cfg);
    if (p) return p;
  }
  for (const name of ENV_NAMES) {
    const m = PORT_ENV.exec(files[at(dir, name)] || "");
    if (m && portOk(Number(m[1]))) return Number(m[1]);
  }
  return undefined;
}

// A hint at which port the API answers on, so the servers section starts from a real number.
// The whole config is scanned because vite's server-block parser is private to boot-inference.
function proxyPortOf(cfg: string | null, own: number | undefined): number | undefined {
  for (const m of (cfg || "").matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)) {
    const n = Number(m[1]);
    if (n !== own && portOk(n)) return n;
  }
  return undefined;
}

const scriptPath = (cmd: string | null) => (cmd ? cmd.replace(/^(?:node|bash)\s+\.\//, "") : null);

/** Login-script choices: everything under scripts/, plus login-shaped files anywhere else. */
function loginScriptsFrom(paths: string[], inferred: string | null): string[] {
  const valid = (p: string) => LOGIN_SCRIPT.test(p) && !p.split("/").includes("..");
  const first = scriptPath(inferred);
  const pool = paths.filter((p) => valid(p) && p !== first && (/^scripts\/[^/]+$/.test(p) || LOGIN_HINT.test(p.split("/").pop()!)));
  const hinted = pool.filter((p) => LOGIN_HINT.test(p.split("/").pop()!)).sort();
  const rest = pool.filter((p) => !hinted.includes(p)).sort();
  return [...new Set([...(first && valid(first) ? [first] : []), ...hinted, ...rest])].slice(0, CANDIDATE_LIMITS.loginScripts);
}

/** Inferred picks first, so the cap can only ever drop a package nothing pointed at. */
function packageOrder(c: BootCandidates): string[] {
  const eligible = new Set(c.eligibleDirs);
  const order = [...(c.webApp ? [c.webApp.dir] : []), ...c.servers.map((s) => s.dir), ...c.ambiguousWebApps, ...c.eligibleDirs];
  return [...new Set(order)].filter((d) => eligible.has(d));
}

export function setupCandidates(args: {
  repo: { owner: string; name: string };
  verify: RepoVerifyState | null | undefined;
  tree?: { paths: string[]; files: Record<string, string | null> };
}): SetupCandidates {
  const ob = args.verify?.onboarding;
  const secretsUrl = `https://github.com/${encodeURIComponent(args.repo.owner)}/${encodeURIComponent(args.repo.name)}/settings/secrets/actions`;
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null);
  const missing = names(ob?.missingSecrets);
  // The expected names GitHub did not report missing are the ones it confirmed are there.
  // With no missing list there is nothing to tell present from absent, and a guess is worse than "could not read".
  const present = missing ? (names(ob?.expectedSecrets) ?? []).filter((s) => !missing.includes(s)) : null;
  const secrets = {
    secretNames: present ? present.slice(0, CANDIDATE_LIMITS.secrets) : null,
    missingSecrets: missing ? missing.slice(0, CANDIDATE_LIMITS.secrets) : null,
    secretsUrl,
  };

  if (!args.tree) {
    // No tree means no manifest was read, so no script name can be offered honestly.
    const cached = scriptPath(ob?.candidates?.loginScript ?? null);
    return { packages: [], loginScripts: cached && LOGIN_SCRIPT.test(cached) ? [cached] : [], ...secrets };
  }

  const { paths, files } = args.tree;
  const workflowTexts = paths.filter((p) => WORKFLOW_FILE.test(p)).map((p) => files[p]).filter((t): t is string => typeof t === "string");
  // The mode the setup PR was built in decides which nested packages CI installs at all.
  const candidates = inferBootCandidates({ paths, files, mode: ob?.mode ?? "separate", workflowTexts });
  const server = new Map(candidates.servers.map((s) => [s.dir, s]));

  const packages: SetupCandidates["packages"] = [];
  for (const dir of packageOrder(candidates)) {
    if (packages.length >= CANDIDATE_LIMITS.packages) break;
    const pkg = parsePkg(files[at(dir, "package.json")]);
    if (!pkg) continue;
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const framework = frameworkOf(pkg);
    const cfg = configTextFor(dir, paths, files);
    const port =
      candidates.webApp?.dir === dir ? candidates.webApp.port
      : server.get(dir)?.port ?? portOf(dir, pkg, framework, cfg, files);
    const proxyPort = framework === "vite" || framework === "next" ? proxyPortOf(cfg, port) : undefined;
    packages.push({
      dir,
      pm: pmFor(dir, paths),
      framework,
      scripts: Object.keys(scripts).filter((n) => SCRIPT_NAME.test(n) && typeof scripts[n] === "string" && scripts[n].trim().length > 0).slice(0, CANDIDATE_LIMITS.scripts),
      ...(port === undefined ? {} : { port }),
      ...(proxyPort === undefined ? {} : { proxyPort }),
    });
  }

  return { packages, loginScripts: loginScriptsFrom(paths, candidates.loginScript), ...secrets };
}
