// Tests for the rate limiters in rate-limit.ts. They're Express middleware, so
// the only meaningful way to exercise them is through a real app over HTTP — we
// mount the *actual* exported limiters on a throwaway app, listen on an
// ephemeral port, and drive it with Node's built-in fetch (no supertest dep).
//
// `trust proxy: 1` mirrors server.ts: from a loopback connection that makes the
// single X-Forwarded-For entry stand in as req.ip, so each test can pick a
// distinct client IP and get its own bucket — the limiters share one
// per-process MemoryStore, so isolation-by-IP is what keeps tests independent.
//
// Run:
//   node --import tsx/esm --test src/rate-limit.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server, AddressInfo } from "node:net";
import express from "express";
import { authLimiter, expensiveLimiter, globalLimiter } from "./rate-limit.js";

let server: Server;
let base = "";

before(async () => {
  const app = express();
  // Mirror server.ts so req.ip resolves the same way the limiters expect.
  app.set("trust proxy", 1);

  // Global shield in front of everything, then echo routes. The skip rules are
  // the main thing asserted against these.
  app.use(globalLimiter);
  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/webhooks/github", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/webhooks/stripe", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/webhooks/linear", (_req, res) => { res.json({ ok: true }); });
  app.get("/api/me", (_req, res) => { res.json({ ok: true }); });

  // Routes behind the tighter buckets, used to prove the over-limit response
  // and the per-IP keying.
  app.get("/auth", authLimiter, (_req, res) => { res.json({ ok: true }); });
  app.post("/expensive", expensiveLimiter, (_req, res) => { res.json({ ok: true }); });

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    // Fail fast instead of hanging until the test timeout if the listen fails.
    server.on("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// Request as a chosen client IP (via X-Forwarded-For, believed because the test
// app trusts 1 hop) so every test gets an isolated limiter bucket.
function hit(path: string, ip: string, method = "GET") {
  return fetch(`${base}${path}`, { method, headers: { "X-Forwarded-For": ip } });
}

test("globalLimiter skips health + webhook paths (no RateLimit header, never throttled)", async () => {
  const skipped: Array<[string, string]> = [
    ["/api/health", "GET"],
    ["/health", "GET"],
    ["/api/webhooks/github", "POST"],
    ["/api/webhooks/stripe", "POST"],
    ["/api/webhooks/linear", "POST"],
  ];
  for (const [path, method] of skipped) {
    const res = await hit(path, "203.0.113.1", method);
    assert.equal(res.status, 200, `${path} should pass`);
    // A skipped request never touches the store, so no RateLimit header is set.
    assert.equal(
      res.headers.get("ratelimit"),
      null,
      `${path} should be skipped — no RateLimit header expected`
    );
  }
});

test("globalLimiter applies to a normal path (RateLimit header present)", async () => {
  const res = await hit("/api/me", "203.0.113.2");
  assert.equal(res.status, 200);
  assert.ok(
    res.headers.get("ratelimit"),
    "a non-skipped path should carry a RateLimit header"
  );
});

test("each limiter advertises its configured limit/window via RateLimit-Policy", async () => {
  // Cheap assertion of the configured ceilings — read the draft-7 policy header
  // instead of exhausting each bucket.
  const global = await hit("/api/me", "203.0.113.10");
  assert.equal(global.headers.get("ratelimit-policy"), "600;w=60");

  const auth = await hit("/auth", "203.0.113.11");
  assert.equal(auth.headers.get("ratelimit-policy"), "50;w=900");

  const expensive = await hit("/expensive", "203.0.113.12", "POST");
  assert.equal(expensive.headers.get("ratelimit-policy"), "30;w=60");
});

test("expensiveLimiter returns 429 rate_limited once past its limit of 30", async () => {
  const ip = "203.0.113.3";
  for (let i = 1; i <= 30; i++) {
    const res = await hit("/expensive", ip, "POST");
    assert.equal(res.status, 200, `request ${i} should be allowed`);
  }
  const blocked = await hit("/expensive", ip, "POST");
  assert.equal(blocked.status, 429, "the 31st request should be throttled");
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
});

test("limits are per-IP — a second client IP keeps its own bucket", async () => {
  const a = "203.0.113.4";
  const b = "203.0.113.5";
  for (let i = 1; i <= 30; i++) {
    assert.equal((await hit("/expensive", a, "POST")).status, 200);
  }
  // a is exhausted…
  assert.equal((await hit("/expensive", a, "POST")).status, 429);
  // …but b, a different appended IP, is untouched — proving the key is per-IP
  // (and that trust-proxy:1 keying reads the right address).
  assert.equal((await hit("/expensive", b, "POST")).status, 200);
});
