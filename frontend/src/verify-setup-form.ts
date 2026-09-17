// The setup drawer's pure half: what the browser-tests checklist says is settled, and the
// SetupAnswers the backend will accept. React-free for node --test.
import type { SetupAnswers, SetupCandidates, SetupProposed, VerifySetup } from "./api.ts";
import { bootFailureText, bootOkText } from "./verify-setup-view.ts";

export type ChecklistTone = "ok" | "warn" | "mute";
export type ChecklistKey = "start" | "servers" | "services" | "secrets" | "login" | "boot";
export type ChecklistItem = {
  key: ChecklistKey;
  label: string;
  tone: ChecklistTone;
  text: string;
  needsAnswer: boolean;
};

// Every field is a string because it comes from an <input>; conversion and validation happen in
// answersFromForm, never in the component.
export type SetupForm = {
  start: { dir: string; script: string; port: string };
  servers: Array<{ dir: string; script: string; port: string; ready: string }>;
  serversNone: boolean;
  services: string[];
  env: string;
  login: { script: string; check: string };
  loginNone: boolean;
  e2e: "" | "auto" | "always" | "never";
  timeout: string;
};

// Mirrored from backend/src/verify/setup-answers.ts. A rule the drawer does not know becomes a
// 400 the maintainer cannot read.
const ROOT_DIR = ".";
const PLAIN_DIR = /^[A-Za-z0-9_.-]+$/;
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_SERVER_NAMES = new Set(["app", "install", "build", "seed", "login"]);
const READY_PATH = /^\/(?!\/)[\w\-./]*$/;
const LOGIN_PATH = /^\w[\w./-]*\.(mjs|js|cjs|sh)$/;
const CHECK_URL = /^(\/(?!\/)[\w\-./]*|https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[\w\-./]*)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const ENV_DENIED = new Set(["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV"]);
const ENV_DENIED_PREFIX = ["DEVASIGN_", "GITHUB_", "ACTIONS_", "RUNNER_"];
const SERVICES = ["postgres", "mysql", "redis"] as const;
const LIMITS = { servers: 4, services: 3, env: 50, dir: 64, ready: 200, script: 200, check: 300 };
const TIMEOUT = { min: 10, max: 900 };

// The only shape a start command ever takes (backend/src/verify/boot-inference.ts), read
// backwards so the form edits what the PR proposes instead of a blank row.
const START_CMD =
  /^(?:npm --prefix (\S+) run (\S+)|pnpm --dir (\S+) run (\S+)|yarn --cwd (\S+) run (\S+)|bun run --cwd (\S+) (\S+)|npm run (\S+)|pnpm run (\S+)|yarn run (\S+)|bun run (\S+))(?: -- --port (\d+) --strictPort)?$/;

type Service = (typeof SERVICES)[number];
type Fail = { ok: false; error: string; field: ChecklistKey };

const isService = (v: string): v is Service => (SERVICES as readonly string[]).includes(v);
const isDir = (dir: string) => dir === ROOT_DIR || (PLAIN_DIR.test(dir) && dir !== ".." && !dir.startsWith("-"));
// An echoed value carries its shape back to the maintainer and nothing else.
const clip = (v: string): string => v.replace(/[^\w:./-]+/g, " ").trim().slice(0, 60);
const fail = (error: string, field: ChecklistKey): Fail => ({ ok: false, error, field });
const item = (key: ChecklistKey, label: string, tone: ChecklistTone, text: string, needsAnswer = false): ChecklistItem =>
  ({ key, label, tone, text, needsAnswer });

function parseStart(cmd: string | undefined): { dir: string; script: string; port?: number } | null {
  const m = cmd ? START_CMD.exec(cmd.trim()) : null;
  if (!m) return null;
  const nested = [1, 3, 5, 7].find((i) => m[i] !== undefined);
  const root = [9, 10, 11, 12].find((i) => m[i] !== undefined);
  const script = nested ? m[nested + 1] : root ? m[root] : null;
  if (!script) return null;
  const port = m[13] ? Number(m[13]) : undefined;
  return { dir: nested ? m[nested] : ROOT_DIR, script, ...(port === undefined ? {} : { port }) };
}

function urlPort(url: string | undefined): number | undefined {
  const m = url ? /^https?:\/\/[^/:]+:(\d{1,5})(?:\/|$)/.exec(url) : null;
  return m ? Number(m[1]) : undefined;
}

