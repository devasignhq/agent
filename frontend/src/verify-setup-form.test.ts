// node --test src/verify-setup-form.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { SetupCandidates, SetupProposed, VerifyBoot, VerifySetup } from "./api.ts";
import type { ChecklistKey, SetupForm } from "./verify-setup-form.ts";
import {
  answersFromForm,
  checklistItems,
  formFromSetup,
  loginNoneToggle,
  probeSummary,
  serversLocked,
  serversNoneToggle,
  setupPrOpen,
} from "./verify-setup-form.ts";

const setupOf = (over: Partial<VerifySetup> = {}): VerifySetup =>
  ({ onboarding: { state: "none" }, detected: null, devasignYml: null, runnerSeen: true, ...over }) as VerifySetup;

const cand = (over: Partial<SetupCandidates> = {}): SetupCandidates => ({
  packages: [],
  loginScripts: [],
  secretNames: [],
  missingSecrets: [],
  secretsUrl: "https://github.com/o/r/settings/secrets/actions",
  ...over,
});

const pkg = (dir: string, scripts: string[], over: Partial<SetupCandidates["packages"][number]> = {}) =>
  ({ dir, pm: "npm" as const, framework: null, scripts, ...over });

const twoPackages = cand({
  packages: [pkg("frontend", ["dev", "build"], { framework: "vite", port: 3001 }), pkg("backend", ["dev:ephemeral"], { framework: "server", port: 8787 })],
  loginScripts: ["scripts/devasign-login.mjs"],
});

const proposed: SetupProposed = {
  e2e: "auto",
  start: "npm --prefix frontend run dev -- --port 3001 --strictPort",
  url: "http://localhost:3001",
  ready: "/",
  servers: [{ name: "backend", start: "npm --prefix backend run dev:ephemeral", url: "http://localhost:8787", ready: "/" }],
  services: [{ name: "postgres" }],
  env: ["STRIPE_KEY"],
  login: { script: "node ./scripts/devasign-login.mjs" },
  timeout: 240,
};

const row = (setup: VerifySetup, key: ChecklistKey) => {
  const found = checklistItems(setup).find((i) => i.key === key);
  assert.ok(found, `no ${key} row`);
  return found;
};

const accepted = (form: SetupForm, setup: VerifySetup) => {
  const res = answersFromForm(form, setup);
  assert.equal(res.ok, true, res.ok ? "" : `refused: ${res.error}`);
  return res.ok ? res.answers : {};
};

const refused = (form: SetupForm, setup: VerifySetup) => {
  const res = answersFromForm(form, setup);
  assert.equal(res.ok, false, "expected a refusal");
  return res.ok ? { error: "", field: "" } : { error: res.error, field: res.field };
};

test("the checklist keeps the contract's keys, labels and order", () => {
  const items = checklistItems(setupOf({ proposed, candidates: twoPackages }));
  assert.deepEqual(items.map((i) => i.key), ["start", "servers", "services", "secrets", "login", "boot"]);
  assert.deepEqual(items.map((i) => i.label), ["App start", "Servers", "Services", "Secrets", "Login", "Boot check"]);
});

test("App start is settled by the proposed command, asked when there are packages, quiet with nothing read", () => {
  const settled = row(setupOf({ proposed, candidates: twoPackages }), "start");
  assert.deepEqual([settled.tone, settled.needsAnswer], ["ok", false]);
  assert.equal(settled.text, "npm --prefix frontend run dev -- --port 3001 --strictPort · http://localhost:3001");

  const asks = row(setupOf({ proposed: {}, candidates: twoPackages }), "start");
  assert.deepEqual([asks.tone, asks.needsAnswer, asks.text], ["warn", true, "Pick the package and script that serves the app"]);

  const unknown = row(setupOf({ candidates: cand() }), "start");
  assert.deepEqual([unknown.tone, unknown.needsAnswer, unknown.text], ["mute", false, "Not checked yet"]);

  // A url with no start is not a start: half a config still has to be answered.
  assert.equal(row(setupOf({ proposed: { url: "http://localhost:3001" }, candidates: twoPackages }), "start").needsAnswer, true);
  const blind = row(setupOf({ proposed: {}, candidates: cand() }), "start");
  assert.deepEqual([blind.tone, blind.needsAnswer], ["warn", false], "nothing to pick from, so nothing to answer");
});

