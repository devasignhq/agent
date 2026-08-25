// Query construction for code search. Pure — no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/code-search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQuery, probeQuery } from "./code-search.js";

test("buildSearchQuery scopes an organization with org:", () => {
  assert.equal(
    buildSearchQuery({ needle: "createBounty", owner: "acme", isOrg: true }),
    "createBounty org:acme"
  );
});

test("buildSearchQuery scopes a personal account with user:", () => {
  assert.equal(
    buildSearchQuery({ needle: "createBounty", owner: "alice", isOrg: false }),
    "createBounty user:alice"
  );
});

test("buildSearchQuery prefers an explicit repo scope over the owner scope", () => {
  assert.equal(
    buildSearchQuery({ needle: "createBounty", owner: "acme", isOrg: true, repo: "acme/web" }),
    "createBounty repo:acme/web"
  );
});

test("buildSearchQuery excludes the reviewed repo", () => {
  assert.equal(
    buildSearchQuery({ needle: "x", owner: "acme", isOrg: true, excludeRepo: "acme/sdk" }),
    "x org:acme -repo:acme/sdk"
  );
});

test("buildSearchQuery quotes a path-shaped needle so the route stays one term", () => {
  assert.equal(
    buildSearchQuery({ needle: "/v1/payouts", owner: "acme", isOrg: true }),
    '"/v1/payouts" org:acme'
  );
});

test("probeQuery uses org: for an organization, not user:", () => {
  // A `user:<org>` probe is not the query the real searches ship, so it is not a
  // valid canary for whether they will work.
  assert.equal(probeQuery("acme", true), "devasign org:acme");
  assert.ok(!probeQuery("acme", true).includes("user:"));
});

test("probeQuery uses user: for a personal account", () => {
  assert.equal(probeQuery("alice", false), "devasign user:alice");
});

test("probeQuery degrades to an unscoped needle when the owner is unknown", () => {
  assert.equal(probeQuery("", true), "devasign");
});
