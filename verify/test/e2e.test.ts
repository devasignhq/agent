// Integration: the real CLI against an in-process fake /v1 (fixture plan,
// self-hosted signed PUT, captured results) on the no-framework and two-server fixture apps.
// Needs Playwright's Chromium (npx playwright install chromium). Run:
//   npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../src/run.js";
import { staticTokenSource } from "../src/oidc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "..", "fixtures", "no-framework-app");
const twoServer = path.join(here, "..", "fixtures", "two-server-app");
const plan = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "plan.json"), "utf8"));
const { yauzl } = createRequire(import.meta.url)("playwright-core/lib/zipBundle");

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c)));
  });
}

test("run: resolve → execute → upload artifacts via signed PUT → post results", async () => {
  const uploads = new Map<string, { bytes: number; contentType: string }>();
  const signed: any[] = [];
  let results: any = null;
  let resolves = 0;
  let port = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const json = (code: number, b: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/v1/runs/resolve") {
      assert.equal(req.headers.authorization, "Bearer dev-token");
      resolves += 1;
      const b = JSON.parse((await body(req)).toString());
      assert.equal(b.pr, 7);
      assert.equal(b.sha, "abc1234");
      if (resolves === 1) {
        assert.ok(b.setup?.frameworks, "setup is posted on the first resolve");
        return json(202, { ok: true, status: "pending", runId: null, retryAfterMs: 100 });
      }
      return json(200, { ok: true, status: "ready", runId: "run-1", plan });
    }
    if (url.pathname === "/v1/runs/run-1/artifacts") {
      const b = JSON.parse((await body(req)).toString());
      const base = signed.length;
      signed.push(...b.files);
      return json(200, { ok: true, rejected: [], uploads: b.files.map((f: any, i: number) => ({ clientRef: f.clientRef, artifactId: `art-${base + i}`, putUrl: `http://127.0.0.1:${port}/put/${encodeURIComponent(f.clientRef)}`, headers: { "Content-Type": f.contentType }, urlExpiresAt: 0, retentionExpiresAt: 0 })) });
    }
    if (url.pathname.startsWith("/put/") && req.method === "PUT") {
      const buf = await body(req);
      uploads.set(decodeURIComponent(url.pathname.slice(5)), { bytes: buf.length, contentType: String(req.headers["content-type"]) });
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === "/v1/runs/run-1/results") {
      results = JSON.parse((await body(req)).toString());
      return json(200, { ok: true, runId: "run-1", status: "judging" });
    }
    json(404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
  rmSync(path.join(fixture, ".devasign"), { recursive: true, force: true });
  try {
    const code = await run({ apiUrl: `http://127.0.0.1:${port}`, token: staticTokenSource("dev-token"), failOn: "never", resolveTimeoutMs: 30_000, testTimeoutMs: 120_000, keep: false, cwd: fixture, pr: 7, sha: "abc1234" });
    assert.equal(code, 0);
    assert.ok(results, "results were posted");
    assert.equal(results.runId, "run-1");
    assert.equal(results.planId, "plan-fixture");
    const byTest = new Map<string, any>(results.results.map((r: any) => [r.testId, r]));
    assert.equal(byTest.get("t1").status, "pass");
    assert.equal(byTest.get("t4").status, "flaky");
    assert.equal(byTest.get("t2").status, "pass");
    assert.equal(byTest.get("t3").status, "fail");
    assert.equal(byTest.get("t3").attempts.length, 3, "Playwright retried twice");
    assert.equal(results.doctor, null);
    const kinds = signed.reduce((m: Record<string, number>, f: any) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {});
    assert.ok(kinds.video >= 4 && kinds.trace >= 4 && kinds.screenshot >= 4 && kinds.poster >= 4, `recordings for every attempt: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.test_file, 4);
    assert.ok(kinds.log >= 4);
    assert.equal(uploads.size, signed.length, "every signed file was PUT");
    const video = signed.find((f: any) => f.kind === "video");
    assert.equal(uploads.get(video.clientRef)?.contentType, "video/webm");
    assert.ok(uploads.get(video.clientRef)!.bytes > 1000, "the webm has bytes");
    const poster = signed.find((f: any) => f.kind === "poster");
    assert.ok(poster.posterFor?.startsWith("video:"), "poster references its video");
    for (const r of results.results) for (const a of r.attempts) for (const id of a.artifactIds) assert.match(id, /^art-/, "attempt artifact refs were replaced by ids");
    assert.equal(existsSync(path.join(fixture, ".devasign")), false, "the workspace is cleaned up");
    assert.equal(existsSync(path.join(fixture, "package.json")), false, "no package.json was created");
  } finally {
    server.close();
  }
});

test("run: an empty plan uploads empty results and exits 0", async () => {
  let results: any = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const json = (code: number, b: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/v1/runs/resolve") {
      await body(req);
      return json(200, { ok: true, status: "ready", runId: "run-2", plan: { ...plan, tests: [], criteria: [] } });
    }
    if (url.pathname === "/v1/runs/run-2/results") {
      results = JSON.parse((await body(req)).toString());
      return json(200, { ok: true, runId: "run-2", status: "judging" });
    }
    json(404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const code = await run({ apiUrl: `http://127.0.0.1:${port}`, token: staticTokenSource("t"), failOn: "never", resolveTimeoutMs: 5_000, testTimeoutMs: 5_000, keep: false, cwd: fixture, pr: 7, sha: "abc1234" });
    assert.equal(code, 0);
    assert.deepEqual(results.results, []);
  } finally {
    server.close();
  }
});

type Upload = { body: Buffer; contentType: string };
type FakeApi = { url: string; resolves: any[]; signed: any[]; uploads: Map<string, Upload>; results: () => any; close: () => void };

async function fakeApi(runId: string, ready: unknown): Promise<FakeApi> {
  const resolves: any[] = [];
  const signed: any[] = [];
  const uploads = new Map<string, Upload>();
  let results: any = null;
  let port = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const json = (code: number, b: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/v1/runs/resolve") {
      resolves.push(JSON.parse((await body(req)).toString()));
      return json(200, { ok: true, status: "ready", runId, plan: ready });
    }
    if (url.pathname === `/v1/runs/${runId}/artifacts`) {
      const b = JSON.parse((await body(req)).toString());
      const base = signed.length;
      signed.push(...b.files);
      return json(200, { ok: true, rejected: [], uploads: b.files.map((f: any, i: number) => ({ clientRef: f.clientRef, artifactId: `art-${base + i}`, putUrl: `http://127.0.0.1:${port}/put/${encodeURIComponent(f.clientRef)}`, headers: { "Content-Type": f.contentType }, urlExpiresAt: 0, retentionExpiresAt: 0 })) });
    }
    if (url.pathname.startsWith("/put/") && req.method === "PUT") {
      uploads.set(decodeURIComponent(url.pathname.slice(5)), { body: await body(req), contentType: String(req.headers["content-type"]) });
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === `/v1/runs/${runId}/results`) {
      results = JSON.parse((await body(req)).toString());
      return json(200, { ok: true, runId, status: "judging" });
    }
    json(404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, resolves, signed, uploads, results: () => results, close: () => server.close() };
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "localhost");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

async function eventuallyClosed(port: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (await listening(port)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

const e2eTest = (id: string, criterionId: string, content: string) => ({ id, path: `.devasign/tests/e2e/criterion-${criterionId}.spec.ts`, criterionIds: [criterionId], level: "e2e", levelReason: "visible in the UI", origin: "generated", runner: "playwright", testSignature: `s-${id}`, strategyVersion: 1, targetFiles: ["index.html"], content });

const signedInPlan = {
  ...plan,
  planId: "plan-two-server",
  criteria: [
    { id: "1", text: "The account page shows who is signed in", kind: "ui" },
    { id: "2", text: "Without a session the account page says signed out", kind: "ui" },
  ],
  tests: [
    e2eTest("t1", "1", 'import { test, expect } from "@playwright/test";\ntest("shows the signed-in user", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByTestId("session")).toHaveText("Signed in as ada", { timeout: 5000 });\n});\n'),
    // The fixture must really gate on the session, or t1 passing proves nothing.
    e2eTest("t2", "2", 'import { test, expect } from "@playwright/test";\ntest.use({ storageState: { cookies: [], origins: [] } });\ntest("a fresh browser is signed out", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByTestId("session")).toHaveText("Signed out", { timeout: 5000 });\n});\n'),
  ],
  retries: { generated: 0, existing: 0 },
};

async function fixtureSession(): Promise<string> {
  const { mint } = await import(pathToFileURL(path.join(twoServer, "session.mjs")).href);
  return mint("ada");
}

function unzipEntries(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip: any) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: any) =>
        zip.openReadStream(entry, (e: Error | null, stream: any) => {
          if (e) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => (out.set(entry.fileName, Buffer.concat(chunks)), zip.readEntry())).on("error", reject);
        })
      );
      zip.on("end", () => resolve(out)).on("error", reject);
      zip.readEntry();
    });
  });
}