test("Servers name what CI runs, ask about a package that looks like one, and never guess when unseen", () => {
  const settled = row(setupOf({ proposed, candidates: twoPackages }), "servers");
  assert.deepEqual([settled.tone, settled.needsAnswer, settled.text], ["ok", false, "1 server: backend"]);

  const two = row(setupOf({ proposed: { ...proposed, servers: [...proposed.servers!, { name: "worker", start: "npm --prefix worker run dev", url: "http://localhost:8788" }] } }), "servers");
  assert.equal(two.text, "2 servers: backend, worker");

  const asks = row(setupOf({ proposed: { start: proposed.start, url: proposed.url }, candidates: twoPackages }), "servers");
  assert.deepEqual([asks.tone, asks.needsAnswer], ["warn", true]);
  assert.equal(asks.text, "backend looks like a server the app needs — add it or say there is none");

  const none = row(setupOf({ proposed: { start: proposed.start, url: proposed.url }, candidates: cand({ packages: [pkg("frontend", ["dev"], { framework: "vite" })] }) }), "servers");
  assert.deepEqual([none.tone, none.needsAnswer, none.text], ["mute", false, "None — the app boots on its own"]);

  const unseen = row(setupOf({ devasignYml: { start: "npm run dev", url: "http://localhost:3000" }, candidates: twoPackages }), "servers");
  assert.deepEqual([unseen.tone, unseen.text], ["mute", "Not checked yet"], "the API cannot show the branch's servers, so absence is not a fact");
  // The default branch block does list them, so there it is a fact.
  const branch = row(setupOf({ devasignYml: { start: "npm run dev" }, browserTests: { defaultYml: { start: "npm run dev", servers: [{ name: "api" }] } } as VerifySetup["browserTests"] }), "servers");
  assert.equal(branch.text, "1 server: api");
});

test("Services confirm what is chosen or ask about what detection saw", () => {
  const settled = row(setupOf({ proposed, candidates: twoPackages }), "services");
  assert.deepEqual([settled.tone, settled.needsAnswer, settled.text], ["ok", false, "postgres"]);

  const asks = row(setupOf({ proposed: {}, detected: { frameworks: [], existingWorkflows: [], services: ["postgres", "redis"] } }), "services");
  assert.deepEqual([asks.tone, asks.needsAnswer], ["warn", true]);
  assert.equal(asks.text, "This repo looks like it needs postgres, redis — add them or leave the list empty");
  const one = row(setupOf({ proposed: {}, detected: { frameworks: [], existingWorkflows: [], services: ["redis"] } }), "services");
  assert.equal(one.text, "This repo looks like it needs redis — add it or leave the list empty");

  assert.deepEqual([row(setupOf({ proposed: {} }), "services").tone, row(setupOf({ proposed: {} }), "services").text], ["mute", "None"]);
  const unseen = row(setupOf({ devasignYml: { start: "npm run dev" }, detected: { frameworks: [], existingWorkflows: [], services: ["postgres"] } }), "services");
  assert.deepEqual([unseen.tone, unseen.needsAnswer, unseen.text], ["mute", false, "Not checked yet"]);
});

test("Secrets never call an unreadable list empty", () => {
  const unread = row(setupOf({ proposed: {}, candidates: cand({ secretNames: null, missingSecrets: null }) }), "secrets");
  assert.deepEqual([unread.tone, unread.needsAnswer], ["mute", false]);
  assert.equal(unread.text, "DevAsign could not read this repo's Actions secrets");
  assert.doesNotMatch(unread.text, /no secrets|has no/i, "an unreadable list is not the claim that there are none");

  // The list is the expected names GitHub confirmed, so an empty one is not an empty repo.
  const empty = row(setupOf({ proposed: {}, candidates: cand() }), "secrets");
  assert.equal(empty.text, "Name any secrets the app needs to boot");
  assert.doesNotMatch(empty.text, /no secrets|has no|no Actions/i, "an empty expected list is not the claim that the repo has none");

  const missing = row(setupOf({ proposed: {}, candidates: cand({ secretNames: ["A"], missingSecrets: ["STRIPE_KEY", "RESEND_KEY"] }) }), "secrets");
  assert.deepEqual([missing.tone, missing.needsAnswer], ["warn", true]);
  assert.equal(missing.text, "Not set in this repo's Actions secrets: STRIPE_KEY, RESEND_KEY");

  const passing = row(setupOf({ proposed, candidates: cand({ secretNames: ["STRIPE_KEY"] }) }), "secrets");
  assert.deepEqual([passing.tone, passing.text], ["ok", "Passing through STRIPE_KEY"]);

  const available = row(setupOf({ proposed: {}, candidates: cand({ secretNames: ["A", "B"] }) }), "secrets");
  assert.equal(available.text, "2 secrets already set — name any the app needs to boot");
  assert.equal(row(setupOf({ proposed: {}, candidates: cand({ secretNames: ["A"] }) }), "secrets").text, "1 secret already set — name any the app needs to boot");
  assert.equal(row(setupOf({ proposed: {} }), "secrets").text, "Not checked yet", "an older backend sends no candidates at all");
});

