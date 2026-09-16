// Managed boot against real child processes: plain Node servers in tmp dirs, no deps. Run:
//   node --import tsx/esm --test src/boot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authStatePath, bootManaged, bootSpec, checkSession, cleanupAuth, cookieHeaderFor, redact, redactFile, runLogin, startApp, type BootSpec, type StorageState } from "./boot.js";

const node = JSON.stringify(process.execPath);

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-boot-"));
  const dir = path.join(root, ".devasign");
  return { root, dir, artifactsDir: path.join(dir, "artifacts") };
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function canBind(port: number): Promise<boolean> {
  const srv = net.createServer();
  return new Promise((resolve) => {
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// `; true` keeps sh as a real parent, so only a process-group kill reaches the server.
function script(root: string, name: string, source: string): string {
  const file = path.join(root, name);
  writeFileSync(file, source);
  return `${node} ${JSON.stringify(file)}; true`;
}

// No `; true`: the command's own exit code is the step's.
function exact(root: string, name: string, source: string): string {
  const file = path.join(root, name);
  writeFileSync(file, source);
  return `${node} ${JSON.stringify(file)}`;
}

const serverSource = (port: number, extra = "") =>
  `require("http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1", () => { ${extra} });\n`;

async function withServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as net.AddressInfo).port, close: () => new Promise((r) => srv.close(() => r())) };
}

const state = (cookies: Array<Partial<StorageState["cookies"][number]>>, origins: StorageState["origins"] = []): StorageState => ({
  cookies: cookies.map((c) => ({ name: "sid", value: "v", domain: "localhost", path: "/", ...c })),
  origins,
});

test("bootSpec orders setup steps, then servers, then the app, and resolves each ready URL against its own url", () => {
  const spec = bootSpec({
    seed: "npm run seed",
    install: "npm ci",
    build: "npm run build",
    start: "npm run web",
    url: "http://localhost:4173/app",
    ready: "/health",
    servers: [
      { name: "api", start: "npm run api", url: "http://localhost:4180/v1", ready: "/ping" },
      { name: "worker", start: "npm run worker", url: "http://localhost:4190" },
    ],
    login: { script: "node login.mjs", check: "/me" },
  })!;
  assert.deepEqual(spec.steps.map((s) => [s.name, s.kind]), [["install", "setup"], ["build", "setup"], ["seed", "setup"], ["api", "server"], ["worker", "server"], ["app", "server"]]);
  assert.equal(spec.steps[3].readyUrl, "http://localhost:4180/ping");
  assert.equal(spec.steps[4].readyUrl, "http://localhost:4190");
  assert.equal(spec.steps[5].cmd, "npm run web");
  assert.equal(spec.steps[5].readyUrl, "http://localhost:4173/health");
  assert.ok(spec.steps.every((s) => s.timeoutMs === 180_000), "the default is 180s per step");
  assert.equal(spec.baseUrl, "http://localhost:4173/app");
  assert.deepEqual(spec.login, { script: "node login.mjs", check: "/me", timeoutMs: 120_000 });

  assert.equal(bootSpec({ start: "x", url: "http://localhost:1", timeout: 30 })!.steps[0].timeoutMs, 30_000);
  assert.equal(bootSpec({ start: "x", url: "http://localhost:1", timeout: 2 })!.steps[0].timeoutMs, 10_000);
  assert.equal(bootSpec({ start: "x", url: "http://localhost:1", timeout: 99_999 })!.steps[0].timeoutMs, 900_000);
  assert.deepEqual(bootSpec({ start: "x", url: "http://localhost:1" })!.steps.map((s) => s.name), ["app"]);
  assert.equal(bootSpec({ start: "x", url: "http://localhost:1", login: { check: "/me" } })!.login, null, "a check alone has no session to check");
  assert.equal(bootSpec({ start: "x" }), null);
  assert.equal(bootSpec({ url: "http://localhost:1", servers: [{ name: "api", start: "y", url: "http://localhost:2" }] }), null);
  const clash = bootSpec({ start: "x", url: "http://localhost:1", servers: ["app", "install", "build", "seed", "login", "api", "api"].map((name, i) => ({ name, start: `s${i}`, url: `http://localhost:${10 + i}` })) })!;
  assert.deepEqual(clash.steps.map((s) => [s.name, s.cmd]), [["api", "s5"], ["app", "x"]], "a server may not share a step's name, or its log");
});