// Trace zips are deflated, so a byte scan proves nothing: every entry is inflated and scanned instead.
async function assertNoSession(api: FakeApi, session: string, opts: { traces: boolean }) {
  assert.ok(session.length > 20);
  assert.ok(api.signed.some((f: any) => f.kind === "log"), "logs were among the scanned uploads");
  const traces = api.signed.filter((f: any) => f.kind === "trace");
  assert.equal(traces.length > 0, opts.traces, `trace uploads: ${traces.length}`);
  for (const f of api.signed) {
    const body = api.uploads.get(f.clientRef)!.body;
    if (f.kind !== "trace") {
      assert.equal(body.includes(session), false, `${f.clientRef} carries the session cookie`);
      continue;
    }
    const entries = await unzipEntries(body);
    assert.ok([...entries.keys()].some((n) => n.endsWith(".trace")), `${f.clientRef} is still a Playwright trace`);
    for (const [name, bytes] of entries) {
      assert.equal(bytes.includes(session), false, `${f.clientRef} ${name} carries the session cookie`);
      if (/\.(trace|network)$/.test(name)) for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) JSON.parse(line);
    }
  }
  assert.equal(JSON.stringify(api.results()).includes(session), false, "the results payload carries the session cookie");
}

// The fixtures use fixed ports; a leftover or concurrent run holding one would otherwise fail these cases obscurely.
async function assertPortsFree(...ports: number[]) {
  for (const port of ports) assert.equal(await listening(port), false, `port ${port} is taken; stop the other fixture run first`);
}