test("Login settles on a checked script, warns without a check, and flags a legacy strategy", () => {
  const checked = row(setupOf({ proposed: { ...proposed, login: { script: "node ./scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" } } }), "login");
  assert.deepEqual([checked.tone, checked.needsAnswer], ["ok", false]);
  assert.equal(checked.text, "scripts/devasign-login.mjs · checked at http://localhost:8787/api/me");

  const unchecked = row(setupOf({ proposed }), "login");
  assert.deepEqual([unchecked.tone, unchecked.needsAnswer], ["warn", false]);
  assert.equal(unchecked.text, "scripts/devasign-login.mjs — no check, so a sign-in that fails looks like success");

  const offsite = row(setupOf({ proposed: { ...proposed, login: { script: "node ./scripts/devasign-login.mjs", check: "https://staging.example.com/api/me" } } }), "login");
  assert.deepEqual([offsite.tone, offsite.needsAnswer], ["warn", true]);
  assert.match(offsite.text, /is not a path or a localhost URL/);

  const legacy = row(setupOf({ proposed: { ...proposed, login: { strategy: "form", form: { url: "/login", user: "a", pass: "b" } } } }), "login");
  assert.deepEqual([legacy.tone, legacy.needsAnswer], ["warn", true]);
  assert.equal(legacy.text, `The old login.strategy "form" has no effect — pick a login script or say the app needs no sign-in`);

  const offered = row(setupOf({ proposed: {}, candidates: twoPackages }), "login");
  assert.deepEqual([offered.tone, offered.needsAnswer], ["warn", true]);
  assert.equal(offered.text, "scripts/devasign-login.mjs looks like a sign-in script — use it or say the app needs no sign-in");

  assert.equal(row(setupOf({ proposed: {}, candidates: cand() }), "login").text, "None — the tests run signed out");
  assert.equal(row(setupOf({ devasignYml: { start: "npm run dev" }, candidates: cand() }), "login").text, "Not checked yet");
});

test("Boot check speaks with the probe's own words and asks for an answer only when it failed", () => {
  const boot = (over: Partial<VerifyBoot>): VerifyBoot =>
    ({ ok: true, prNumber: 12, sha: "abcdef1234", at: 5, signedIn: null, logUrl: null, screenshotUrl: null, urlExpiresAt: null, ...over });

  assert.equal(probeSummary(null), null);
  assert.equal(probeSummary(undefined), null);
  assert.deepEqual(probeSummary(boot({})), { tone: "ok", line: "The app came up in CI" });
  assert.deepEqual(probeSummary(boot({ signedIn: true })), { tone: "ok", line: "The app came up in CI and DevAsign signed in" });
  assert.deepEqual(probeSummary(boot({ signedIn: false })), { tone: "warn", line: "The app came up in CI, but DevAsign did not sign in" });
  assert.deepEqual(probeSummary(boot({ ok: false, stage: "servers", failedServer: "backend" })), {
    tone: "warn",
    line: "The app did not start in CI — the backend server never came up",
  });

  const ok = row(setupOf({ proposed, boot: boot({}) }), "boot");
  assert.deepEqual([ok.tone, ok.needsAnswer, ok.text], ["ok", false, "The app came up in CI"]);
  const failed = row(setupOf({ proposed, boot: boot({ ok: false, stage: "login" }) }), "boot");
  assert.deepEqual([failed.tone, failed.needsAnswer], ["warn", true]);
  assert.equal(failed.text, "The app came up in CI, but DevAsign could not sign in");
  assert.equal(row(setupOf({ proposed }), "boot").text, "Not checked yet — the setup PR's own CI proves this config");
  assert.equal(row(setupOf({ proposed, probeUnavailable: { cliVersion: "1.4.0", at: 1 } }), "boot").text, "The runner in CI is too old to check the boot");
});

