// Managed boot: setup steps, every server and the primary app in their own process
// groups, then an optional login script whose saved session browser tests start with.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import type { DevasignVerifyConfig, DoctorDiagnosis } from "./types.js";
import { BOOT_TIMEOUT, RESERVED_SERVER_NAMES } from "./yml.js";

export type StorageState = {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }>; indexedDB?: unknown[] }>;
};
export type BootStep = { name: string; kind: "setup" | "server"; cmd: string; url?: string; readyUrl?: string; timeoutMs: number };
export type BootSpec = { steps: BootStep[]; baseUrl: string; login: { script: string; check?: string; timeoutMs: number } | null };
export type BootHandle = { stop(): Promise<void>; logFiles: string[] };
// What each step did, for the boot probe's report; a step the boot never reached has no entry.
export type BootStepResult = { name: string; kind: "setup" | "server"; ok: boolean; readyMs?: number; exitCode?: number | null };
export type BootCheck = { status: number | null; cors?: "ok" | "missing" | "mismatch" };

const LOGIN_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 5_000;
const CHECK_WINDOW_MS = 10_000;

export function bootSpec(yml: DevasignVerifyConfig): BootSpec | null {
  if (!yml.start || !yml.url) return null;
  const secs = Number.isInteger(yml.timeout) ? Math.min(BOOT_TIMEOUT.max, Math.max(BOOT_TIMEOUT.min, yml.timeout!)) : BOOT_TIMEOUT.default;
  const timeoutMs = secs * 1000;
  const steps: BootStep[] = [];
  for (const name of ["install", "build", "seed"] as const) {
    const cmd = yml[name];
    if (cmd) steps.push({ name, kind: "setup", cmd, timeoutMs });
  }
  const server = (name: string, cmd: string, url: string, ready?: string): BootStep => ({ name, kind: "server", cmd, url, readyUrl: resolveUrl(ready, url), timeoutMs });
  const seen = new Set<string>();
  // A server sharing a step's name would share its log file too.
  for (const s of yml.servers || []) {
    if (RESERVED_SERVER_NAMES.has(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    steps.push(server(s.name, s.start, s.url, s.ready));
  }
  steps.push(server("app", yml.start, yml.url, yml.ready));
  const script = yml.login?.script;
  return { steps, baseUrl: yml.url, login: script ? { script, ...(yml.login?.check ? { check: yml.login.check } : {}), timeoutMs: LOGIN_TIMEOUT_MS } : null };
}

function resolveUrl(ref: string | undefined, base: string): string {
  if (!ref) return base;
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

type Proc = { name: string; child: ChildProcess; pid?: number; exited: boolean; exit: Promise<void>; gone: boolean };

const group = process.platform !== "win32";
const live = new Set<Proc>();
// Session directories a login wrote, removed on every way out of the process.
const authDirs = new Set<string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function groupAlive(p: Proc): boolean {
  if (p.gone || !p.pid) return false;
  if (!group) return !p.exited;
  try {
    process.kill(-p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(p: Proc, sig: NodeJS.Signals): void {
  try {
    if (group && p.pid) process.kill(-p.pid, sig);
    else p.child.kill(sig);
  } catch {
    // already gone
  }
}

function removeAuthDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort on the way out
  }
}

const onExit = () => {
  for (const p of live) signalGroup(p, "SIGKILL");
  for (const dir of authDirs) removeAuthDir(dir);
};
const onSigint = () => void stopAll().finally(() => process.exit(130));
const onSigterm = () => void stopAll().finally(() => process.exit(143));

let guarded = false;
function syncGuards(): void {
  const need = live.size > 0 || authDirs.size > 0;
  if (need === guarded) return;
  guarded = need;
  if (need) {
    process.on("exit", onExit);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  } else {
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function track(p: Proc): void {
  live.add(p);
  syncGuards();
}

function untrack(p: Proc): void {
  if (live.delete(p)) syncGuards();
}

async function stopProcs(procs: Proc[]): Promise<void> {
  const running = procs.filter((p) => live.has(p));
  for (const p of running) if (groupAlive(p)) signalGroup(p, "SIGTERM");
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (running.some((p) => groupAlive(p) || !p.exited) && Date.now() < until) await sleep(50);
  };
  await waitGone(STOP_GRACE_MS);
  for (const p of running) if (groupAlive(p)) signalGroup(p, "SIGKILL");
  await waitGone(2_000);
  for (const p of running) {
    p.gone = true;
    untrack(p);
  }
}

const stopAll = () => stopProcs([...live]);

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // BROWSER=none is the escape hatch vite and CRA both honour: `server.open: true` in their
  // own config would otherwise have CI try to launch a browser we then have to kill.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, CI: "true", FORCE_COLOR: "0", BROWSER: "none" };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  return env;
}

function launch(name: string, cmd: string, cwd: string, logFile: string, env: NodeJS.ProcessEnv): Proc {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "w");
  let child: ChildProcess;
  try {
    writeSync(fd, `$ ${cmd}\n\n`);
    child = spawn("sh", ["-c", cmd], { cwd, env, detached: group, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const p: Proc = { name, child, pid: child.pid, exited: false, gone: false, exit: Promise.resolve() };
  p.exit = new Promise<void>((resolve) => {
    const done = () => {
      p.exited = true;
      if (!groupAlive(p)) {
        p.gone = true;
        untrack(p);
      }
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  if (!p.pid) p.exited = true;
  else track(p);
  return p;
}

async function runToExit(p: Proc, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([p.exit.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs)))]);
  clearTimeout(timer);
  if (timedOut) {
    await stopProcs([p]);
    return { code: null, timedOut: true };
  }
  return { code: p.child.exitCode ?? (p.pid ? null : 127), timedOut: false };
}

const SETUP_DIAG: Record<string, Pick<DoctorDiagnosis, "stage" | "code">> = {
  install: { stage: "install", code: "install_failed" },
  build: { stage: "build", code: "install_failed" },
  seed: { stage: "services", code: "unknown" },
};

function makeHandle(procs: Proc[], logFiles: string[]): BootHandle {
  let stopping: Promise<void> | null = null;
  return { logFiles, stop: () => (stopping ??= stopProcs(procs)) };
}

export async function startApp(
  spec: BootSpec,
  ws: { root: string; artifactsDir: string },
  deps: { fetchImpl?: typeof fetch; pollMs?: number } = {}
): Promise<
  | { ok: true; handle: BootHandle; steps: BootStepResult[] }
  | { ok: false; handle: BootHandle; diagnosis: DoctorDiagnosis; failedStep: string; steps: BootStepResult[] }
> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollMs = deps.pollMs ?? 500;
  const procs: Proc[] = [];
  const logFiles: string[] = [];
  const handle = makeHandle(procs, logFiles);
  const env = childEnv();
  const steps: BootStepResult[] = [];
  const done = (step: BootStep, ok: boolean, extra: Omit<BootStepResult, "name" | "kind" | "ok"> = {}) => {
    steps.push({ name: step.name, kind: step.kind, ok, ...extra });
  };
  const fail = async (step: BootStep, diagnosis: DoctorDiagnosis) => {
    await handle.stop();
    return { ok: false as const, handle, diagnosis, failedStep: step.name, steps };
  };
  for (const step of spec.steps) {
    const logFile = path.resolve(ws.artifactsDir, "logs", `boot-${step.name}.log`);
    const secs = Math.round(step.timeoutMs / 1000);
    // Tests must never run against a leftover or foreign server that happens to hold the port.
    if (step.kind === "server" && step.url && URL.canParse(step.url) && (await answers(fetchImpl, step.url))) {
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
        writeFileSync(logFile, `${step.url} already answered before the ${step.name} server was started; nothing was started.\n`);
        logFiles.push(logFile);
      } catch {
        // the diagnosis still says what happened
      }
      done(step, false);
      return fail(step, { stage: "start", code: "app_not_ready", message: `something else was already answering at the ${step.name} server's url` });
    }
    let p: Proc;
    try {
      p = launch(step.name, step.cmd, ws.root, logFile, env);
    } catch {
      const d: Pick<DoctorDiagnosis, "stage" | "code"> = step.kind === "setup" ? (SETUP_DIAG[step.name] ?? { stage: "start", code: "unknown" }) : { stage: "start", code: "app_not_ready" };
      done(step, false);
      return fail(step, { ...d, message: `the ${step.name} command could not be started` });
    }
    procs.push(p);
    logFiles.push(logFile);
    const launchedAt = Date.now();
    if (step.kind === "setup") {
      const res = await runToExit(p, step.timeoutMs);
      if (res.timedOut || res.code !== 0) {
        const d = SETUP_DIAG[step.name] ?? { stage: "start", code: "unknown" };
        const message = res.timedOut ? `the ${step.name} command did not finish within ${secs}s` : `the ${step.name} command failed`;
        done(step, false, { exitCode: res.code });
        return fail(step, { ...d, message });
      }
      done(step, true, { exitCode: res.code });
      continue;
    }
    const target = step.readyUrl || step.url || "";
    if (!URL.canParse(target)) {
      done(step, false);
      return fail(step, { stage: "start", code: "app_not_ready", message: `the ${step.name} server's ready URL is not a valid URL` });
    }
    const deadline = Date.now() + step.timeoutMs;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(Math.max(100, Math.min(5_000, deadline - Date.now()))) });
        await res.body?.cancel().catch(() => {});
        if (res.status < 500) {
          up = true;
          break;
        }
      } catch {
        // not listening yet
      }
      if (p.exited) {
        done(step, false, { exitCode: p.child.exitCode });
        return fail(step, { stage: "start", code: "app_not_ready", message: `the ${step.name} server exited before it was ready` });
      }
      await Promise.race([sleep(Math.min(pollMs, Math.max(0, deadline - Date.now()))), p.exit]);
    }
    if (!up) {
      done(step, false);
      return fail(step, { stage: "start", code: "app_not_ready", message: `the ${step.name} server did not answer at its ready URL within ${secs}s` });
    }
    done(step, true, { readyMs: Date.now() - launchedAt });
  }
  return { ok: true, handle, steps };
}

