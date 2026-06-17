// Ownership gate on the installation-claim route. POST
// /api/installations/:installationId/link writes userId onto the installation
// row, so it must refuse anyone who can't prove they own the account behind it:
// the personal owner (account.id === their GitHub id) or a verified *active* org
// member (membership resolving back to their GitHub id). Without this, any
// signed-in user could claim any installation id by enumeration.
//
// The membership lookup is injected into authorizeInstallationClaim, so the
// security matrix runs in-memory with no network. We also check the handler's
// signed-out path (401), which returns before any GitHub call. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/installation-link-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import type { User } from "../types.js";
import { authorizeInstallationClaim, linkInstallationHandler } from "./api.js";

function mkUser(githubId: number | null, githubLogin: string): User {
  return {
    id: uuid(),
    githubId,
    githubLogin,
    email: "u@x.z",
    plan: "free",
    createdAt: Date.now(),
  } as User;
}

type Membership = { state: string; role: string; userId: number } | null;
// A fetcher that always returns `m`, recording how it was called.
function fetcher(m: Membership) {
  const calls: Array<{ org: string; username: string }> = [];
  const fn = async (org: string, username: string) => {
    calls.push({ org, username });
    return m;
  };
  return { fn, calls };
}
const never = async () => {
  throw new Error("fetchMembership should not be called");
};

const personal = (id: number) => ({ id, login: "alice", type: "User" });
const org = (id: number) => ({ id, login: "acme", type: "Organization" });

test("personal: claim allowed when account.id === user.githubId (no membership call)", async () => {
  const f = fetcher(null);
  const ok = await authorizeInstallationClaim(mkUser(42, "alice"), personal(42), f.fn);
  assert.equal(ok, true);
  assert.equal(f.calls.length, 0); // personal path must not hit the org API
});

test("personal: someone else's personal install is rejected", async () => {
  const ok = await authorizeInstallationClaim(mkUser(42, "alice"), personal(999), never);
  assert.equal(ok, false);
});

test("org: active member resolving to the caller is allowed (queried by org+login)", async () => {
  const f = fetcher({ state: "active", role: "member", userId: 42 });
  const ok = await authorizeInstallationClaim(mkUser(42, "alice"), org(1000), f.fn);
  assert.equal(ok, true);
  assert.deepEqual(f.calls, [{ org: "acme", username: "alice" }]);
});

test("org: active admin is allowed (any active role qualifies)", async () => {
  const f = fetcher({ state: "active", role: "admin", userId: 42 });
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), org(1000), f.fn), true);
});

test("org: non-member (lookup returns null) is rejected", async () => {
  const f = fetcher(null);
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), org(1000), f.fn), false);
});

test("org: pending (not active) membership is rejected", async () => {
  const f = fetcher({ state: "pending", role: "member", userId: 42 });
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), org(1000), f.fn), false);
});

test("org: active membership for a different GitHub id is rejected (stale login guard)", async () => {
  // login "alice" now resolves to a member whose id isn't the caller's.
  const f = fetcher({ state: "active", role: "admin", userId: 777 });
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), org(1000), f.fn), false);
});

test("missing account (GitHub unverifiable) is rejected", async () => {
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), null, never), false);
  assert.equal(await authorizeInstallationClaim(mkUser(42, "alice"), {}, never), false);
});

test("legacy user (githubId null) cannot claim a personal-id-zero account", async () => {
  // Guards the `account.id === user.githubId` branch from matching null.
  assert.equal(await authorizeInstallationClaim(mkUser(null, "alice"), personal(0), never), false);
});

test("handler: signed-out caller is 401 before any GitHub call", async () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => ((res.statusCode = n), res);
  res.json = (b: unknown) => ((res.body = b), res);
  await linkInstallationHandler({ cookies: {}, params: { installationId: "1" } } as any, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "not_signed_in");
});