test("the form prefills from the setup PR's own commands", () => {
  assert.deepEqual(formFromSetup(setupOf({ proposed, candidates: twoPackages })), {
    start: { dir: "frontend", script: "dev", port: "3001" },
    servers: [{ dir: "backend", script: "dev:ephemeral", port: "8787", ready: "" }],
    serversNone: false,
    services: ["postgres"],
    env: "STRIPE_KEY",
    login: { script: "scripts/devasign-login.mjs", check: "" },
    loginNone: false,
    e2e: "auto",
    timeout: "240",
  });

  const ready = formFromSetup(setupOf({ proposed: { ...proposed, servers: [{ name: "backend", start: "bun run --cwd backend serve", url: "http://localhost:8787", ready: "/health" }] } }));
  assert.deepEqual(ready.servers, [{ dir: "backend", script: "serve", port: "8787", ready: "/health" }], "every package manager's form parses back");

  const rootApp = formFromSetup(setupOf({ proposed: { start: "pnpm run dev -- --port 4173 --strictPort", url: "http://localhost:4173" } }));
  assert.deepEqual(rootApp.start, { dir: ".", script: "dev", port: "4173" });

  // A hand-written command is not one of the templates; the port still comes off the url.
  const handWritten = formFromSetup(setupOf({ proposed: { start: "node server.js", url: "http://localhost:5000" } }));
  assert.deepEqual(handWritten.start, { dir: "", script: "", port: "5000" });
});

test("without a setup PR the form prefills from the default branch and leaves the rest empty", () => {
  const form = formFromSetup(setupOf({
    devasignYml: { start: "yarn --cwd web run start", url: "http://localhost:4173", e2e: "always" },
    candidates: twoPackages,
  }));
  assert.deepEqual(form.start, { dir: "web", script: "start", port: "4173" });
  assert.equal(form.e2e, "always");
  assert.deepEqual([form.servers, form.services, form.env, form.login, form.timeout], [[], [], "", { script: "", check: "" }, ""]);
  assert.deepEqual([form.serversNone, form.loginNone], [false, false], "a prefill is never an explicit clear");

  const blank = formFromSetup(setupOf({ candidates: twoPackages }));
  assert.deepEqual(blank.start, { dir: "", script: "", port: "" });
  assert.equal(blank.e2e, "", "an unanswered e2e is omitted, not guessed as auto");
});

test("an untouched form answers nothing, so inference keeps every key", () => {
  const withPr = setupOf({ proposed, candidates: twoPackages });
  assert.deepEqual(accepted(formFromSetup(withPr), withPr), {});
  const blank = setupOf({ candidates: twoPackages });
  assert.deepEqual(accepted(formFromSetup(blank), blank), {});
});

test("clearing sends the none sentinel; leaving a key alone omits it", () => {
  const s = setupOf({ proposed, candidates: twoPackages });
  const base = formFromSetup(s);

  const noServers = accepted({ ...base, servers: [], serversNone: true }, s);
  assert.deepEqual(noServers, { servers: "none" }, "only the cleared key is answered");

  const noLogin = accepted({ ...base, login: { script: "", check: "" }, loginNone: true }, s);
  assert.deepEqual(noLogin, { login: "none" });

  const deletedRow = accepted({ ...base, servers: [] }, s);
  assert.deepEqual(deletedRow, { servers: [] }, "deleting every row clears servers too");

  const noServices = accepted({ ...base, services: [] }, s);
  assert.deepEqual(noServices, { services: [] });
  const noEnv = accepted({ ...base, env: "" }, s);
  assert.deepEqual(noEnv, { env: [] });

  // The other direction: one answered key must not drag the untouched ones along.
  const justTheCheck = accepted({ ...base, login: { script: base.login.script, check: "http://localhost:8787/api/me" } }, s);
  assert.deepEqual(justTheCheck, { login: { script: "scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" } });
  assert.deepEqual(Object.keys(justTheCheck), ["login"], "servers, services and env keep what inference chose");

  assert.deepEqual(refused({ ...base, serversNone: true }, s), { error: "Servers are set to none — clear the rows or untick it", field: "servers" });
  assert.deepEqual(refused({ ...base, loginNone: true }, s), { error: "Login is set to none — clear the script and check or untick it", field: "login" });
  assert.deepEqual(refused({ ...base, login: { script: "", check: "http://localhost:8787/api/me" } }, s).error, "Pick a login script, or say the app needs no sign-in");
});

