// GET /api/me identity-resolution tests, with a focus on the anti-masquerade
// branch: a validly-signed session whose user row is gone must NOT look like a
// normal sign-out (which funnels the user into a fresh sign-up that orphans the
// real account). When the users table is empty — the signature of a store wiped
// on redeploy — /me returns 503 account_unavailable and keeps the session cookie
// so it re-resolves once the store is back. Runs in-memory (initDb is never
// called, so the db's pg pool stays null). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/me-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { meHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, cleared: false };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.clearCookie = () => { res.cleared = true; return res; };
  return res;
}

// A request carrying a real signed-JWT session cookie for `userId`, exactly as
// oauth.ts issues — so getSessionUser / peekSessionUserId verify it as in prod.
const reqFor = (userId: string): any => ({ cookies: { devasign_session: signSession(userId) } });

// Wipe the collections these tests touch so each case starts from a known state.
function reset() {
  db.remove("users", () => true);
  db.remove("subscriptions", () => true);
}

test("GET /me: 401 not_signed_in when there is no session cookie", () => {
  reset();
  const res = fakeRes();
  meHandler({ cookies: {} } as any, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
  assert.equal(res.cleared, false);
});

test("GET /me: 200 with user + subscription for a resolvable session", () => {
  reset();
  const id = uuid();
  db.insert("users", { id, githubId: 1, githubLogin: "octocat", email: "o@e.com", plan: "free", createdAt: Date.now() } as any);
  db.insert("subscriptions", { id: uuid(), userId: id, plan: "free", stripeCustomerId: null, stripeSubscriptionId: null, status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, reviewsUsed: 0, usagePeriodStart: Date.now(), pendingPlan: null, scheduleId: null } as any);
  const res = fakeRes();
  meHandler(reqFor(id), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.id, id);
  assert.equal(res.body.subscription.userId, id);
});

test("GET /me: 503 account_unavailable for a ghost session when the users table is EMPTY (store wiped)", () => {
  reset(); // users table is now empty — the data-loss signature
  const res = fakeRes();
  meHandler(reqFor(uuid()), res); // valid token, but no such user (and none at all)
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "account_unavailable" });
  // Crucially, the session is preserved so it re-resolves once the store is back.
  assert.equal(res.cleared, false);
});

test("GET /me: ghost session with OTHER users present is a genuine sign-out (401 + cookie cleared)", () => {
  reset();
  // A healthy store with someone else in it — so a single missing row is a
  // deletion, not a wipe. The stale ghost cookie should be cleared, not 503'd.
  db.insert("users", { id: uuid(), githubId: 2, githubLogin: "someone", email: "s@e.com", plan: "free", createdAt: Date.now() } as any);
  const res = fakeRes();
  meHandler(reqFor(uuid()), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
  assert.equal(res.cleared, true);
});
