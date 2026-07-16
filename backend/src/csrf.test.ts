// Unit tests for the same-origin guard that mitigates CSRF on the SameSite=None
// prod cookie. Drives the exported middleware directly with a fake req/res/next,
// toggling config.secureCookies/webOrigin to exercise the dev-skip and the
// prod-enforce branches. No network, no db. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/csrf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { enforceSameOrigin } from "./csrf.js";

// Express's req.get() is case-insensitive; mirror that so a test asking for
// "origin" finds a header passed as "Origin".
function fakeReq(method: string, headers: Record<string, string> = {}): any {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, get: (h: string) => lower[h.toLowerCase()] };
}

function fakeRes(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

// next() records that the request was allowed through to the handler.
function runner() {
  let passed = false;
  return { next: () => { passed = true; }, passed: () => passed };
}

const WEB = "https://www.devasign.ai";

const CONTRIB = "https://contributors.devasign.ai";

// Run fn with prod-like config (SameSite=None ⇒ guard active), then restore so
// the shared config object doesn't bleed across tests.
function withProd(webOrigin: string, fn: () => void) {
  const secure = config.secureCookies, origin = config.webOrigin, contrib = config.contributorOrigin;
  (config as any).secureCookies = true;
  (config as any).webOrigin = webOrigin;
  (config as any).contributorOrigin = CONTRIB;
  try { fn(); } finally {
    (config as any).secureCookies = secure;
    (config as any).webOrigin = origin;
    (config as any).contributorOrigin = contrib;
  }
}

test("prod: cross-site Origin on an unsafe method is rejected 403", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Origin: "https://evil.com" }), res, r.next);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "bad_origin");
    assert.equal(r.passed(), false);
  });
});

test("prod: matching Origin passes through", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Origin: WEB }), res, r.next);
    assert.equal(r.passed(), true);
    assert.equal(res.statusCode, 200);
  });
});

test("prod: the contributor app's origin passes through (two-origin allowlist)", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Origin: CONTRIB }), res, r.next);
    assert.equal(r.passed(), true);
    assert.equal(res.statusCode, 200);
  });
});

test("prod: a foreign origin is still rejected with both first-party origins configured", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Origin: "https://contributors.devasign.ai.evil.com" }), res, r.next);
    assert.equal(res.statusCode, 403);
    assert.equal(r.passed(), false);
  });
});

test("prod: falls back to Referer when Origin is absent", () => {
  withProd(WEB, () => {
    const bad = fakeRes(), rb = runner();
    enforceSameOrigin(fakeReq("POST", { Referer: "https://evil.com/x" }), bad, rb.next);
    assert.equal(bad.statusCode, 403);
    assert.equal(rb.passed(), false);

    const ok = fakeRes(), ro = runner();
    enforceSameOrigin(fakeReq("POST", { Referer: `${WEB}/dashboard` }), ok, ro.next);
    assert.equal(ro.passed(), true);
  });
});

test("prod: no Origin/Referer is allowed (non-browser client, not a CSRF vector)", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST"), res, r.next);
    assert.equal(r.passed(), true);
  });
});

test("prod: a malformed Referer (unparseable) is treated as absent ⇒ allowed", () => {
  withProd(WEB, () => {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Referer: "not a url" }), res, r.next);
    assert.equal(r.passed(), true);
  });
});

test("prod: safe methods are never gated, even cross-site", () => {
  withProd(WEB, () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = fakeRes(), r = runner();
      enforceSameOrigin(fakeReq(method, { Origin: "https://evil.com" }), res, r.next);
      assert.equal(r.passed(), true, `${method} should pass`);
    }
  });
});

test("dev (Lax cookie): check is skipped — even a cross-site unsafe request passes", () => {
  const secure = config.secureCookies;
  (config as any).secureCookies = false;
  try {
    const res = fakeRes(), r = runner();
    enforceSameOrigin(fakeReq("POST", { Origin: "https://evil.com" }), res, r.next);
    assert.equal(r.passed(), true);
    assert.equal(res.statusCode, 200);
  } finally {
    (config as any).secureCookies = secure;
  }
});
