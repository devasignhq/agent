// Multi-app OAuth return: startOAuth captures which first-party app initiated
// the flow (?app=) plus a same-app return path (?returnTo=), and finishOAuth
// redirects back there instead of always landing on the sponsor dashboard.
// sanitizeReturnTo must make an open redirect impossible: only single-slash
// rooted paths survive; everything else degrades to "/". The success-path test
// stubs global fetch so the GitHub token/user exchange runs fully offline.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/github/oauth-returnto.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { startOAuth, finishOAuth, sanitizeReturnTo } from "./oauth.js";

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

const startReq = (query: Record<string, string> = {}) =>
  ({ protocol: "https", get: () => "api.devasign.ai", query, cookies: {} }) as any;

function withOAuthConfigured(fn: () => void | Promise<void>) {
  const id = config.github.oauthClientId, secret = config.github.oauthClientSecret;
  config.github.oauthClientId = "client-id";
  config.github.oauthClientSecret = "client-secret";
  const done = () => {
    config.github.oauthClientId = id;
    config.github.oauthClientSecret = secret;
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(done);
  done();
}

// Run the real startOAuth with the given query and hand back the minted state.
function mintState(query: Record<string, string>): string {
  let state = "";
  withOAuthConfigured(() => {
    const res = fakeRes();
    startOAuth(startReq(query), res);
    state = new URL(res.redirectedTo).searchParams.get("state")!;
  });
  return state;
}

// Minimal GitHub API stub: token exchange, /user, /user/emails, /user/installations.
// Everything else 404s (adoptUserInstallations et al. degrade gracefully).
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    const json = (body: unknown, ok = true, status = 200) =>
      ({ ok, status, json: async () => body }) as any;
    if (url.includes("login/oauth/access_token")) return json({ access_token: "tok" });
    if (url.endsWith("/user")) return json({ id: 424242, login: "testdev", email: null, avatar_url: "" });
    if (url.includes("/user/emails")) return json([]);
    if (url.includes("/user/installations")) return json({ installations: [] });
    return json({}, false, 404);
  }) as any;
  return () => { globalThis.fetch = original; };
}

test("sanitizeReturnTo: only single-slash rooted paths survive", () => {
  assert.equal(sanitizeReturnTo("/bounties/abc?apply=1"), "/bounties/abc?apply=1");
  assert.equal(sanitizeReturnTo("/"), "/");
  assert.equal(sanitizeReturnTo(undefined), "/");
  assert.equal(sanitizeReturnTo(""), "/");
  assert.equal(sanitizeReturnTo("https://evil.com/x"), "/");
  assert.equal(sanitizeReturnTo("//evil.com"), "/");
  assert.equal(sanitizeReturnTo("/\\evil.com"), "/");
  assert.equal(sanitizeReturnTo("/a\\b"), "/");
  assert.equal(sanitizeReturnTo("javascript:alert(1)"), "/");
  assert.equal(sanitizeReturnTo("/weird:scheme/path"), "/");
  // A colon after ? is a legitimate query value, not a scheme.
  assert.equal(sanitizeReturnTo("/x?t=a:b"), "/x?t=a:b");
});

test("finishOAuth redirects the contributor app back to its return path with auth=ok", async () => {
  const state = mintState({ app: "contributor", returnTo: "/bounties/bnty-1?apply=1" });
  const restore = stubFetch();
  try {
    await withOAuthConfigured(async () => {
      const res = fakeRes();
      await finishOAuth(
        { query: { code: "c", state }, cookies: { github_oauth_state: state } } as any,
        res
      );
      const dest = new URL(res.redirectedTo);
      assert.equal(dest.origin, new URL(config.contributorOrigin).origin);
      assert.equal(dest.pathname, "/bounties/bnty-1");
      assert.equal(dest.searchParams.get("apply"), "1", "original query params preserved");
      assert.equal(dest.searchParams.get("auth"), "ok");
    });
  } finally {
    restore();
  }
});

test("finishOAuth without app/returnTo lands on the sponsor dashboard exactly as before", async () => {
  const state = mintState({});
  const restore = stubFetch();
  try {
    await withOAuthConfigured(async () => {
      const res = fakeRes();
      await finishOAuth(
        { query: { code: "c", state }, cookies: { github_oauth_state: state } } as any,
        res
      );
      assert.equal(res.redirectedTo, `${config.webOrigin}/?auth=ok`);
    });
  } finally {
    restore();
  }
});

test("an unknown app key falls back to the sponsor origin, and a hostile returnTo degrades to /", async () => {
  const state = mintState({ app: "not-a-real-app", returnTo: "https://evil.com/phish" });
  const restore = stubFetch();
  try {
    await withOAuthConfigured(async () => {
      const res = fakeRes();
      await finishOAuth(
        { query: { code: "c", state }, cookies: { github_oauth_state: state } } as any,
        res
      );
      assert.equal(res.redirectedTo, `${config.webOrigin}/?auth=ok`);
    });
  } finally {
    restore();
  }
});
