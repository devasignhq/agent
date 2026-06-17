// Strict session binding on the Linear connect callback (OAuth account-linking
// CSRF defense). finishLinearOAuth requires a live session that equals the user
// who STARTED the flow (entry.userId), so it rejects both a DIFFERENT logged-in
// user and a LOGGED-OUT caller — the latter being the attacker-lures-the-victim
// case, where a no-session callback would otherwise file the victim's workspace
// under the attacker's account. The 403 paths return before any network call, so
// this runs fully offline.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/linear/oauth-csrf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { signSession } from "../github/oauth.js";
import { startLinearOAuth, finishLinearOAuth } from "./oauth.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, redirectedTo: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.redirect = (url: string) => { res.redirectedTo = url; return res; };
  return res;
}

const req = (cookies: Record<string, string>, query: Record<string, string> = {}): any => ({
  protocol: "https",
  get: () => "api.devasign.ai",
  cookies,
  query,
});

// Linear connect is gated to paid plans, so seed a user with an active Pro
// subscription (effectivePlan reads the subscription, not user.plan).
function seedProUser(): string {
  const id = uuid();
  db.insert("users", {
    id, githubId: Math.floor(Math.random() * 1e9), githubLogin: "u" + id.slice(0, 6),
    email: `${id}@x.z`, plan: "pro", createdAt: Date.now(),
  } as any);
  db.insert("subscriptions", {
    id: uuid(), userId: id, plan: "pro", status: "active", stripeCustomerId: null,
    stripeSubscriptionId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
    reviewsUsed: 0, usagePeriodStart: Date.now(), pendingPlan: null, scheduleId: null,
  } as any);
  return id;
}

function withLinearConfigured(fn: () => void) {
  const id = config.linear.oauthClientId, secret = config.linear.oauthClientSecret;
  config.linear.oauthClientId = "lin-id";
  config.linear.oauthClientSecret = "lin-secret";
  try { fn(); } finally {
    config.linear.oauthClientId = id;
    config.linear.oauthClientSecret = secret;
  }
}

// Start a real connect flow for `starterId`; returns the minted state, now live
// in the module's pending-state map and bound to starterId.
function startFor(starterId: string): string {
  let state = "";
  withLinearConfigured(() => {
    const res = fakeRes();
    startLinearOAuth(req({ devasign_session: signSession(starterId) }), res);
    state = new URL(res.redirectedTo).searchParams.get("state")!;
  });
  return state;
}

test("finishLinearOAuth: 403 when a DIFFERENT user's session hits the callback", async () => {
  const starter = seedProUser();
  const victim = seedProUser();
  const state = startFor(starter);

  const res = fakeRes();
  await finishLinearOAuth(req({ devasign_session: signSession(victim) }, { code: "c", state }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "OAuth state mismatch");
  // Nothing was attached to either account (returns before any db write).
  assert.ok(!db.find("integrations", (i) => i.userId === starter && i.type === "linear"));
  assert.ok(!db.find("integrations", (i) => i.userId === victim && i.type === "linear"));
});

test("finishLinearOAuth: 403 when NO session is present (logged-out victim)", async () => {
  // The attacker-lures-victim case: a valid (code, state) hitting the callback
  // with no DevAsign session must not link the workspace to entry.userId.
  const starter = seedProUser();
  const state = startFor(starter);

  const res = fakeRes();
  await finishLinearOAuth(req({}, { code: "c", state }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "OAuth state mismatch");
  assert.ok(!db.find("integrations", (i) => i.userId === starter && i.type === "linear"));
});

test("finishLinearOAuth: 400 for an unknown state (base guard unchanged)", async () => {
  const res = fakeRes();
  await finishLinearOAuth(req({}, { code: "c", state: "never-issued" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "Invalid OAuth state");
});