async function answers(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function authStatePath(ws: { dir: string }): string {
  return path.join(ws.dir, "auth", "state.json");
}

function parseState(raw: string): StorageState | null {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !Array.isArray(v.cookies) || !Array.isArray(v.origins)) return null;
    return v as StorageState;
  } catch {
    return null;
  }
}

const JSON_LITERAL = /"(?:[^"\\]|\\.)*"/g;

// What a failed login left behind, read only so its values can be scrubbed from the uploaded logs.
function leftoverState(statePath: string): StorageState | null {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && (Array.isArray(v.cookies) || Array.isArray(v.origins))) {
      return { cookies: Array.isArray(v.cookies) ? v.cookies : [], origins: Array.isArray(v.origins) ? v.origins : [] };
    }
  } catch {
    // not JSON: every string in it counts
  }
  const values = [raw.trim(), ...(raw.match(JSON_LITERAL) ?? []).flatMap((l) => {
    try {
      return [String(JSON.parse(l))];
    } catch {
      return [];
    }
  })];
  return { cookies: [], origins: [{ origin: "", localStorage: values.map((value) => ({ name: "", value })) }] };
}

type LoginFailure = { ok: false; diagnosis: DoctorDiagnosis; state: StorageState | null };
const loginFailed = (message: string, state: StorageState | null = null): LoginFailure => ({ ok: false, diagnosis: { stage: "login", code: "login_failed", message }, state });

