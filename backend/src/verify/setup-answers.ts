// Phase 5 answers become lines in .devasign.yml and then commands in the customer's CI, so every
// command is re-derived from the Phase 3 templates and nothing from the request is spliced in.
import type { DevasignVerifyConfig } from "./contract.js";
import { isKnownStartCommand, ROOT_DIR, startCommandFor } from "./boot-inference.js";
import { isPlainDir, pmFor } from "./detect.js";
import { BOOT_TIMEOUT, MAX_SERVERS, RESERVED_SERVER_NAMES } from "./yml.js";

export type SetupAnswers = {
  start?: { dir: string; script: string; port: number };
  servers?: Array<{ dir: string; script: string; port: number; ready?: string }> | "none";
  services?: Array<"postgres" | "mysql" | "redis">;
  env?: string[];
  login?: { script: string; check?: string } | "none";
  e2e?: "auto" | "always" | "never";
  timeout?: number;
};

/** The default branch tree. Given it, a dir must hold a package and a script must exist in it. */
export type SetupAnswersTree = { paths: string[]; files: Record<string, string | null> };

export type SetupAnswersResult = { ok: true; answers: Partial<DevasignVerifyConfig> } | { ok: false; error: string };

export const ANSWER_LIMITS = { servers: MAX_SERVERS, services: 3, env: 50, dir: 64, ready: 200, script: 200, check: 300 };

const ANSWER_KEYS = ["start", "servers", "services", "env", "login", "e2e", "timeout"];
const START_KEYS = ["dir", "script", "port"];
const SERVER_KEYS = ["dir", "script", "port", "ready"];
const LOGIN_KEYS = ["script", "check"];
// Under `e2e: never` the merge still writes an answered key, so it would arm a boot nobody asked for.
const BOOT_ANSWERS = ["start", "servers", "login", "timeout"];