test("ports are refused by field, in range, and never shared between processes", () => {
  const s = setupOf({ candidates: twoPackages });
  const base = formFromSetup(s);
  const withStart = (port: string) => ({ ...base, start: { dir: "frontend", script: "dev", port } });

  assert.deepEqual(refused(withStart(""), s), { error: "The app start needs a port", field: "start" });
  assert.deepEqual(refused(withStart("30 01"), s), { error: `The app start: "30 01" is not a port number`, field: "start" });
  assert.deepEqual(refused(withStart("3001.5"), s).error, `The app start: "3001.5" is not a port number`);
  assert.deepEqual(refused(withStart("80"), s), { error: "The app start: a port must be between 1024 and 65535", field: "start" });
  assert.equal(refused(withStart("65536"), s).error, "The app start: a port must be between 1024 and 65535");
  assert.equal(accepted(withStart("1024"), s).start!.port, 1024);

  const clash = { ...withStart("3001"), servers: [{ dir: "backend", script: "dev:ephemeral", port: "3001", ready: "" }] };
  assert.deepEqual(refused(clash, s), { error: "Server 1: port 3001 is already used by another process", field: "servers" });

  // The app's own port counts even when the start itself is not being answered.
  const open = setupOf({ proposed, candidates: twoPackages });
  const taken = { ...formFromSetup(open), servers: [{ dir: "backend", script: "dev:ephemeral", port: "3001", ready: "" }] };
  assert.equal(refused(taken, open).error, "Server 1: port 3001 is already used by another process");
  assert.deepEqual(refused({ ...base, servers: [{ dir: "backend", script: "dev:ephemeral", port: "", ready: "" }] }, s), {
    error: "Server 1 needs a port",
    field: "servers",
  });
});

test("env is split on commas and newlines and refused by name", () => {
  const s = setupOf({ candidates: twoPackages });
  const base = formFromSetup(s);
  const env = (text: string) => ({ ...base, env: text });

  assert.deepEqual(accepted(env(" STRIPE_KEY, RESEND_KEY\nSENTRY_DSN ,, \n"), s), { env: ["STRIPE_KEY", "RESEND_KEY", "SENTRY_DSN"] });
  assert.deepEqual(accepted(env("A_KEY, A_KEY"), s), { env: ["A_KEY"] }, "a repeated name is one name");

  assert.equal(refused(env("stripe_key"), s).error, `"stripe_key" is not a variable name — use capitals, digits and underscores, as in STRIPE_KEY`);
  assert.equal(refused(env("1PASSWORD"), s).error, `"1PASSWORD" is not a variable name — use capitals, digits and underscores, as in STRIPE_KEY`);
  assert.equal(refused(env("STRIPE KEY"), s).field, "secrets");
  for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "DEVASIGN_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_URL", "RUNNER_TEMP"]) {
    assert.deepEqual(refused(env(`OK_KEY, ${name}`), s), { error: `${name} cannot be passed through — that name belongs to the runner`, field: "secrets" });
  }
  assert.equal(refused(env(Array.from({ length: 51 }, (_, i) => `K${i}`).join(",")), s).error, "At most 50 secret names can be passed through");
  assert.deepEqual(accepted(env(Array.from({ length: 50 }, (_, i) => `K${i}`).join(",")), s).env!.length, 50);
});