const uploadedText = (api: FakeApi, ref: string) => {
  const u = api.uploads.get(ref);
  assert.ok(u, `${ref} was uploaded (got ${[...api.uploads.keys()].join(", ")})`);
  return u.body.toString("utf8");
};

test("managed boot: api + web + login script → the generated test runs signed in, nothing uploaded carries the session", async () => {
  await assertPortsFree(4180, 4181);
  const api = await fakeApi("run-a", signedInPlan);
  const session = await fixtureSession();
  rmSync(path.join(twoServer, ".devasign"), { recursive: true, force: true });
  try {
    const code = await run({ apiUrl: api.url, token: staticTokenSource("t"), failOn: "never", resolveTimeoutMs: 10_000, testTimeoutMs: 120_000, keep: false, cwd: twoServer, pr: 9, sha: "def5678" });
    assert.equal(code, 0);
    assert.ok(api.resolves.length > 0 && api.resolves.every((b) => JSON.stringify(b.capabilities) === '["managed_boot"]'), "every resolve advertises managed_boot");
    const results = api.results();
    assert.ok(results, "results were posted");
    assert.equal(results.doctor, null);
    const byTest = new Map<string, any>(results.results.map((r: any) => [r.testId, r]));
    assert.equal(byTest.get("t1").status, "pass", JSON.stringify(byTest.get("t1")));
    assert.equal(byTest.get("t2").status, "pass", JSON.stringify(byTest.get("t2")));

    const refs = api.signed.map((f: any) => f.clientRef);
    for (const ref of ["log:boot:api", "log:boot:app", "log:boot:login", "log:pw:playwright.config.ts"]) assert.ok(refs.includes(ref), `${ref} in ${refs.join(", ")}`);
    assert.equal(api.uploads.size, api.signed.length, "every signed file was PUT");
    const apiLog = uploadedText(api, "log:boot:api");
    assert.match(apiLog, /fixture_session=\[redacted\] -> 200/, "the API saw the session, and the log says so only redacted");
    assert.match(uploadedText(api, "log:boot:login"), /signed in as ada .*fixture_session=\[redacted\]/);
    await assertNoSession(api, session, { traces: true });

    assert.equal(existsSync(path.join(twoServer, ".devasign")), false, "the workspace, session file included, is cleaned up");
    assert.equal(await listening(4180), false, "the api server was stopped");
    assert.equal(await listening(4181), false, "the web server was stopped");
  } finally {
    api.close();
  }
});

