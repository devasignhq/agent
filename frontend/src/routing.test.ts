// Routing was the one part of the app the .ts suite could not reach: the route
// table lived in JSX. These run react-router's real matcher over the same table
// app.tsx renders, so a matching, ranking or param-decoding change fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { matchRoutes, generatePath } from "react-router-dom";
import { ROUTE_PATHS, DEFAULT_ROUTE, DEFAULT_SETTINGS_SECTION } from "./routes.ts";

// Built from the table itself, so a route added to the app is covered here too.
const routes = Object.values(ROUTE_PATHS).map((path) => ({ path }));

function match(url: string) {
  const m = matchRoutes(routes as never, url);
  if (!m || m.length === 0) return null;
  const last = m[m.length - 1];
  return { path: last.route.path as string, params: last.params as Record<string, string | undefined> };
}

test("every static route matches its own URL", () => {
  for (const path of Object.values(ROUTE_PATHS)) {
    if (path.includes(":") || path === "*") continue;
    assert.equal(match(path)?.path, path, `${path} should match itself`);
  }
});

test("param routes hand the screens the exact key they read off useParams", () => {
  // screen-fund-bounty reads params.id; screen-bounties reads params.id
  assert.deepEqual(match("/bounties/b-42/fund"), { path: ROUTE_PATHS.fundBounty, params: { id: "b-42" } });
  assert.deepEqual(match("/bounties/b-42/cancel"), { path: ROUTE_PATHS.cancelBounty, params: { id: "b-42" } });
  // screen-security destructures { findingId }
  assert.deepEqual(match("/security/findings/F-9"), { path: ROUTE_PATHS.securityFinding, params: { findingId: "F-9" } });
  // screens-rest destructures { section }
  assert.deepEqual(match("/settings/billing"), { path: ROUTE_PATHS.settingsSection, params: { section: "billing" } });
});

test("a literal route outranks a param route on the same prefix", () => {
  // /settings is a redirect; if :section ever won here it would capture the redirect.
  assert.equal(match("/settings")?.path, ROUTE_PATHS.settings);
  assert.equal(match("/security/gate")?.path, ROUTE_PATHS.securityGate);
  assert.equal(match("/security/rulings")?.path, ROUTE_PATHS.securityRulings);
});

test("the catch-all takes unknown URLs and nothing else", () => {
  assert.equal(match("/nope")?.path, ROUTE_PATHS.catchAll);
  assert.equal(match("/security/unknown/deep")?.path, ROUTE_PATHS.catchAll);
  assert.equal(match("/")?.path, ROUTE_PATHS.root, "root must not fall through to the catch-all");
  assert.equal(match("/agent")?.path, ROUTE_PATHS.agent);
});

test("both redirect targets are themselves routable", () => {
  assert.equal(match(DEFAULT_ROUTE)?.path, ROUTE_PATHS.agent);
  const settings = match(DEFAULT_SETTINGS_SECTION);
  assert.equal(settings?.path, ROUTE_PATHS.settingsSection);
  assert.equal(settings?.params.section, "account", "SettingsPage falls back to account, so the redirect must land there");
});

test("generatePath round-trips every param route", () => {
  const fund = generatePath(ROUTE_PATHS.fundBounty, { id: "xyz" });
  assert.equal(fund, "/bounties/xyz/fund");
  assert.equal(match(fund)?.params.id, "xyz");
  const finding = generatePath(ROUTE_PATHS.securityFinding, { findingId: "F-1" });
  assert.equal(match(finding)?.params.findingId, "F-1");
});

test("params arrive URL-decoded, so an id with a slash survives the round trip", () => {
  assert.equal(match("/bounties/b%2F1/fund")?.params.id, "b/1");
  assert.equal(match("/security/findings/a%20b")?.params.findingId, "a b");
});

test("a trailing slash still matches", () => {
  assert.equal(match("/agent/")?.path, ROUTE_PATHS.agent);
  assert.equal(match("/settings/account/")?.params.section, "account");
});

test("matching is case-insensitive", () => {
  // Worth pinning: a bookmark or hand-typed /Agent must not fall to the catch-all.
  assert.equal(match("/AGENT")?.path, ROUTE_PATHS.agent);
  assert.equal(match("/Security/Gate")?.path, ROUTE_PATHS.securityGate);
});