export async function runLogin(
  spec: BootSpec,
  ws: { root: string; dir: string; artifactsDir: string }
): Promise<{ ok: true; storageStatePath: string; state: StorageState } | LoginFailure> {
  if (!spec.login) return loginFailed("no login script is configured");
  const statePath = authStatePath(ws);
  const env = childEnv({ DEVASIGN_STORAGE_STATE: statePath, DEVASIGN_BASE_URL: spec.baseUrl });
  let p: Proc;
  authDirs.add(path.dirname(statePath));
  syncGuards();
  try {
    mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(statePath), 0o700);
    rmSync(statePath, { force: true });
    p = launch("login", spec.login.script, ws.root, path.resolve(ws.artifactsDir, "logs", "boot-login.log"), env);
  } catch {
    return loginFailed("the login script could not be started");
  }
  const res = await runToExit(p, spec.login.timeoutMs);
  // Nothing a login script leaves behind outlives it.
  await stopProcs([p]);
  if (res.timedOut) return loginFailed(`the login script did not finish within ${Math.round(spec.login.timeoutMs / 1000)}s`, leftoverState(statePath));
  if (res.code !== 0) return loginFailed("the login script failed", leftoverState(statePath));
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return loginFailed("the login script did not write a Playwright storage state");
  }
  const state = parseState(raw);
  if (!state) return loginFailed("the login script did not write a Playwright storage state", leftoverState(statePath));
  try {
    chmodSync(statePath, 0o600);
  } catch {
    // best-effort
  }
  return { ok: true, storageStatePath: statePath, state };
}