test("managed boot: a session check whose CORS does not allow the app's origin is a login_failed doctor, not a failed PR", async () => {
  await assertPortsFree(4180, 4181);
  const api = await fakeApi("run-c", signedInPlan);
  const session = await fixtureSession();
  rmSync(path.join(twoServer, ".devasign"), { recursive: true, force: true });
  process.env.TWO_SERVER_ALLOWED_ORIGIN = "http://localhost:4999";
  try {
    const code = await run({ apiUrl: api.url, token: staticTokenSource("t"), failOn: "never", resolveTimeoutMs: 10_000, testTimeoutMs: 120_000, keep: false, cwd: twoServer, pr: 9, sha: "def5678" });
    assert.equal(code, 0);
    const results = api.results();
    assert.equal(results.doctor?.stage, "login");
    assert.equal(results.doctor?.code, "login_failed");
    assert.match(results.doctor.message, /CORS headers do not allow the app's origin/);
    const loginLogId = `art-${api.signed.findIndex((f: any) => f.clientRef === "log:boot:login")}`;
    assert.equal(results.doctor.logArtifactId, loginLogId, "the doctor links the login step's log");
    assert.equal(results.results.length, 2);
    for (const r of results.results) {
      assert.equal(r.status, "error");
      assert.equal(r.error, results.doctor.message);
    }
    assert.equal(api.signed.some((f: any) => f.clientRef.startsWith("log:pw:")), false, "Playwright never ran");
    assert.match(uploadedText(api, "log:boot:api"), /origin=http:\/\/localhost:4181 fixture_session=\[redacted\] -> 200/, "the cookie was accepted; only CORS was wrong");
    await assertNoSession(api, session, { traces: false });
    assert.equal(existsSync(path.join(twoServer, ".devasign")), false);
    assert.equal(await listening(4180), false, "the api server was stopped");
    assert.equal(await listening(4181), false, "the web server was stopped");
  } finally {
    delete process.env.TWO_SERVER_ALLOWED_ORIGIN;
    api.close();
  }
});

test("legacy boot: a start/url-only yml still boots through Playwright's webServer, with its output in the pw log", async () => {
  const legacyPlan = { ...plan, planId: "plan-legacy", criteria: [plan.criteria[1]], tests: [plan.tests[1]], retries: { generated: 0, existing: 0 } };
  await assertPortsFree(4173);
  const api = await fakeApi("run-d", legacyPlan);
  rmSync(path.join(fixture, ".devasign"), { recursive: true, force: true });
  const shown: string[] = [];
  const consoleLog = console.log;
  console.log = (...args: unknown[]) => (shown.push(args.map(String).join(" ")), consoleLog(...args));
  try {
    const code = await run({ apiUrl: api.url, token: staticTokenSource("t"), failOn: "never", resolveTimeoutMs: 10_000, testTimeoutMs: 120_000, keep: false, cwd: fixture, pr: 7, sha: "abc1234" });
    console.log = consoleLog;
    assert.equal(code, 0);
    assert.ok(shown.some((l) => /1 passed/.test(l)), "Playwright's own output still reaches the job log");
    assert.equal(shown.some((l) => l.includes("[WebServer] fixture app on")), false, "the app's stdout stays out of the public job log");
    const results = api.results();
    assert.equal(results.doctor, null);
    assert.deepEqual(results.results.map((r: any) => [r.testId, r.status]), [["t2", "pass"]]);
    assert.ok(api.resolves.every((b) => JSON.stringify(b.capabilities) === '["managed_boot"]'));
    assert.equal(api.signed.some((f: any) => f.clientRef.startsWith("log:boot:")), false, "no managed boot ran");
    assert.match(uploadedText(api, "log:pw:playwright.config.ts"), /\[WebServer\] fixture app on http:\/\/localhost:4173/, "Playwright started the app and piped its stdout");
    assert.equal(existsSync(path.join(fixture, ".devasign")), false);
    assert.equal(await eventuallyClosed(4173), true, "Playwright stopped its webServer");
  } finally {
    console.log = consoleLog;
    api.close();
  }
});