test("the timeout, a ready path and a login path each name what is wrong", () => {
  const s = setupOf({ proposed, candidates: twoPackages });
  const base = formFromSetup(s);
  const timeout = (v: string) => refused({ ...base, timeout: v }, s);

  assert.deepEqual(timeout("9"), { error: "The boot timeout must be a whole number of seconds between 10 and 900", field: "boot" });
  assert.equal(timeout("901").error, "The boot timeout must be a whole number of seconds between 10 and 900");
  assert.equal(timeout("2.5").error, "The boot timeout must be a whole number of seconds between 10 and 900");
  assert.equal(timeout("soon").error, "The boot timeout must be a whole number of seconds between 10 and 900");
  assert.deepEqual(accepted({ ...base, timeout: "600" }, s), { timeout: 600 });
  assert.deepEqual(accepted({ ...base, timeout: "" }, s), {}, "a cleared timeout has no sentinel, so inference keeps it");

  const ready = (v: string) => refused({ ...base, servers: [{ dir: "backend", script: "dev:ephemeral", port: "8787", ready: v }] }, s);
  assert.deepEqual(ready("health"), { error: "Server 1: a ready path must be a path on that server such as /health", field: "servers" });
  assert.equal(ready("//evil.example.com/").error, "Server 1: a ready path must be a path on that server such as /health");
  assert.equal(ready("/../etc").error, "Server 1: a ready path must be a path on that server such as /health");

  const login = (script: string, check = "") => refused({ ...base, login: { script, check } }, s);
  assert.deepEqual(login("scripts/login.txt"), { error: "A login script must be a .mjs, .js, .cjs or .sh file in the repository", field: "login" });
  assert.equal(login("../outside/login.mjs").error, "A login script must be a .mjs, .js, .cjs or .sh file in the repository");
  assert.equal(login("-rf.sh").error, "A login script must be a .mjs, .js, .cjs or .sh file in the repository");
  assert.deepEqual(login("scripts/devasign-login.mjs", "https://staging.example.com/api/me"), {
    error: "The login check must be a path or a localhost URL such as http://localhost:8787/api/me",
    field: "login",
  });
  assert.equal(login("scripts/devasign-login.mjs", "//evil.example.com/").error, "The login check must be a path or a localhost URL such as http://localhost:8787/api/me");
  assert.deepEqual(accepted({ ...base, login: { script: "scripts/devasign-login.sh", check: "/api/me" } }, s), {
    login: { script: "scripts/devasign-login.sh", check: "/api/me" },
  });
});

test("a package or a script this repo does not have is refused before the backend has to", () => {
  const s = setupOf({ candidates: twoPackages });
  const base = formFromSetup(s);
  const start = (dir: string, script: string) => refused({ ...base, start: { dir, script, port: "3001" } }, s);

  assert.deepEqual(start("", "dev"), { error: "The app start: pick the package that starts it", field: "start" });
  assert.deepEqual(start("frontend", ""), { error: "The app start: pick the script that starts frontend", field: "start" });
  assert.deepEqual(start("../etc", "dev"), { error: `The app start: "../etc" is not a package directory`, field: "start" });
  assert.equal(start("-rf", "dev").error, `The app start: "-rf" is not a package directory`);
  assert.deepEqual(start("api", "dev"), { error: "The app start: this repo has no package in api", field: "start" });
  assert.deepEqual(start("frontend", "serve"), { error: `The app start: frontend has no "serve" script`, field: "start" });
  assert.equal(start("frontend", "dev && rm -rf /").error, `The app start: "dev rm -rf /" is not a script name`);

  // With no tree read there is nothing to check a name against, so only the shape is judged.
  const blind = setupOf({ candidates: cand() });
  assert.deepEqual(accepted({ ...formFromSetup(blind), start: { dir: "api", script: "dev", port: "3001" } }, blind), {
    start: { dir: "api", script: "dev", port: 3001 },
  });
});

test("a server's directory has to work as a server name, and twice is once too many", () => {
  const s = setupOf({ candidates: cand({ packages: [pkg("frontend", ["dev"]), pkg("login", ["dev"]), pkg("Api_One", ["dev"]), pkg("api-one", ["dev"]), pkg("_", ["dev"])] }) });
  const base = formFromSetup(s);
  const servers = (rows: Array<[string, string]>) =>
    refused({ ...base, servers: rows.map(([dir, port]) => ({ dir, script: "dev", port, ready: "" })) }, s);

  assert.deepEqual(servers([["login", "8787"]]), { error: "Server 1: login cannot be used as a server name", field: "servers" });
  assert.equal(servers([["_", "8787"]]).error, "Server 1: _ cannot be used as a server name");
  assert.deepEqual(refused({ ...base, servers: [
    { dir: "Api_One", script: "dev", port: "8787", ready: "" },
    { dir: "api-one", script: "dev", port: "8788", ready: "" },
  ] }, s).error, `Server 2: another server is already called "api-one"`);
  assert.equal(accepted({ ...base, servers: [{ dir: "Api_One", script: "dev", port: "8787", ready: "" }] }, s).servers![0].port, 8787);

  const many = Array.from({ length: 5 }, (_, i) => ({ dir: "frontend", script: "dev", port: String(9000 + i), ready: "" }));
  assert.deepEqual(refused({ ...base, servers: many }, s), { error: "At most 4 servers are supported", field: "servers" });
});

