// Login-CSRF guard on the GitHub OAuth flow. startOAuth must bind the state to
// the caller's browser with an httpOnly github_oauth_state cookie; finishOAuth
// must reject any callback whose state isn't BOTH live in the pending-state map
// AND equal to that cookie — so an attacker's captured (code, state) can't be
// replayed in a victim's browser to log them into the attacker's account. The
// rejection paths return before any network call, so these run fully offline.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/github/oauth-csrf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { startOAuth, finishOAuth } from "./oauth.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, cookies: {}, cleared: [], redirectedTo: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.cookie = (name: string, value: string, opts: any) => { res.cookies[name] = { value, opts }; return res; };
  res.clearCookie = (name: string, opts: any) => { res.cleared.push({ name, opts }); return res; };
  res.redirect = (url: string) => { res.redirectedTo = url; return res; };
  return res;
}

// A top-level GET landing on the API host, as GitHub's redirect arrives.
const startReq = () => ({ protocol: "https", get: () => "api.devasign.ai" }) as any;

// startOAuth 503s unless OAuth is configured; give it dummy creds and restore so
// the shared test process isn't polluted.
function withOAuthConfigured(fn: () => void) {
  const id = config.github.oauthClientId, secret = config.github.oauthClientSecret;
  config.github.oauthClientId = "client-id";
  config.github.oauthClientSecret = "client-secret";
  try { fn(); } finally {
    config.github.oauthClientId = id;
    config.github.oauthClientSecret = secret;
  }
}

// Run the real startOAuth and return the state it minted (also now live in the
// module's pending-state map), so finishOAuth tests exercise a genuine entry.
function mintState(): string {
  let state = "";
  withOAuthConfigured(() => {
    const res = fakeRes();
    startOAuth(startReq(), res);
    state = new URL(res.redirectedTo).searchParams.get("state")!;
  });
  return state;
}

test("startOAuth binds the state to the browser via an httpOnly Lax cookie", () => {
  withOAuthConfigured(() => {
    const res = fakeRes();
    startOAuth(startReq(), res);
    const state = new URL(res.redirectedTo).searchParams.get("state");
    assert.ok(state, "redirect carries a state param");
    const cookie = res.cookies["github_oauth_state"];
    assert.ok(cookie, "github_oauth_state cookie is set");
    assert.equal(cookie.value, state, "cookie value equals the redirect's state");
    assert.equal(cookie.opts.httpOnly, true);
    assert.equal(cookie.opts.sameSite, "lax");
  });
});

test("finishOAuth rejects a callback with NO state cookie (login-CSRF replay)", async () => {
  const state = mintState();
  const res = fakeRes();
  await finishOAuth({ query: { code: "c", state }, cookies: {} } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "Invalid OAuth state");
});

test("finishOAuth rejects when the cookie state doesn't match the query state", async () => {
  const state = mintState();
  const res = fakeRes();
  await finishOAuth(
    { query: { code: "c", state }, cookies: { github_oauth_state: "attacker-state" } } as any,
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "Invalid OAuth state");
});

test("finishOAuth rejects an unknown state even if it matches a forged cookie", async () => {
  // State never went through startOAuth, so it isn't in the pending map; a
  // matching cookie must not be enough on its own.
  const res = fakeRes();
  await finishOAuth(
    { query: { code: "c", state: "never-issued" }, cookies: { github_oauth_state: "never-issued" } } as any,
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "Invalid OAuth state");
});