export function cookieHeaderFor(url: string, state: StorageState): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase();
  const reqPath = u.pathname || "/";
  const now = Date.now() / 1000;
  return (state.cookies || [])
    .filter((c) => {
      if (!c || typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") return false;
      const domain = c.domain.toLowerCase();
      const domainOk = domain.startsWith(".") ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
      if (!domainOk) return false;
      const cpath = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
      const pathOk = reqPath === cpath || reqPath.startsWith(cpath.endsWith("/") ? cpath : `${cpath}/`);
      if (!pathOk) return false;
      if (typeof c.expires === "number" && c.expires > 0 && c.expires <= now) return false;
      return !c.secure || u.protocol === "https:";
    })
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export async function checkSession(args: {
  baseUrl: string;
  check: string;
  state: StorageState;
  fetchImpl?: typeof fetch;
  windowMs?: number;
}): Promise<{ ok: true; status: number; cors?: "ok" } | { ok: false; status: number | null; cors?: "missing" | "mismatch"; diagnosis: DoctorDiagnosis }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let checkUrl: URL;
  let origin: string;
  try {
    origin = new URL(args.baseUrl).origin;
    checkUrl = new URL(args.check, args.baseUrl);
  } catch {
    return { ok: false, status: null, diagnosis: loginFailed("the session check URL is not valid").diagnosis };
  }
  const crossOrigin = checkUrl.origin !== origin;
  const cookie = cookieHeaderFor(checkUrl.toString(), args.state);
  const headers: Record<string, string> = { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) };
  const deadline = Date.now() + (args.windowMs ?? CHECK_WINDOW_MS);
  let status: number | null = null;
  while (true) {
    try {
      const res = await fetchImpl(checkUrl.toString(), { headers, redirect: "manual", signal: AbortSignal.timeout(Math.max(100, Math.min(5_000, deadline - Date.now()))) });
      await res.body?.cancel().catch(() => {});
      status = res.status;
      if (status >= 200 && status < 300) {
        if (!crossOrigin) return { ok: true, status };
        const allowOrigin = res.headers.get("access-control-allow-origin");
        const allowCredentials = res.headers.get("access-control-allow-credentials");
        if (allowOrigin === origin && allowCredentials === "true") return { ok: true, status, cors: "ok" };
        const cors = allowOrigin && allowOrigin !== origin ? "mismatch" : "missing";
        return { ok: false, status, cors, diagnosis: loginFailed("the session check's CORS headers do not allow the app's origin").diagnosis };
      }
    } catch {
      // not answering yet
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, status, diagnosis: loginFailed("the session check did not answer 2xx").diagnosis };
}