test("startApp runs setup in order, starts each server only after the previous one is up, and stop() frees every port", { timeout: 60_000 }, async () => {
  const ws = workspace();
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const order = path.join(ws.root, "order.txt");
  const append = (label: string, delay = 0) => script(ws.root, `${label}.js`, `setTimeout(() => require("fs").appendFileSync(${JSON.stringify(order)}, "${label}\\n"), ${delay});\n`);
  // The API only listens after a delay; the app gives up at once when the API is not there yet.
  const api = script(ws.root, "api.js", `setTimeout(() => { ${serverSource(apiPort, `require("fs").appendFileSync(${JSON.stringify(order)}, "api\\n")`)} }, 700);\n`);
  const app = script(
    ws.root,
    "app.js",
    `require("http").get("http://127.0.0.1:${apiPort}/", () => { ${serverSource(appPort, `require("fs").appendFileSync(${JSON.stringify(order)}, "app\\n")`)} }).on("error", () => process.exit(1));\n`
  );
  const spec = bootSpec({
    install: append("install", 300),
    build: append("build"),
    seed: append("seed"),
    servers: [{ name: "api", start: api, url: `http://127.0.0.1:${apiPort}`, ready: "/ready" }],
    start: app,
    url: `http://127.0.0.1:${appPort}`,
    timeout: 20,
  })!;
  const baseline = process.listenerCount("SIGINT");
  const res = await startApp(spec, ws, { pollMs: 100 });
  try {
    assert.equal(res.ok, true, JSON.stringify(!res.ok && res.diagnosis));
    assert.equal(readFileSync(order, "utf8"), "install\nbuild\nseed\napi\napp\n");
    assert.deepEqual(
      res.handle.logFiles,
      ["install", "build", "seed", "api", "app"].map((n) => path.join(ws.artifactsDir, "logs", `boot-${n}.log`))
    );
    assert.equal(await canBind(appPort), false, "the app is still serving");
    assert.equal(process.listenerCount("SIGINT"), baseline + 1, "a signal handler guards the live groups");
  } finally {
    await res.handle.stop();
  }
  await res.handle.stop();
  assert.equal(await canBind(apiPort), true, "the API port is free again");
  assert.equal(await canBind(appPort), true, "the app port is free again");
  assert.equal(process.listenerCount("SIGINT"), baseline, "handlers are removed once everything stopped");
});