test("e2e: never cannot arm a boot the maintainer just turned off", () => {
  const s = setupOf({ candidates: twoPackages });
  const base = formFromSetup(s);
  assert.deepEqual(accepted({ ...base, e2e: "never" }, s), { e2e: "never" });

  const withStart = refused({ ...base, e2e: "never", start: { dir: "frontend", script: "dev", port: "3001" } }, s);
  assert.deepEqual(withStart, { error: "Browser tests are off (e2e: never), so the app start cannot be answered too", field: "start" });
  assert.equal(refused({ ...base, e2e: "never", servers: [], serversNone: true }, s).error, "Browser tests are off (e2e: never), so the servers cannot be answered too");
  assert.equal(refused({ ...base, e2e: "never", login: { script: "scripts/devasign-login.mjs", check: "" } }, s).error, "Browser tests are off (e2e: never), so the login script cannot be answered too");
  assert.deepEqual(refused({ ...base, e2e: "never", timeout: "240" }, s), {
    error: "Browser tests are off (e2e: never), so the boot timeout cannot be answered too",
    field: "boot",
  });
  // Services and env are not boot keys; the backend takes them under e2e: never.
  assert.deepEqual(accepted({ ...base, e2e: "never", services: ["postgres"] }, s), { e2e: "never", services: ["postgres"] });

  const already = setupOf({ candidates: twoPackages, devasignYml: { e2e: "never" } });
  assert.deepEqual(accepted({ ...formFromSetup(already), start: { dir: "frontend", script: "dev", port: "3001" } }, already), {
    start: { dir: "frontend", script: "dev", port: 3001 },
  }, "e2e is unchanged, so it is not answered and the start may be configured for later");
});