const scriptPath = (cmd: string | undefined): string => (cmd ? cmd.replace(/^(?:node|bash)\s+\.\//, "") : "");

/** The verify block the checklist judges: what the setup PR proposes, else what the branch runs. */
function ymlView(setup: VerifySetup): { start?: string; url?: string; e2e?: string } | null {
  if (setup.proposed) return setup.proposed;
  const d = setup.browserTests?.defaultYml;
  if (d && (d.start || d.url || d.e2e || d.servers?.length)) return d;
  const y = setup.devasignYml;
  return y && (y.start || y.url || y.e2e) ? y : null;
}

/** null when there is no setup PR and no branch block to read, so "none" would be a guess. */
function serverView(setup: VerifySetup): Array<{ name: string }> | null {
  if (setup.proposed) return (setup.proposed.servers ?? []).map((s) => ({ name: s.name }));
  if (setup.browserTests?.defaultYml) return setup.browserTests.defaultYml.servers ?? [];
  return setup.devasignYml ? null : [];
}

/** Why the servers cannot be answered: the branch runs some this API reports as a bare name. */
export function serversLocked(setup: VerifySetup): string | null {
  if (setup.proposed) return null;
  const names = (setup.browserTests?.defaultYml?.servers ?? []).map((s) => s.name).filter(Boolean);
  return names.length ? `DevAsign knows ${names.join(", ")} only by name, so the servers can be edited only in an open setup PR` : null;
}

function startItem(yml: ReturnType<typeof ymlView>, packages: SetupCandidates["packages"]): ChecklistItem {
  if (yml?.start && yml.url) return item("start", "App start", "ok", `${yml.start} · ${yml.url}`);
  if (!yml && !packages.length) return item("start", "App start", "mute", "Not checked yet");
  if (packages.length) return item("start", "App start", "warn", "Pick the package and script that serves the app", true);
  return item("start", "App start", "warn", "DevAsign could not read this repo's packages — nothing to start it with");
}

function serversItem(
  servers: Array<{ name: string }> | null,
  startDir: string | null,
  packages: SetupCandidates["packages"],
): ChecklistItem {
  if (servers === null) return item("servers", "Servers", "mute", "Not checked yet");
  if (servers.length) {
    const names = servers.map((s) => s.name).join(", ");
    return item("servers", "Servers", "ok", `${servers.length === 1 ? "1 server" : `${servers.length} servers`}: ${names}`);
  }
  const extra = packages.filter((p) => p.framework === "server" && p.dir !== startDir).map((p) => p.dir);
  if (!extra.length) return item("servers", "Servers", "mute", "None — the app boots on its own");
  const text =
    extra.length === 1
      ? `${extra[0]} looks like a server the app needs — add it or say there is none`
      : `${extra.join(", ")} look like servers the app needs — add them or say there are none`;
  return item("servers", "Servers", "warn", text, true);
}

function servicesItem(setup: VerifySetup, pr: SetupProposed | null, unseen: boolean): ChecklistItem {
  const chosen = (pr?.services ?? []).map((s) => s.name).filter(isService);
  if (chosen.length) return item("services", "Services", "ok", chosen.join(", "));
  if (unseen) return item("services", "Services", "mute", "Not checked yet");
  const detected = (setup.detected?.services ?? []).filter(isService);
  if (!detected.length) return item("services", "Services", "mute", "None");
  return item("services", "Services", "warn", `This repo looks like it needs ${detected.join(", ")} — add ${detected.length === 1 ? "it" : "them"} or leave the list empty`, true);
}

function secretsItem(candidates: SetupCandidates | undefined, pr: SetupProposed | null): ChecklistItem {
  if (!candidates) return item("secrets", "Secrets", "mute", "Not checked yet");
  const missing = candidates.missingSecrets ?? [];
  if (missing.length) return item("secrets", "Secrets", "warn", `Not set in this repo's Actions secrets: ${missing.join(", ")}`, true);
  const env = pr?.env ?? [];
  if (env.length) return item("secrets", "Secrets", "ok", `Passing through ${env.join(", ")}`);
  // A null list is the App failing to read them, which is not the same claim as "none".
  if (candidates.secretNames === null) return item("secrets", "Secrets", "mute", "DevAsign could not read this repo's Actions secrets");
  // The list is the expected names GitHub confirmed, never the repo's inventory: an empty one
  // means nothing said which secrets the app needs, not that the repo has none.
  if (!candidates.secretNames.length) return item("secrets", "Secrets", "mute", "Name any secrets the app needs to boot");
  const n = candidates.secretNames.length;
  return item("secrets", "Secrets", "mute", `${n} secret${n === 1 ? "" : "s"} already set — name any the app needs to boot`);
}

function legacyLogin(login: NonNullable<SetupProposed["login"]>): string | null {
  if (login.strategy && login.strategy !== "none") return `login.strategy "${login.strategy}"`;
  if (login.storageState) return "login.storageState";
  if (login.form) return "login.form";
  return null;
}

function loginItem(candidates: SetupCandidates | undefined, pr: SetupProposed | null, unseen: boolean): ChecklistItem {
  const login = pr?.login ?? null;
  const script = scriptPath(login?.script);
  if (script) {
    const check = login?.check;
    if (check && !CHECK_URL.test(check)) {
      return item("login", "Login", "warn", `${script} · "${clip(check)}" is not a path or a localhost URL`, true);
    }
    if (check) return item("login", "Login", "ok", `${script} · checked at ${check}`);
    return item("login", "Login", "warn", `${script} — no check, so a sign-in that fails looks like success`);
  }
  const legacy = login ? legacyLogin(login) : null;
  if (legacy) return item("login", "Login", "warn", `The old ${legacy} has no effect — pick a login script or say the app needs no sign-in`, true);
  if (unseen) return item("login", "Login", "mute", "Not checked yet");
  const offered = candidates?.loginScripts ?? [];
  if (offered.length) return item("login", "Login", "warn", `${offered[0]} looks like a sign-in script — use it or say the app needs no sign-in`, true);
  return item("login", "Login", "mute", "None — the tests run signed out");
}

function bootItem(setup: VerifySetup): ChecklistItem {
  const probe = probeSummary(setup.boot);
  if (probe) return item("boot", "Boot check", probe.tone, probe.line, probe.tone === "warn");
  if (setup.probeUnavailable) return item("boot", "Boot check", "mute", "The runner in CI is too old to check the boot");
  return item("boot", "Boot check", "mute", "Not checked yet — the setup PR's own CI proves this config");
}

/** One line for what the last probe made of the proposed boot; null until a probe reports. */
export function probeSummary(boot: VerifySetup["boot"]): { tone: ChecklistTone; line: string } | null {
  if (!boot) return null;
  return { tone: boot.ok && boot.signedIn !== false ? "ok" : "warn", line: boot.ok ? bootOkText(boot) : bootFailureText(boot) };
}

export function checklistItems(setup: VerifySetup): ChecklistItem[] {
  const yml = ymlView(setup);
  const pr = setup.proposed ?? null;
  const packages = setup.candidates?.packages ?? [];
  const state = setup.onboarding?.state;
  // Only an open setup PR lists a login or a service, so absence is a guess whenever a config
  // that could hold them has merged, or nothing has been read at all.
  const unseen = !pr && (!!yml || state === "pr_merged" || state === "verified" || !packages.length);
  return [
    startItem(yml, packages),
    serversItem(serverView(setup), parseStart(yml?.start)?.dir ?? null, packages),
    servicesItem(setup, pr, unseen),
    secretsItem(setup.candidates, pr),
    loginItem(setup.candidates, pr, unseen),
    bootItem(setup),
  ];
}

/** A follow-up setup PR on an onboarded repo leaves `state` alone, so only the flag says it is open. */
export function setupPrOpen(setup: VerifySetup): boolean {
  const ob = setup.onboarding;
  return ob?.setupPrOpen ?? ob?.state === "pr_open";
}

const num = (v: number | undefined): string => (v === undefined ? "" : String(v));

export function formFromSetup(setup: VerifySetup): SetupForm {
  const yml = ymlView(setup);
  const pr = setup.proposed ?? null;
  const start = parseStart(yml?.start);
  const servers = (pr?.servers ?? []).map((s) => {
    const p = parseStart(s.start);
    return {
      dir: p?.dir ?? "",
      script: p?.script ?? "",
      port: num(urlPort(s.url) ?? p?.port),
      // An unanswered ready is written as "/", so keeping it would send an answer nobody gave.
      ready: s.ready && s.ready !== "/" ? s.ready : "",
    };
  });
  const e2e = yml?.e2e;
  return {
    start: { dir: start?.dir ?? "", script: start?.script ?? "", port: num(urlPort(yml?.url) ?? start?.port) },
    servers,
    serversNone: false,
    services: (pr?.services ?? []).map((s) => s.name).filter(isService),
    env: (pr?.env ?? []).join(", "),
    login: { script: scriptPath(pr?.login?.script), check: pr?.login?.check ?? "" },
    loginNone: false,
    e2e: e2e === "auto" || e2e === "always" || e2e === "never" ? e2e : "",
    timeout: num(pr?.timeout),
  };
}

// Ticking "none" hides the rows, so leaving them filled refuses over fields that are no longer
// on screen; unticking puts back what the setup PR proposed.
export function serversNoneToggle(on: boolean, setup: VerifySetup): Partial<SetupForm> {
  return { serversNone: on, servers: on ? [] : formFromSetup(setup).servers };
}

export function loginNoneToggle(on: boolean, setup: VerifySetup): Partial<SetupForm> {
  return { loginNone: on, login: on ? { script: "", check: "" } : formFromSetup(setup).login };
}

function portFrom(value: string, where: string, field: ChecklistKey, taken: Set<number>): { port: number } | Fail {
  const v = value.trim();
  if (!v) return fail(`${where} needs a port`, field);
  if (!/^\d+$/.test(v)) return fail(`${where}: "${clip(value)}" is not a port number`, field);
  const port = Number(v);
  if (port < 1024 || port > 65535) return fail(`${where}: a port must be between 1024 and 65535`, field);
  if (taken.has(port)) return fail(`${where}: port ${port} is already used by another process`, field);
  taken.add(port);
  return { port };
}

function commandFrom(
  row: { dir: string; script: string },
  where: string,
  field: ChecklistKey,
  packages: SetupCandidates["packages"],
): { dir: string; script: string } | Fail {
  const dir = row.dir.trim();
  const script = row.script.trim();
  if (!dir) return fail(`${where}: pick the package that starts it`, field);
  if (dir.length > LIMITS.dir || !isDir(dir)) return fail(`${where}: "${clip(dir)}" is not a package directory`, field);
  const pkg = packages.find((p) => p.dir === dir);
  if (packages.length && !pkg) return fail(`${where}: this repo has no package in ${clip(dir)}`, field);
  if (!script) return fail(`${where}: pick the script that starts ${clip(dir)}`, field);
  if (!SCRIPT_NAME.test(script)) return fail(`${where}: "${clip(script)}" is not a script name`, field);
  if (pkg && pkg.scripts.length && !pkg.scripts.includes(script)) return fail(`${where}: ${clip(dir)} has no "${clip(script)}" script`, field);
  return { dir, script };
}

function envNames(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const serversChanged = (form: SetupForm, base: SetupForm) =>
  form.servers.length !== base.servers.length ||
  form.servers.some((r, i) => {
    const b = base.servers[i];
    return r.dir !== b.dir || r.script !== b.script || r.port !== b.port || r.ready !== b.ready;
  });

function serversAnswer(form: SetupForm, base: SetupForm, packages: SetupCandidates["packages"], taken: Set<number>):
  | { rows: NonNullable<Exclude<SetupAnswers["servers"], "none">> }
  | Fail
  | null {
  const rows = form.servers;
  if (!serversChanged(form, base)) return null;
  if (rows.length > LIMITS.servers) return fail(`At most ${LIMITS.servers} servers are supported`, "servers");
  const out: NonNullable<Exclude<SetupAnswers["servers"], "none">> = [];
  const names = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const where = `Server ${i + 1}`;
    const cmd = commandFrom(rows[i], where, "servers", packages);
    if ("error" in cmd) return cmd;
    const port = portFrom(rows[i].port, where, "servers", taken);
    if ("error" in port) return port;
    const name = cmd.dir.toLowerCase().replace(/[_.]/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
    if (!SERVER_NAME.test(name) || RESERVED_SERVER_NAMES.has(name)) return fail(`${where}: ${clip(cmd.dir)} cannot be used as a server name`, "servers");
    if (names.has(name)) return fail(`${where}: another server is already called "${name}"`, "servers");
    names.add(name);
    const ready = rows[i].ready.trim();
    if (ready && (ready.length > LIMITS.ready || !READY_PATH.test(ready) || ready.includes(".."))) {
      return fail(`${where}: a ready path must be a path on that server such as /health`, "servers");
    }
    out.push({ dir: cmd.dir, script: cmd.script, port: port.port, ...(ready ? { ready } : {}) });
  }
  return { rows: out };
}

// Under e2e: never the merge still writes an answered key, so the backend refuses a boot answer
// alongside it rather than arming a boot nobody asked for.
const BOOT_ANSWERS: Array<[keyof SetupAnswers, ChecklistKey, string]> = [
  ["start", "start", "the app start"],
  ["servers", "servers", "the servers"],
  ["login", "login", "the login script"],
  ["timeout", "boot", "the boot timeout"],
];

export function answersFromForm(form: SetupForm, setup: VerifySetup): { ok: true; answers: SetupAnswers } | Fail {
  const base = formFromSetup(setup);
  const packages = setup.candidates?.packages ?? [];
  const answers: SetupAnswers = {};
  const taken = new Set<number>();

  if (form.e2e && form.e2e !== base.e2e) answers.e2e = form.e2e;

  const s = form.start;
  const startChanged = s.dir !== base.start.dir || s.script !== base.start.script || s.port !== base.start.port;
  const startAnswered = startChanged && !!(s.dir || s.script || s.port);
  const serversAnswered = form.serversNone || serversChanged(form, base);
  // A port is taken by whatever holds it, answered here or not: the app and a server left alone
  // on one port is two processes fighting for it and a boot that dies with no reason in the panel.
  if (!startAnswered && base.start.port) taken.add(Number(base.start.port));
  if (!serversAnswered) for (const r of base.servers) if (r.port) taken.add(Number(r.port));
  if (startAnswered) {
    const cmd = commandFrom(s, "The app start", "start", packages);
    if ("error" in cmd) return cmd;
    const port = portFrom(s.port, "The app start", "start", taken);
    if ("error" in port) return port;
    answers.start = { dir: cmd.dir, script: cmd.script, port: port.port };
  }

  const locked = serversLocked(setup);
  if (form.serversNone) {
    if (form.servers.some((r) => r.dir || r.script || r.port || r.ready)) {
      return fail(`Servers are set to none — clear the rows or untick it`, "servers");
    }
    answers.servers = "none";
  } else {
    const built = serversAnswer(form, base, packages, taken);
    if (built) {
      if ("error" in built) return built;
      answers.servers = built.rows;
    }
  }
  // Every key the merge writes is written whole, so a list built without them drops the servers
  // this form only knows by name.
  if (answers.servers !== undefined && locked) return fail(locked, "servers");

  const services = [...new Set(form.services.map((v) => v.trim()).filter(Boolean))];
  if (!sameList(services, base.services)) {
    if (services.length > LIMITS.services) return fail(`At most ${LIMITS.services} services are supported`, "services");
    const bad = services.find((v) => !isService(v));
    if (bad !== undefined) return fail(`"${clip(bad)}" is not a service DevAsign can start`, "services");
    answers.services = services as Service[];
  }

  const env = [...new Set(envNames(form.env))];
  if (!sameList(env, [...new Set(envNames(base.env))])) {
    if (env.length > LIMITS.env) return fail(`At most ${LIMITS.env} secret names can be passed through`, "secrets");
    for (const name of env) {
      if (!ENV_NAME.test(name)) return fail(`"${clip(name)}" is not a variable name — use capitals, digits and underscores, as in STRIPE_KEY`, "secrets");
      if (ENV_DENIED.has(name) || ENV_DENIED_PREFIX.some((p) => name.startsWith(p))) {
        return fail(`${name} cannot be passed through — that name belongs to the runner`, "secrets");
      }
    }
    answers.env = env;
  }

  if (form.loginNone) {
    if (form.login.script || form.login.check) return fail(`Login is set to none — clear the script and check or untick it`, "login");
    answers.login = "none";
  } else if (form.login.script !== base.login.script || form.login.check !== base.login.check) {
    const script = form.login.script.trim();
    const check = form.login.check.trim();
    if (!script) return fail(`Pick a login script, or say the app needs no sign-in`, "login");
    if (script.length > LIMITS.script || !LOGIN_PATH.test(script) || script.includes("..")) {
      return fail(`A login script must be a .mjs, .js, .cjs or .sh file in the repository`, "login");
    }
    if (check && (check.length > LIMITS.check || !CHECK_URL.test(check) || check.includes(".."))) {
      return fail(`The login check must be a path or a localhost URL such as http://localhost:8787/api/me`, "login");
    }
    answers.login = { script, ...(check ? { check } : {}) };
  }

  if (form.timeout !== base.timeout && form.timeout.trim()) {
    const t = form.timeout.trim();
    if (!/^\d+$/.test(t) || Number(t) < TIMEOUT.min || Number(t) > TIMEOUT.max) {
      return fail(`The boot timeout must be a whole number of seconds between ${TIMEOUT.min} and ${TIMEOUT.max}`, "boot");
    }
    answers.timeout = Number(t);
  }

  if (answers.e2e === "never") {
    const armed = BOOT_ANSWERS.find(([key]) => answers[key] !== undefined);
    if (armed) return fail(`Browser tests are off (e2e: never), so ${armed[2]} cannot be answered too`, armed[1]);
  }
  return { ok: true, answers };
}