test("a server that exits before it is ready fails as app_not_ready naming it, without its output", { timeout: 30_000 }, async () => {
  const ws = workspace();
  const spec = bootSpec({
    servers: [{ name: "api", start: script(ws.root, "crash.js", `console.error("TAIL-FROM-LOG"); process.exit(1);\n`), url: `http://127.0.0.1:${await freePort()}` }],
    start: "exit 1",
    url: `http://127.0.0.1:${await freePort()}`,
  })!;
  const res = await startApp(spec, ws, { pollMs: 100 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.failedStep, "api");
  assert.deepEqual({ stage: res.diagnosis.stage, code: res.diagnosis.code }, { stage: "start", code: "app_not_ready" });
  assert.equal(res.diagnosis.message, "the api server exited before it was ready");
  assert.match(readFileSync(res.handle.logFiles[0], "utf8"), /TAIL-FROM-LOG/, "the output lands in the boot log");
  assert.equal(res.handle.logFiles.length, 1, "the app is never started after a failed server");
});

test("a server that never answers times out, and its port is free again afterwards", { timeout: 30_000 }, async () => {
  const ws = workspace();
  const port = await freePort();
  // Holds the port but never answers HTTP.
  const cmd = script(ws.root, "silent.js", `require("net").createServer(() => {}).listen(${port}, "127.0.0.1");\n`);
  const spec: BootSpec = { steps: [{ name: "app", kind: "server", cmd, url: `http://127.0.0.1:${port}`, readyUrl: `http://127.0.0.1:${port}`, timeoutMs: 1_500 }], baseUrl: `http://127.0.0.1:${port}`, login: null };
  const started = Date.now();
  const res = await startApp(spec, ws, { pollMs: 100 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.diagnosis.message, "the app server did not answer at its ready URL within 2s");
  assert.ok(Date.now() - started < 15_000);
  assert.equal(await canBind(port), true, "the silent server was killed");
});

test("a failing setup step names its stage", { timeout: 30_000 }, async () => {
  const ws = workspace();
  const url = `http://127.0.0.1:${await freePort()}`;
  const install = await startApp(bootSpec({ install: "exit 3", start: "true", url })!, ws);
  assert.deepEqual(!install.ok && install.diagnosis, { stage: "install", code: "install_failed", message: "the install command failed" });
  const seed = await startApp(bootSpec({ seed: "exit 1", start: "true", url })!, ws);
  assert.deepEqual(!seed.ok && seed.diagnosis, { stage: "services", code: "unknown", message: "the seed command failed" });
  const spec: BootSpec = { steps: [{ name: "build", kind: "setup", cmd: "sleep 30", timeoutMs: 500 }], baseUrl: url, login: null };
  const build = await startApp(spec, ws);
  assert.deepEqual(!build.ok && build.diagnosis, { stage: "build", code: "install_failed", message: "the build command did not finish within 1s" });
});

test("runLogin hands the script its paths, validates the storage state and keeps it private", { timeout: 30_000 }, async () => {
  const ws = workspace();
  const login = (source: string, cmd = script(ws.root, "login.js", source)): BootSpec => ({ steps: [], baseUrl: "http://127.0.0.1:4173", login: { script: cmd, timeoutMs: 10_000 } });
  const good = await runLogin(
    login(`require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: process.env.DEVASIGN_BASE_URL, domain: "127.0.0.1", path: "/" }], origins: [] }));\n`),
    ws
  );
  assert.equal(good.ok, true, JSON.stringify(!good.ok && good.diagnosis));
  if (!good.ok) return;
  assert.equal(good.storageStatePath, authStatePath(ws));
  assert.equal(good.storageStatePath, path.join(ws.dir, "auth", "state.json"));
  assert.equal(good.state.cookies[0].value, "http://127.0.0.1:4173");
  assert.equal(statSync(path.dirname(good.storageStatePath)).mode & 0o777, 0o700);

  const badJson = await runLogin(login(`require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, "{not json");\n`), ws);
  assert.deepEqual(!badJson.ok && badJson.diagnosis, { stage: "login", code: "login_failed", message: "the login script did not write a Playwright storage state" });
  const wrongShape = await runLogin(login(`require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: {} , origins: [] }));\n`), ws);
  assert.equal(!wrongShape.ok && wrongShape.diagnosis.message, "the login script did not write a Playwright storage state");
  const noFile = await runLogin(login(`// writes nothing\n`), ws);
  assert.equal(!noFile.ok && noFile.diagnosis.message, "the login script did not write a Playwright storage state", "a state left by an earlier login does not count");
  const crashed = await runLogin(login("", `${node} -e "process.exit(2)"`), ws);
  assert.deepEqual(!crashed.ok && crashed.diagnosis, { stage: "login", code: "login_failed", message: "the login script failed" });

  const slow = await runLogin({ steps: [], baseUrl: "http://127.0.0.1:4173", login: { script: "sleep 30", timeoutMs: 500 } }, ws);
  assert.equal(!slow.ok && slow.diagnosis.message, "the login script did not finish within 1s");

  cleanupAuth(ws);
  assert.equal(existsSync(path.join(ws.dir, "auth")), false);
});

test("cookieHeaderFor matches domain, path, expiry and secure like a browser would", () => {
  const future = Date.now() / 1000 + 3600;
  const s = state([
    { name: "host", value: "1", domain: "app.example.com" },
    { name: "dot", value: "2", domain: ".example.com" },
    { name: "other", value: "3", domain: "evil.com" },
    { name: "deep", value: "4", domain: "app.example.com", path: "/api" },
    { name: "old", value: "5", domain: "app.example.com", expires: Date.now() / 1000 - 60 },
    { name: "fresh", value: "6", domain: "app.example.com", expires: future },
    { name: "session", value: "7", domain: "app.example.com", expires: -1 },
    { name: "safe", value: "8", domain: "app.example.com", secure: true },
  ]);
  assert.equal(cookieHeaderFor("https://app.example.com/api/me", s), "deep=4; host=1; dot=2; fresh=6; session=7; safe=8");
  assert.equal(cookieHeaderFor("http://app.example.com/", s), "host=1; dot=2; fresh=6; session=7", "secure cookies stay off plain http");
  assert.equal(cookieHeaderFor("https://app.example.com/apix", s), "host=1; dot=2; fresh=6; session=7; safe=8", "/api does not match /apix");
  assert.equal(cookieHeaderFor("https://example.com/", s), "dot=2", "a host-only cookie does not reach the parent domain");
  assert.equal(cookieHeaderFor("https://x.app.example.com/", s), "dot=2", "a host-only cookie does not reach subdomains");
  assert.equal(cookieHeaderFor("https://notexample.com/", s), "");
  assert.equal(cookieHeaderFor("not a url", s), "");
});

test("checkSession sends the cookie and Origin, retries until 2xx, and enforces credentialed CORS across origins", { timeout: 30_000 }, async () => {
  const seen: Array<{ url: string; origin?: string; cookie?: string }> = [];
  let flaky = 0;
  const srv = await withServer((req, res) => {
    seen.push({ url: req.url!, origin: req.headers.origin, cookie: req.headers.cookie });
    const signedIn = req.headers.cookie === "sid=abc123";
    const cors: Record<string, Record<string, string>> = {
      "/cors-ok": { "access-control-allow-origin": String(req.headers.origin), "access-control-allow-credentials": "true" },
      "/cors-wrong": { "access-control-allow-origin": "http://evil.test", "access-control-allow-credentials": "true" },
      "/cors-none": {},
      "/cors-no-credentials": { "access-control-allow-origin": String(req.headers.origin) },
    };
    if (req.url === "/flaky" && flaky++ < 2) return res.writeHead(503).end();
    res.writeHead(signedIn ? 200 : 401, cors[req.url!] || {}).end();
  });
  try {
    const sameOrigin = `http://127.0.0.1:${srv.port}`;
    const s = state([{ name: "sid", value: "abc123", domain: "127.0.0.1" }, { name: "sid", value: "abc123", domain: "localhost" }]);

    const ok = await checkSession({ baseUrl: `${sameOrigin}/app`, check: "/me", state: s });
    assert.deepEqual(ok, { ok: true, status: 200 });
    assert.deepEqual(seen.at(-1), { url: "/me", origin: sameOrigin, cookie: "sid=abc123" });

    const retried = await checkSession({ baseUrl: sameOrigin, check: "/flaky", state: s, windowMs: 5_000 });
    assert.deepEqual(retried, { ok: true, status: 200 });

    const denied = await checkSession({ baseUrl: sameOrigin, check: "/me", state: state([]), windowMs: 700 });
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.diagnosis, { stage: "login", code: "login_failed", message: "the session check did not answer 2xx" });
    assert.equal(seen.at(-1)!.cookie, undefined, "no Cookie header without a matching cookie");

    // The app on localhost, the API on 127.0.0.1: a different origin.
    const app = `http://localhost:${srv.port}`;
    const cross = await checkSession({ baseUrl: app, check: `${sameOrigin}/cors-ok`, state: s });
    assert.deepEqual(cross, { ok: true, status: 200, cors: "ok" }, "a credentialed cross-origin check records that CORS allowed it");
    assert.equal(seen.at(-1)!.origin, app);

    const wrong = await checkSession({ baseUrl: app, check: `${sameOrigin}/cors-wrong`, state: s });
    assert.equal(!wrong.ok && wrong.cors, "mismatch");
    assert.equal(!wrong.ok && wrong.diagnosis.message, "the session check's CORS headers do not allow the app's origin");
    const none = await checkSession({ baseUrl: app, check: `${sameOrigin}/cors-none`, state: s });
    assert.equal(!none.ok && none.cors, "missing");
    const noCredentials = await checkSession({ baseUrl: app, check: `${sameOrigin}/cors-no-credentials`, state: s });
    assert.equal(noCredentials.ok, false, "credentials must be allowed too");

    const down = await checkSession({ baseUrl: `http://127.0.0.1:${await freePort()}`, check: "/me", state: s, windowMs: 300 });
    assert.equal(!down.ok && down.status, null);
  } finally {
    await srv.close();
  }
});

test("redact removes secret env values, cookie headers and storage-state values, longest first", () => {
  const env = { MY_SECRET: "abcdef", API_TOKEN: "abcdefghij", CUSTOM_VAR: "custom-value", PUBLIC_URL: "http://visible.test", SHORT_KEY: "abc" };
  const s = state([{ name: "sid", value: "s3ss10n-value" }, { name: "t", value: "1" }], [{ origin: "http://x", localStorage: [{ name: "jwt", value: "eyJhbGciOi.payload" }] }]);
  const text = [
    "token abcdefghij and abcdef",
    "custom custom-value",
    "public http://visible.test short abc",
    "> Cookie: sid=whatever; other=zzz",
    "< Set-Cookie: fresh=never-seen-before; HttpOnly",
    "sent sid=s3ss10n-value and t=1",
    "bare s3ss10n-value and encoded " + encodeURIComponent("s3ss10n-value"),
    "stored eyJhbGciOi.payload",
  ].join("\n");
  const out = redact(text, { envNames: ["CUSTOM_VAR"], env, state: s });
  for (const leaked of ["abcdef", "ghij", "custom-value", "whatever", "zzz", "never-seen-before", "s3ss10n-value", "t=1", "eyJhbGciOi"]) {
    assert.ok(!out.includes(leaked), `"${leaked}" survived:\n${out}`);
  }
  assert.match(out, /public http:\/\/visible\.test short abc/, "non-secret names and short values stay readable");
  assert.match(out, /Set-Cookie: \[redacted\]/);
  assert.match(out, /sent sid=\[redacted\] and t=\[redacted\]/);
  assert.equal(redact("no custom-value here", { env, state: null }), "no custom-value here", "an unnamed, unsecret-looking var is left alone");
});

test("a session value that cannot be URL-encoded is still redacted, and never throws", () => {
  // This scrub runs inside a stream handler: a throw there is an uncaught exception that
  // ends the probe and turns the customer's setup PR red. page.context().storageState()
  // hands back whatever the app kept, lone surrogates included.
  const lone = "abcdef\ud800ghijkl";
  const s = state([{ name: "sid", value: lone }], [{ origin: "http://x", localStorage: [{ name: "draft", value: lone }] }]);
  const out = redact(`bare ${lone} here`, { envNames: [], env: {}, state: s });
  assert.ok(!out.includes(lone), "the value is still swapped out");
  assert.doesNotThrow(() => redact("nothing to match", { env: { TOKEN: lone }, state: s }));
});

test("redactFile scrubs a server log that printed a secret, and ignores a missing file", { timeout: 30_000 }, async () => {
  const ws = workspace();
  const port = await freePort();
  process.env.DV_BOOT_TEST_SECRET = "hunter2-very-secret";
  try {
    const spec = bootSpec({ start: script(ws.root, "leak.js", `console.log("booting with " + process.env.DV_BOOT_TEST_SECRET);\n${serverSource(port)}`), url: `http://127.0.0.1:${port}` })!;
    const res = await startApp(spec, ws, { pollMs: 100 });
    assert.equal(res.ok, true);
    await res.handle.stop();
    const logFile = res.handle.logFiles[0];
    assert.match(readFileSync(logFile, "utf8"), /hunter2-very-secret/, "the raw log holds the secret");
    redactFile(logFile, { env: process.env });
    const scrubbed = readFileSync(logFile, "utf8");
    assert.ok(!scrubbed.includes("hunter2-very-secret"), scrubbed);
    assert.match(scrubbed, /booting with \[redacted\]/);
    redactFile(path.join(ws.root, "missing.log"), { env: process.env });
  } finally {
    delete process.env.DV_BOOT_TEST_SECRET;
  }
});

test("bootManaged signs in and checks the session, and stops the servers when login fails", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const app = (ws: ReturnType<typeof workspace>) =>
    script(ws.root, "app.js", `require("http").createServer((q, s) => s.writeHead(q.url === "/me" && q.headers.cookie !== "sid=tok-123456" ? 401 : 200).end()).listen(${port}, "127.0.0.1");\n`);

  const ws = workspace();
  const writeState = script(ws.root, "login.js", `require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: "tok-123456", domain: "127.0.0.1", path: "/" }], origins: [] }));\n`);
  const ok = await bootManaged({ start: app(ws), url, login: { script: writeState, check: "/me" } }, ws, { pollMs: 100 });
  try {
    assert.equal(ok.ok, true, JSON.stringify(!ok.ok && ok.diagnosis));
    if (!ok.ok) return;
    assert.equal(ok.sessionChecked, true);
    assert.equal(ok.baseUrl, url);
    assert.equal(ok.storageStatePath, authStatePath(ws));
    assert.equal(ok.state?.cookies[0].value, "tok-123456");
    assert.ok(ok.handle.logFiles.includes(path.join(ws.artifactsDir, "logs", "boot-login.log")));
  } finally {
    await ok.handle?.stop();
    cleanupAuth(ws);
  }
  assert.equal(await canBind(port), true);

  const ws2 = workspace();
  const wrongCookie = script(ws2.root, "login.js", `require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: "stale-999999", domain: "127.0.0.1", path: "/" }], origins: [] }));\nconsole.log("got sid=stale-999999");\n`);
  const rejected = await bootManaged({ start: app(ws2), url, login: { script: wrongCookie, check: "/me" } }, ws2, { pollMs: 100 });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.diagnosis.message, "the session check did not answer 2xx");
  assert.equal(await canBind(port), true, "the app is stopped when the session check fails");
  assert.equal(existsSync(path.join(ws2.dir, "auth")), false, "the rejected session file is removed");
  assert.ok(!readFileSync(path.join(ws2.artifactsDir, "logs", "boot-login.log"), "utf8").includes("stale-999999"), "failure logs are redacted");

  const ws3 = workspace();
  const failed = await bootManaged({ start: app(ws3), url, login: { script: "exit 1" } }, ws3, { pollMs: 100 });
  assert.deepEqual(!failed.ok && failed.diagnosis, { stage: "login", code: "login_failed", message: "the login script failed" });
  assert.equal(await canBind(port), true, "the app is stopped when login fails");

  // Signed in, printed what it got, saved it, then failed its own check: the saved values are still scrubbed.
  const ws4 = workspace();
  const leaky = exact(ws4.root, "login.js", `const fs = require("fs");\nconsole.log('login response {"token":"tok-leaked-777777"} cookie sid-leaked-888888 local jwt-leaked-999999');\nfs.writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [{ name: "sid", value: "sid-leaked-888888", domain: "127.0.0.1", path: "/" }], origins: [{ origin: "${url}", localStorage: [{ name: "auth", value: JSON.stringify({ token: "tok-leaked-777777" }) }] }] }));\nprocess.exit(1);\n`);
  const leakyRes = await bootManaged({ start: app(ws4), url, login: { script: leaky } }, ws4, { pollMs: 100 });
  if (leakyRes.ok) await leakyRes.handle.stop();
  assert.equal(!leakyRes.ok && leakyRes.diagnosis.message, "the login script failed");
  const leakyLog = readFileSync(path.join(ws4.artifactsDir, "logs", "boot-login.log"), "utf8");
  for (const v of ["tok-leaked-777777", "sid-leaked-888888"]) assert.ok(!leakyLog.includes(v), `${v} survived:\n${leakyLog}`);
  assert.match(leakyLog, /jwt-leaked-999999/, "only what the script saved is known to be session");
  const ws5 = workspace();
  const halfJson = script(ws5.root, "login.js", `require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, '{"cookies":[{"name":"sid","value":"half-written-424242"');\nconsole.log("sid half-written-424242");\n`);
  const halfRes = await bootManaged({ start: app(ws5), url, login: { script: halfJson } }, ws5, { pollMs: 100 });
  if (halfRes.ok) await halfRes.handle.stop();
  assert.equal(!halfRes.ok && halfRes.diagnosis.message, "the login script did not write a Playwright storage state");
  assert.ok(!readFileSync(path.join(ws5.artifactsDir, "logs", "boot-login.log"), "utf8").includes("half-written-424242"), "a truncated state file's strings are scrubbed too");
  assert.equal(existsSync(path.join(ws5.dir, "auth")), false);

  const none = await bootManaged({ url }, ws3);
  assert.equal(!none.ok && none.handle, null);
});

