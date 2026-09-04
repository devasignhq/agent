// Routing was the one part of the app the .ts suite could not reach: the route
// table lived in JSX. These run react-router's real matchRoutes and generatePath
// over the same table app.tsx renders.
//
// Two things keep this honest. The URL strings are asserted against a literal
// list below rather than against ROUTE_PATHS, because a table that supplies its
// own expectations cannot catch a rename. And match() asserts it matched at all,
// because `match(x)?.path` is undefined on no-match and would otherwise compare
// equal to a route key that has been deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchRoutes, generatePath } from "react-router-dom";
import { ROUTE_PATHS, DEFAULT_ROUTE, DEFAULT_SETTINGS_PATH } from "./routes.ts";

const routes = Object.values(ROUTE_PATHS).map((path) => ({ path }));

function match(url: string) {
  const m = matchRoutes(routes, url);
  assert.ok(m && m.length > 0, `${url} matched no route at all`);
  const last = m[m.length - 1];
  return { path: last.route.path as string, params: last.params as Record<string, string | undefined> };
}

test("the URL surface is exactly this — bookmarks and backend deep links depend on it", () => {
  // Written out by hand on purpose: renaming a route must fail here first.
  assert.deepEqual({ ...ROUTE_PATHS }, {
    agent: "/agent",
    review: "/reviews/:reviewId",
    workflow: "/workflow",
    bounty: "/bounty",
    fundBounty: "/bounties/:id/fund",
    cancelBounty: "/bounties/:id/cancel",
    security: "/security",
    securityFinding: "/security/findings/:findingId",
    securityGate: "/security/gate",
    securityRulings: "/security/rulings",
    securityPolicy: "/security/policy",
    settings: "/settings",
    settingsSection: "/settings/:section",
    root: "/",
    catchAll: "*",
  });
  assert.equal(DEFAULT_ROUTE, "/agent");
  assert.equal(DEFAULT_SETTINGS_PATH, "/settings/account");
});

test("app.tsx renders exactly this table, and never a literal path", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
  const rendered = [...app.matchAll(/<Route\s+path=\{ROUTE_PATHS\.(\w+)\}/g)].map((m) => m[1]);
  assert.deepEqual(rendered.sort(), Object.keys(ROUTE_PATHS).sort());
  assert.equal(/<Route\s+path="/.test(app), false, "a Route path must come from ROUTE_PATHS");
});

test("every static route matches its own URL", () => {
  for (const path of Object.values(ROUTE_PATHS)) {
    if (path.includes(":") || path === "*") continue;
    assert.equal(match(path).path, path, `${path} should match itself`);
  }
});

test("param routes hand the screens the exact key they read off useParams", () => {
  // screen-fund-bounty reads params.id; screen-bounties reads params.id
  assert.deepEqual(match("/bounties/b-42/fund"), { path: "/bounties/:id/fund", params: { id: "b-42" } });
  assert.deepEqual(match("/bounties/b-42/cancel"), { path: "/bounties/:id/cancel", params: { id: "b-42" } });
  // screen-security destructures { findingId }
  assert.deepEqual(match("/security/findings/F-9"), { path: "/security/findings/:findingId", params: { findingId: "F-9" } });
  // screens-rest destructures { section }
  assert.deepEqual(match("/settings/billing"), { path: "/settings/:section", params: { section: "billing" } });
});

test("the money deep links the backend mints still resolve", () => {
  // backend/src/bounties/links.ts appends ?token=…; the screen refuses to fund without it.
  assert.deepEqual(match("/bounties/b1/fund?token=abc"), { path: "/bounties/:id/fund", params: { id: "b1" } });
  assert.deepEqual(match("/bounties/b1/cancel?token=abc"), { path: "/bounties/:id/cancel", params: { id: "b1" } });
  // An empty id is not a fundable URL; it must not reach the screen with id "".
  assert.equal(match("/bounties//fund").path, "*");
});

test("a bare /settings reaches its redirect rather than :section", () => {
  // Not a ranking test: /settings/:section requires a segment, so the two never compete.
  assert.equal(match("/settings").path, "/settings");
  assert.equal(match("/security/gate").path, "/security/gate");
  assert.equal(match("/security/rulings").path, "/security/rulings");
});

test("the catch-all takes unknown URLs and nothing else", () => {
  assert.equal(match("/nope").path, "*");
  assert.equal(match("/security/unknown/deep").path, "*");
  assert.equal(match("/").path, "/", "root must not fall through to the catch-all");
  assert.equal(match("/agent").path, "/agent");
});

test("both redirect targets are themselves routable", () => {
  assert.equal(match(DEFAULT_ROUTE).path, "/agent");
  const settings = match(DEFAULT_SETTINGS_PATH);
  assert.equal(settings.path, "/settings/:section");
  assert.equal(settings.params.section, "account", "SettingsPage falls back to account, so the redirect must land there");
});

test("generatePath round-trips every param route", () => {
  const stub: Record<string, string> = { id: "xyz", findingId: "F-1", section: "billing", reviewId: "rev-1" };
  for (const path of Object.values(ROUTE_PATHS)) {
    if (!path.includes(":")) continue;
    const names = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const url = generatePath(path, Object.fromEntries(names.map((n) => [n, stub[n]])) as never);
    const got = match(url);
    assert.equal(got.path, path, `${path} should round-trip`);
    for (const n of names) assert.equal(got.params[n], stub[n]);
  }
});

test("params arrive URL-decoded, so an id with a slash survives the round trip", () => {
  assert.equal(match("/bounties/b%2F1/fund").params.id, "b/1");
  assert.equal(match("/security/findings/a%20b").params.findingId, "a b");
});

test("a trailing slash still matches", () => {
  assert.equal(match("/agent/").path, "/agent");
  assert.equal(match("/settings/account/").params.section, "account");
});

test("the matcher is case-insensitive", () => {
  // Pins the matcher only: app.tsx derives its shell state case-sensitively.
  assert.equal(match("/AGENT").path, "/agent");
  assert.equal(match("/Security/Gate").path, "/security/gate");
});