const SECRET_NAME = /SECRET|TOKEN|KEY|PASS|DATABASE_URL|COOKIE|SESSION/i;
const MIN_SECRET = 6;
const REDACTED = "[redacted]";
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const SESSION_HEADER = String.raw`(?:set-)?cookie|(?:proxy-)?authorization|x-api-key|apikey`;
const HEADER_ENTRY_JSON = new RegExp(String.raw`("name"\s*:\s*"(?:${SESSION_HEADER})"\s*,\s*"value"\s*:\s*)${JSON_STRING}`, "gi");
const HEADER_FIELD_JSON = new RegExp(String.raw`("(?:${SESSION_HEADER})"\s*:\s*)${JSON_STRING}`, "gi");
const STORAGE_ARRAY_JSON = new RegExp(String.raw`"(?:cookies|localStorage)"\s*:\s*\[(?:[^\]"]|${JSON_STRING})*\]`, "g");
const VALUE_JSON = new RegExp(String.raw`("value"\s*:\s*)${JSON_STRING}`, "g");
const HEADER_LINE = new RegExp(String.raw`\b((?:${SESSION_HEADER})["']?\s*:\s*)[^\r\n]*`, "gi");

export type RedactOptions = { envNames?: string[]; env?: NodeJS.ProcessEnv; state?: StorageState | null; json?: boolean };

// Stored values are often JSON, URL-encoded JSON or base64 JSON wrapping the tokens requests then carry.
function decodeNested(s: string): unknown {
  const forms = [s];
  try {
    forms.push(decodeURIComponent(s));
  } catch {
    // not URL-encoded
  }
  const b64 = s.replace(/^base64-/, "");
  if (b64.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) forms.push(Buffer.from(b64, "base64").toString("utf8"));
  for (const form of forms) {
    const t = form.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      return JSON.parse(t);
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function sessionStrings(v: unknown, add: (s: string) => void, depth = 0): void {
  if (depth > 32) return;
  if (typeof v === "string") {
    add(v);
    const inner = decodeNested(v);
    if (inner !== undefined) sessionStrings(inner, add, depth + 1);
  } else if (Array.isArray(v)) {
    for (const x of v) sessionStrings(x, add, depth + 1);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) sessionStrings(x, add, depth + 1);
  }
}

// `json`: the text is JSON lines (a trace), so a Cookie line is never cut short, only its values.
export function redact(text: string, opts: RedactOptions): string {
  const env = opts.env ?? process.env;
  const swaps = new Map<string, string>();
  const secret = (v: unknown) => {
    if (typeof v !== "string" || v.length < MIN_SECRET) return;
    // A lone surrogate in a session value makes encodeURIComponent throw; this scrub runs
    // inside a stream handler, where a throw is an uncaught exception that ends the run.
    let encoded: string | null = null;
    try {
      encoded = encodeURIComponent(v);
    } catch {
      // not URL-encodable; the literal form still gets swapped
    }
    for (const form of [v, ...(encoded === null ? [] : [encoded]), JSON.stringify(v).slice(1, -1)]) swaps.set(form, REDACTED);
  };
  for (const name of opts.envNames || []) secret(env[name]);
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name)) secret(value);
  const chunks = new Map<string, string[]>();
  for (const c of opts.state?.cookies || []) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string" || !c.value) continue;
    swaps.set(`${c.name}=${c.value}`, `${c.name}=${REDACTED}`);
    sessionStrings(c.value, secret);
    const chunk = /^(.+)\.(\d{1,2})$/.exec(c.name);
    if (chunk) (chunks.get(chunk[1]) ?? chunks.set(chunk[1], []).get(chunk[1])!)[Number(chunk[2])] = c.value;
  }
  // A session split across name.0, name.1… cookies only holds its tokens once joined.
  for (const parts of chunks.values()) sessionStrings(parts.join(""), secret);
  for (const o of opts.state?.origins || []) {
    if (!o || typeof o !== "object") continue;
    for (const item of Array.isArray(o.localStorage) ? o.localStorage : []) sessionStrings(item?.value, secret);
    for (const db of Array.isArray(o.indexedDB) ? o.indexedDB : []) {
      for (const store of Array.isArray((db as { stores?: unknown })?.stores) ? (db as { stores: unknown[] }).stores : []) sessionStrings((store as { records?: unknown })?.records, secret);
    }
  }
  let out = text;
  if (swaps.size) {
    const needles = [...swaps.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    out = out.replace(new RegExp(needles.join("|"), "g"), (m) => swaps.get(m) ?? REDACTED);
  }
  out = out
    .replace(HEADER_ENTRY_JSON, `$1"${REDACTED}"`)
    .replace(HEADER_FIELD_JSON, `$1"${REDACTED}"`)
    .replace(STORAGE_ARRAY_JSON, (list) => list.replace(VALUE_JSON, `$1"${REDACTED}"`));
  return opts.json ? out : out.replace(HEADER_LINE, `$1${REDACTED}`);
}