test("a server whose url already answers before it starts is refused, so tests never run against a leftover", { timeout: 30_000 }, async () => {
  const foreign = await withServer((_q, r) => r.end("someone else"));
  const ws = workspace();
  const marker = path.join(ws.root, "started.txt");
  try {
    const spec = bootSpec({
      servers: [{ name: "api", start: `echo started > ${JSON.stringify(marker)}`, url: `http://127.0.0.1:${foreign.port}` }],
      start: "true",
      url: `http://127.0.0.1:${await freePort()}`,
    })!;
    const res = await startApp(spec, ws, { pollMs: 100 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.deepEqual(res.diagnosis, { stage: "start", code: "app_not_ready", message: "something else was already answering at the api server's url" });
    assert.equal(res.failedStep, "api");
    assert.equal(existsSync(marker), false, "nothing was started");
    assert.deepEqual(res.handle.logFiles, [path.join(ws.artifactsDir, "logs", "boot-api.log")], "the doctor's log is the refused server's");
  } finally {
    await foreign.close();
  }
});

test("redact follows a session into the tokens requests carry: JSON, encoded and chunked values, IndexedDB records, auth headers", () => {
  const access = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.sig-access-0001";
  const refresh = "refresh-token-0002";
  const idb = "firebase-id-token-0003";
  const chunked = JSON.stringify({ access_token: "chunked-access-0004" });
  const s: StorageState = {
    cookies: [
      { name: "sb-ssr", value: `base64-${Buffer.from(JSON.stringify({ access_token: "ssr-access-0005" })).toString("base64")}`, domain: "localhost", path: "/" },
      { name: "sb-big.0", value: chunked.slice(0, 20), domain: "localhost", path: "/" },
      { name: "sb-big.1", value: chunked.slice(20), domain: "localhost", path: "/" },
      { name: "enc", value: encodeURIComponent(JSON.stringify({ token: "url-encoded-0006" })), domain: "localhost", path: "/" },
    ],
    origins: [{
      origin: "http://localhost:4173",
      localStorage: [{ name: "sb-x-auth-token", value: JSON.stringify({ access_token: access, refresh_token: refresh, user: { id: 7 } }) }],
      indexedDB: [{ name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", autoIncrement: false, records: [{ key: "user", value: { stsTokenManager: { accessToken: idb } } }] }] }],
    }],
  };
  const trace = [
    JSON.stringify({ type: "request", headers: [{ name: "authorization", value: `Bearer ${access}` }, { name: "X-Api-Key", value: "unrelated-key-value" }, { name: "accept", value: "application/json" }] }),
    JSON.stringify({ type: "context-options", options: { extraHTTPHeaders: { Authorization: "Basic dXNlcjpwYXNz" }, storageState: s } }),
    JSON.stringify({ body: `{"refresh":"${refresh}","ssr":"ssr-access-0005","big":"chunked-access-0004","enc":"url-encoded-0006"}` }),
  ].join("\n");
  const out = redact(trace, { env: {}, state: s, json: true });
  for (const leak of [access, refresh, idb, "ssr-access-0005", "chunked-access-0004", "url-encoded-0006", "dXNlcjpwYXNz", "unrelated-key-value"]) {
    assert.ok(!out.includes(leak), `${leak} survived:\n${out}`);
  }
  for (const line of out.split("\n")) JSON.parse(line);
  assert.match(out, /"name":"accept","value":"application\/json"/, "other headers stay readable");

  const log = redact(`> Authorization: Bearer opaque-bearer-0007\n> proxy-authorization: Basic abcdefgh\nx-api-key: k-0008-zzzz\nuser 7 fetched`, { env: {}, state: null });
  for (const leak of ["opaque-bearer-0007", "abcdefgh", "k-0008-zzzz"]) assert.ok(!log.includes(leak), log);
  assert.match(log, /user 7 fetched/);
});

const bootModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "boot.ts")).href;

// A real process that booted a server and signed in, so its signal and exit handlers can be exercised.
async function bootedChild(then: "wait" | "exit") {
  const ws = workspace();
  const port = await freePort();
  const login = exact(ws.root, "login.js", `require("fs").writeFileSync(process.env.DEVASIGN_STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }));\n`);
  const file = path.join(ws.root, "child.mts");
  writeFileSync(
    file,
    [
      `import { bootManaged } from ${JSON.stringify(bootModule)};`,
      `const res = await bootManaged({ start: ${JSON.stringify(script(ws.root, "app.js", serverSource(port)))}, url: "http://127.0.0.1:${port}", login: { script: ${JSON.stringify(login)} } }, ${JSON.stringify(ws)}, { pollMs: 100 });`,
      `console.log(res.ok ? "up" : "failed: " + res.diagnosis.message);`,
      then === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);",
    ].join("\n")
  );
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  const child = spawn(process.execPath, ["--import", "tsx/esm", file], { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const first = await new Promise<string>((resolve) => {
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l === "up" || l.startsWith("failed"));
      if (line) resolve(line);
    });
    child.once("exit", () => resolve(buf));
  });
  // SIGTERM first so its own handlers stop the server; a child that ignores it must not hang the suite or leak it.
  const done = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000).unref())]);
    if (!gone) {
      child.kill("SIGKILL");
      spawnSync("pkill", ["-KILL", "-f", ws.root]);
      await exited;
    }
  };
  return { ws, port, exited, first, child, done };
}

