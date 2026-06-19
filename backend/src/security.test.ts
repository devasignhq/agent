// Guards the helmet tuning in security.ts. The one that bites in production and
// NOT in local dev is Cross-Origin-Opener-Policy: the auth / GitHub-App-install
// / Linear-connect popups are opened from WEB_ORIGIN and navigate cross-origin
// to this API, so a `same-origin` COOP on our OAuth 302s severs the popup's
// window.opener — the popup then can't hand off + self-close and the whole SPA
// mounts inside it. Locally the API is same-origin (proxied) so the severance
// never reproduces; this test is the only thing standing between a future
// "tighten the security headers" change and silently re-breaking the popups.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/security.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "./security.js";

// Run the (synchronous) helmet middleware against a fake res that records every
// header it sets, and return the lower-cased header bag.
function collectHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value);
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  let called = false;
  securityHeaders({ secure: true, headers: {} } as any, res, () => {
    called = true;
  });
  assert.ok(called, "helmet middleware must call next()");
  return headers;
}

test("no Cross-Origin-Opener-Policy header (it would sever the OAuth popup's window.opener)", () => {
  const headers = collectHeaders();
  assert.equal(headers["cross-origin-opener-policy"], undefined);
});

test("Cross-Origin-Resource-Policy is cross-origin so the SPA can read API responses", () => {
  const headers = collectHeaders();
  assert.equal(headers["cross-origin-resource-policy"], "cross-origin");
});

test("no Content-Security-Policy header (a CSP belongs on the HTML host, not this JSON API)", () => {
  const headers = collectHeaders();
  assert.equal(headers["content-security-policy"], undefined);
});

test("baseline helmet headers still applied (e.g. X-Content-Type-Options)", () => {
  const headers = collectHeaders();
  assert.equal(headers["x-content-type-options"], "nosniff");
});