export function redactFile(file: string, opts: RedactOptions): void {
  try {
    writeFileSync(file, redact(readFileSync(file, "utf8"), opts));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    // An unredacted log must never be uploaded.
    try {
      rmSync(file, { force: true });
    } catch {
      // not a file we can remove either
    }
  }
}

export function cleanupAuth(ws: { dir: string }): void {
  const dir = path.join(ws.dir, "auth");
  rmSync(dir, { recursive: true, force: true });
  if (authDirs.delete(dir)) syncGuards();
}

export async function bootManaged(
  yml: DevasignVerifyConfig,
  ws: { root: string; dir: string; artifactsDir: string },
  deps: { fetchImpl?: typeof fetch; pollMs?: number } = {}
): Promise<
  | { ok: true; handle: BootHandle; baseUrl: string; storageStatePath: string | null; state: StorageState | null; sessionChecked: boolean; steps: BootStepResult[]; check: BootCheck | null }
  | { ok: false; handle: BootHandle | null; diagnosis: DoctorDiagnosis; steps: BootStepResult[]; failedStep: string | null; check: BootCheck | null }
> {
  const spec = bootSpec(yml);
  if (!spec) {
    return { ok: false, handle: null, diagnosis: { stage: "start", code: "no_start_command", message: "verify.start and verify.url are required to boot the app" }, steps: [], failedStep: null, check: null };
  }
  const redactLogs = (handle: BootHandle, state: StorageState | null) => {
    for (const f of handle.logFiles) redactFile(f, { envNames: yml.env, state });
  };
  const started = await startApp(spec, ws, deps);
  if (!started.ok) {
    await started.handle.stop();
    redactLogs(started.handle, null);
    return { ok: false, handle: started.handle, diagnosis: started.diagnosis, steps: started.steps, failedStep: started.failedStep, check: null };
  }
  const { handle, steps } = started;
  const failed = async (diagnosis: DoctorDiagnosis, state: StorageState | null, check: BootCheck | null) => {
    await handle.stop();
    cleanupAuth(ws);
    redactLogs(handle, state);
    return { ok: false as const, handle, diagnosis, steps, failedStep: "login", check };
  };
  if (!spec.login) return { ok: true, handle, baseUrl: spec.baseUrl, storageStatePath: null, state: null, sessionChecked: false, steps, check: null };
  handle.logFiles.push(path.resolve(ws.artifactsDir, "logs", "boot-login.log"));
  const login = await runLogin(spec, ws);
  if (!login.ok) return failed(login.diagnosis, login.state, null);
  if (!spec.login.check) {
    log.info("session not checked (no verify.login.check)");
    return { ok: true, handle, baseUrl: spec.baseUrl, storageStatePath: login.storageStatePath, state: login.state, sessionChecked: false, steps, check: null };
  }
  const check = await checkSession({ baseUrl: spec.baseUrl, check: spec.login.check, state: login.state, fetchImpl: deps.fetchImpl });
  const outcome: BootCheck = { status: check.status, ...(check.cors ? { cors: check.cors } : {}) };
  if (!check.ok) return failed(check.diagnosis, login.state, outcome);
  return { ok: true, handle, baseUrl: spec.baseUrl, storageStatePath: login.storageStatePath, state: login.state, sessionChecked: true, steps, check: outcome };
}