test("a full round trip is exactly the SetupAnswers the backend validator accepts", () => {
  const s = setupOf({ candidates: twoPackages, detected: { frameworks: [], existingWorkflows: [], services: ["postgres"] } });
  const answers = accepted({
    ...formFromSetup(s),
    start: { dir: "frontend", script: "dev", port: "3001" },
    servers: [{ dir: "backend", script: "dev:ephemeral", port: "8787", ready: "/health" }],
    services: ["postgres"],
    env: "STRIPE_KEY, RESEND_KEY\nSENTRY_DSN",
    login: { script: "scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
    e2e: "auto",
    timeout: "240",
  }, s);

  assert.deepEqual(answers, {
    e2e: "auto",
    start: { dir: "frontend", script: "dev", port: 3001 },
    servers: [{ dir: "backend", script: "dev:ephemeral", port: 8787, ready: "/health" }],
    services: ["postgres"],
    env: ["STRIPE_KEY", "RESEND_KEY", "SENTRY_DSN"],
    login: { script: "scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
    timeout: 240,
  });
  assert.deepEqual(Object.keys(answers).sort(), ["e2e", "env", "login", "servers", "services", "start", "timeout"]);
});

const branchYml = (over: Record<string, unknown> = {}): VerifySetup["browserTests"] =>
  ({ status: "proven", missing: [], lastBrowserless: null, fixUrl: "f", defaultYml: { e2e: "auto", start: "npm run dev", url: "http://localhost:3000", ...over } }) as VerifySetup["browserTests"];

test("servers the panel knows only by name are never answered away", () => {
  const branch = setupOf({
    onboarding: { state: "pr_merged", prNumber: 7 },
    browserTests: branchYml({ servers: [{ name: "api" }, { name: "db" }] }),
    candidates: twoPackages,
  });
  assert.equal(row(branch, "servers").text, "2 servers: api, db");
  const base = formFromSetup(branch);
  assert.deepEqual(base.servers, [], "the API shows the branch's servers as bare names");

  const locked = "DevAsign knows api, db only by name, so the servers can be edited only in an open setup PR";
  assert.equal(serversLocked(branch), locked);
  assert.deepEqual(accepted(base, branch), {}, "an untouched form still answers nothing");
  assert.deepEqual(refused({ ...base, servers: [{ dir: "backend", script: "dev:ephemeral", port: "9000", ready: "" }] }, branch), { error: locked, field: "servers" });
  assert.deepEqual(refused({ ...base, serversNone: true }, branch), { error: locked, field: "servers" });

  // An open setup PR carries the commands, so the rows are the form's to edit.
  assert.equal(serversLocked(setupOf({ proposed, candidates: twoPackages })), null);
  assert.equal(serversLocked(setupOf({ browserTests: branchYml(), candidates: twoPackages })), null);
});

test("a port an untouched server holds is taken, whichever side of the form asks for it", () => {
  const s = setupOf({ proposed, candidates: twoPackages });
  const base = formFromSetup(s);
  const clash = "The app start: port 8787 is already used by another process";

  assert.deepEqual(refused({ ...base, start: { ...base.start, port: "8787" } }, s), { error: clash, field: "start" });
  assert.equal(refused({ ...base, start: { dir: "backend", script: "dev:ephemeral", port: "8787" } }, s).error, clash, "picking the server's package auto-fills its port");

  assert.deepEqual(accepted({ ...base, start: { ...base.start, port: "8787" }, servers: [] }, s), {
    start: { dir: "frontend", script: "dev", port: 8787 },
    servers: [],
  }, "deleting the row that held it frees the port");
  assert.deepEqual(accepted({ ...base, servers: [{ ...base.servers[0], ready: "/health" }] }, s), {
    servers: [{ dir: "backend", script: "dev:ephemeral", port: 8787, ready: "/health" }],
  }, "a row keeps the port it already had");
});

test("ticking none clears the fields it hides, and unticking puts the proposal back", () => {
  const s = setupOf({ proposed, candidates: twoPackages });
  const base = formFromSetup(s);

  const noServers = { ...base, ...serversNoneToggle(true, s) };
  assert.deepEqual(noServers.servers, [], "a refusal must not name rows the tick just hid");
  assert.deepEqual(accepted(noServers, s), { servers: "none" });
  assert.deepEqual({ ...noServers, ...serversNoneToggle(false, s) }.servers, base.servers);

  const noLogin = { ...base, ...loginNoneToggle(true, s) };
  assert.deepEqual(noLogin.login, { script: "", check: "" });
  assert.deepEqual(accepted(noLogin, s), { login: "none" });
  assert.deepEqual({ ...noLogin, ...loginNoneToggle(false, s) }.login, base.login);
});

test("every refusal names a checklist row, so the panel always has somewhere to put it", () => {
  const s = setupOf({ proposed, candidates: twoPackages });
  const base = formFromSetup(s);
  const keys = new Set(checklistItems(s).map((i) => i.key));
  const bad: SetupForm[] = [
    { ...base, start: { ...base.start, port: "80" } },
    { ...base, servers: [{ dir: "backend", script: "dev:ephemeral", port: "8787", ready: "health" }] },
    { ...base, services: ["mongo"] },
    { ...base, env: "database url" },
    { ...base, login: { script: "scripts/login.txt", check: "" } },
    { ...base, timeout: "9" },
    { ...base, e2e: "never", timeout: "600" },
  ];
  for (const form of bad) {
    const res = answersFromForm(form, s);
    assert.equal(res.ok, false, "expected a refusal");
    if (!res.ok) assert.ok(keys.has(res.field), `${res.field} is not a row: ${res.error}`);
  }
});

test("a follow-up setup PR on an onboarded repo is still an open setup PR", () => {
  assert.equal(setupPrOpen(setupOf({ onboarding: { state: "verified", prNumber: 12, setupPrOpen: true } })), true);
  assert.equal(setupPrOpen(setupOf({ onboarding: { state: "pr_merged", prNumber: 12, setupPrOpen: false } })), false);
  // An older backend sends no flag, so the state is all there is to read.
  assert.equal(setupPrOpen(setupOf({ onboarding: { state: "pr_open", prNumber: 3 } })), true);
  assert.equal(setupPrOpen(setupOf({ onboarding: { state: "verified" } })), false);
});

test("a login and a service are never called absent from a config this API cannot show", () => {
  const merged = setupOf({ onboarding: { state: "pr_merged", prNumber: 7 }, browserTests: branchYml() });
  assert.equal(row(merged, "login").text, "Not checked yet", "the merged block's login never reaches the panel");
  assert.equal(row(merged, "services").text, "Not checked yet");

  const fresh = setupOf({ candidates: cand() });
  assert.deepEqual(
    [row(fresh, "start").text, row(fresh, "login").text, row(fresh, "services").text],
    ["Not checked yet", "Not checked yet", "Not checked yet"],
    "nothing has been read, so nothing is absent",
  );

  // A repo that has been read and has no setup PR yet is still asked the questions.
  const asks = setupOf({ candidates: twoPackages, detected: { frameworks: [], existingWorkflows: [], services: ["postgres"] } });
  assert.equal(row(asks, "login").text, "scripts/devasign-login.mjs looks like a sign-in script — use it or say the app needs no sign-in");
  assert.equal(row(asks, "services").text, "This repo looks like it needs postgres — add it or leave the list empty");
});