const SERVICES = ["postgres", "mysql", "redis"];
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The runner resolves both of these with new URL(value, the app's url), so a second leading
// slash is not a path: "//evil.example.com/" resolves to that host and the request leaves the box.
const READY_PATH = /^\/(?!\/)[\w\-./]*$/;
const LOGIN_PATH = /^\w[\w./-]*\.(mjs|js|cjs|sh)$/;
const CHECK_URL = /^(\/(?!\/)[\w\-./]*|https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[\w\-./]*)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const ENV_DENIED = new Set(["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV"]);
const ENV_DENIED_PREFIX = ["DEVASIGN_", "GITHUB_", "ACTIONS_", "RUNNER_"];

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
// "__proto__" and "constructor" arrive as own keys from JSON.parse; nothing is read off the prototype.
const pick = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
// The error goes back to the maintainer, so an echoed value carries its shape and nothing else.
const clip = (v: unknown): string => String(v).replace(/[^\w:./-]+/g, " ").trim().slice(0, 60);
const portOk = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535;
const fail = (error: string): SetupAnswersResult => ({ ok: false, error });

function unknownKey(o: Record<string, unknown>, allowed: string[], where: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `${where}: unknown field "${clip(extra)}"`;
}

/** Next reads the port from its own dev script; only vite takes --port --strictPort from us. */
function dependsOnNext(dir: string, tree: SetupAnswersTree): boolean {
  try {
    const pkg = JSON.parse(tree.files[dir === ROOT_DIR ? "package.json" : `${dir}/package.json`] || "") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return !!(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  } catch {
    return false;
  }
}

function serverName(dir: string): string | null {
  const s = dir.toLowerCase().replace(/[_.]/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
  return SERVER_NAME.test(s) && !RESERVED_SERVER_NAMES.has(s) ? s : null;
}

function dirOf(where: string, o: Record<string, unknown>): { dir: string } | { error: string } {
  const dir = pick(o, "dir");
  if (typeof dir !== "string" || dir.length > ANSWER_LIMITS.dir || (dir !== ROOT_DIR && !isPlainDir(dir))) {
    return { error: `${where}.dir must be a package directory such as "frontend" or "."` };
  }
  return { dir };
}

function commandFor(
  where: string,
  dir: string,
  o: Record<string, unknown>,
  port: number | undefined,
  tree: SetupAnswersTree | undefined,
): { cmd: string } | { error: string } {
  const script = pick(o, "script");
  if (typeof script !== "string") return { error: `${where}.script must be a script name from that package.json` };
  const cmd = startCommandFor(tree ? pmFor(dir, tree.paths) : "npm", dir, script, port);
  if (!cmd) return { error: `${where}.script is not a script name: "${clip(script)}"` };
  if (tree && !isKnownStartCommand(cmd, tree.paths, tree.files)) {
    return { error: `${where}: ${clip(dir)} has no "${clip(script)}" script` };
  }
  return { cmd };
}

export function validateSetupAnswers(input: unknown, tree?: SetupAnswersTree): SetupAnswersResult {
  if (input === undefined) return { ok: true, answers: {} };
  const o = record(input);
  if (!o) return fail("answers must be an object");
  const extra = unknownKey(o, ANSWER_KEYS, "answers");
  if (extra) return fail(extra);

  const out: Partial<DevasignVerifyConfig> = {};
  const ports = new Set<number>();

  const e2e = pick(o, "e2e");
  if (e2e !== undefined) {
    if (e2e !== "auto" && e2e !== "always" && e2e !== "never") return fail(`e2e must be "auto", "always" or "never"`);
    out.e2e = e2e;
    const boot = BOOT_ANSWERS.find((k) => pick(o, k) !== undefined);
    if (e2e === "never" && boot) return fail(`${boot} cannot be answered with e2e: "never"`);
  }

  const start = pick(o, "start");
  if (start !== undefined) {
    const s = record(start);
    if (!s) return fail("start must be an object");
    const bad = unknownKey(s, START_KEYS, "start");
    if (bad) return fail(bad);
    const port = pick(s, "port");
    if (!portOk(port)) return fail("start.port must be a whole number between 1024 and 65535");
    const d = dirOf("start", s);
    if ("error" in d) return fail(d.error);
    const built = commandFor("start", d.dir, s, tree && dependsOnNext(d.dir, tree) ? undefined : port, tree);
    if ("error" in built) return fail(built.error);
    ports.add(port);
    out.start = built.cmd;
    out.url = `http://localhost:${port}`;
    out.ready = "/";
  }

  const servers = pick(o, "servers");
  if (servers !== undefined) {
    if (servers !== "none" && !Array.isArray(servers)) return fail(`servers must be a list or "none"`);
    const list = servers === "none" ? [] : servers;
    if (list.length > ANSWER_LIMITS.servers) return fail(`servers: at most ${ANSWER_LIMITS.servers} are supported`);
    const rows: NonNullable<DevasignVerifyConfig["servers"]> = [];
    const names = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const where = `servers[${i}]`;
      const s = record(list[i]);
      if (!s) return fail(`${where} must be an object`);
      const bad = unknownKey(s, SERVER_KEYS, where);
      if (bad) return fail(bad);
      const port = pick(s, "port");
      if (!portOk(port)) return fail(`${where}.port must be a whole number between 1024 and 65535`);
      if (ports.has(port)) return fail(`${where}.port ${port} is already taken by another process`);
      const d = dirOf(where, s);
      if ("error" in d) return fail(d.error);
      const built = commandFor(where, d.dir, s, undefined, tree);
      if ("error" in built) return fail(built.error);
      const name = serverName(d.dir);
      if (!name) return fail(`${where}.dir cannot be used as a server name`);
      if (names.has(name)) return fail(`${where}.dir repeats the server name "${name}"`);
      // An absent `ready` waits on the root, as inference does; an answered one is never null.
      const ready = pick(s, "ready");
      if (ready !== undefined && (typeof ready !== "string" || ready.length > ANSWER_LIMITS.ready || !READY_PATH.test(ready) || ready.includes(".."))) {
        return fail(`${where}.ready must be a path on that server such as "/health"`);
      }
      names.add(name);
      ports.add(port);
      rows.push({ name, start: built.cmd, url: `http://localhost:${port}`, ready: ready ?? "/" });
    }
    out.servers = rows;
  }

  const services = pick(o, "services");
  if (services !== undefined) {
    if (!Array.isArray(services)) return fail("services must be a list");
    if (services.length > ANSWER_LIMITS.services) return fail(`services: at most ${ANSWER_LIMITS.services} are supported`);
    const names: NonNullable<DevasignVerifyConfig["services"]> = [];
    for (let i = 0; i < services.length; i++) {
      const v = services[i];
      if (typeof v !== "string" || !SERVICES.includes(v)) return fail(`services[${i}] must be "postgres", "mysql" or "redis"`);
      if (!names.some((n) => n.name === v)) names.push({ name: v as "postgres" | "mysql" | "redis" });
    }
    out.services = names;
  }

  const env = pick(o, "env");
  if (env !== undefined) {
    if (!Array.isArray(env)) return fail("env must be a list of variable names");
    if (env.length > ANSWER_LIMITS.env) return fail(`env: at most ${ANSWER_LIMITS.env} names are supported`);
    const names: string[] = [];
    for (let i = 0; i < env.length; i++) {
      const v = env[i];
      if (typeof v !== "string" || !ENV_NAME.test(v)) return fail(`env[${i}] must be a variable name such as "STRIPE_KEY"`);
      if (ENV_DENIED.has(v) || ENV_DENIED_PREFIX.some((p) => v.startsWith(p))) return fail(`env[${i}]: ${v} cannot be passed through`);
      if (!names.includes(v)) names.push(v);
    }
    out.env = names;
  }

  const login = pick(o, "login");
  if (login !== undefined) {
    if (login === "none") out.login = {};
    else {
      const l = record(login);
      if (!l) return fail(`login must be an object or "none"`);
      const bad = unknownKey(l, LOGIN_KEYS, "login");
      if (bad) return fail(bad);
      const script = pick(l, "script");
      if (typeof script !== "string" || script.length > ANSWER_LIMITS.script || !LOGIN_PATH.test(script) || script.includes("..")) {
        return fail(`login.script must be a path in the repository such as "scripts/login.mjs", or "none"`);
      }
      if (tree && !tree.paths.includes(script)) return fail(`login.script: the repository has no ${clip(script)}`);
      const value: NonNullable<DevasignVerifyConfig["login"]> = { script: `${script.endsWith(".sh") ? "bash" : "node"} ./${script}` };
      const check = pick(l, "check");
      if (check !== undefined) {
        const port = typeof check === "string" ? /^https?:\/\/[^/]*:(\d{1,5})\//.exec(check)?.[1] : undefined;
        if (
          typeof check !== "string" ||
          check.length > ANSWER_LIMITS.check ||
          !CHECK_URL.test(check) ||
          check.includes("..") ||
          (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
        ) {
          return fail(`login.check must be a path or a localhost URL such as "http://localhost:8787/api/me"`);
        }
        value.check = check;
      }
      out.login = value;
    }
  }

  const timeout = pick(o, "timeout");
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < BOOT_TIMEOUT.min || timeout > BOOT_TIMEOUT.max) {
      return fail(`timeout must be a whole number of seconds between ${BOOT_TIMEOUT.min} and ${BOOT_TIMEOUT.max}`);
    }
    out.timeout = timeout;
  }

  return { ok: true, answers: out };
}

/** An answered key is present; a key the maintainer cleared is present and empty. */
export function clearedAnswer(answers: Partial<DevasignVerifyConfig>, key: "servers" | "services" | "login"): boolean {
  const v = answers[key] as unknown;
  return Object.hasOwn(answers, key) && !!v && typeof v === "object" && Object.keys(v).length === 0;
}
