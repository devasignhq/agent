// Integration: the real CLI against an in-process fake /v1 (fixture plan,
// self-hosted signed PUT, captured results) on the no-framework fixture app.
// Needs Playwright's Chromium (npx playwright install chromium). Run:
//   npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";
import { staticTokenSource } from "../src/oidc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "..", "fixtures", "no-framework-app");
const plan = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "plan.json"), "utf8"));

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