async function eventuallyBindable(port: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!(await canBind(port))) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`${sig} while signed in stops the servers, deletes the saved session, and exits ${code}`, { timeout: 60_000 }, async () => {
    const { ws, port, child, exited, first, done } = await bootedChild("wait");
    try {
      assert.equal(first, "up");
      assert.equal(await canBind(port), false, "the app is serving");
      assert.ok(existsSync(authStatePath(ws)), "the session was saved");
      child.kill(sig);
      const result = await Promise.race([exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), 15_000).unref())]);
      assert.deepEqual(result, { code, signal: null }, "the handler exits instead of swallowing the signal");
      assert.equal(await canBind(port), true, "the server group was stopped before exiting");
      assert.equal(existsSync(path.join(ws.dir, "auth")), false, "the saved session does not outlive a cancelled run");
    } finally {
      await done();
    }
  });
}

test("a process that exits without stopping anything still kills its servers and deletes the saved session", { timeout: 60_000 }, async () => {
  const { ws, port, exited, first, done } = await bootedChild("exit");
  try {
    assert.equal(first, "up");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(await eventuallyBindable(port), true, "the exit handler SIGKILLed the group");
    assert.equal(existsSync(path.join(ws.dir, "auth")), false);
  } finally {
    await done();
  }
});
