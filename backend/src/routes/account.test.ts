// Account-deletion route tests. Drive DELETE /api/me's handler directly with a
// mock req/res and injected GitHub/Stripe fakes, so we assert the teardown
// ORDER and the abort-on-failure semantics without touching the network. Runs
// in-memory (initDb is never called, so the db's pg pool stays null). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/account.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { deleteAccountHandler } from "./api.js";

// Make both teardown guards (isGithubAppConfigured / isStripeConfigured) pass so
// the handler exercises the Stripe + GitHub branches; the injected deps below
// stand in for the real network calls.
config.github.appId = "test-app-id";
config.github.privateKey = "test-private-key";
config.stripe.secretKey = "sk_test";
config.stripe.pricePro = "price_pro";
config.stripe.priceMax = "price_max";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, cleared: false };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.clearCookie = () => { res.cleared = true; return res; };
  return res;
}

// A signed-in request for `userId` — mirrors the base64url `id:ts` session that
// oauth.ts mints and getSessionUser() decodes.
function reqFor(userId: string): any {
  const session = Buffer.from(`${userId}:${Date.now()}`).toString("base64url");
  return { cookies: { devasign_session: session } };
}

type Seed = {
  userId: string;
  repoIds: Set<string>;
  reviewIds: Set<string>;
  taskIds: Set<string>; // PR-linked task ids (the Linear task is removed by userId)
};

// Seed a full account graph: user + subscription + two installations, each with
// a repo → review → log + index entry, plus a PR-linked task, a Linear task, and
// the user-scoped integration / notification / audit / project-update rows.
function seedAccount(): Seed {
  const userId = uuid();
  const inst1 = uuid(), inst2 = uuid();
  const ghInst1 = Math.floor(Math.random() * 1e9), ghInst2 = ghInst1 + 1;
  const repo1 = uuid(), repo2 = uuid();
  const review1 = uuid(), review2 = uuid();
  const prTask = uuid();     // GitHub PR task: no userId, reached via review.taskId
  const linearTask = uuid(); // Linear task: user-scoped

  db.insert("users", { id: userId, githubId: ghInst1, githubLogin: "u_" + userId.slice(0, 6), email: "x@y.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("subscriptions", { id: uuid(), userId, plan: "pro", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlan: null, scheduleId: null, reviewsUsed: 0, usagePeriodStart: Date.now() } as any);
  db.insert("installations", { id: inst1, userId, accountId: 1, accountLogin: "acct1", installationId: ghInst1, repoIds: [] } as any);
  db.insert("installations", { id: inst2, userId, accountId: 2, accountLogin: "acct2", installationId: ghInst2, repoIds: [] } as any);
  db.insert("repositories", { id: repo1, installationId: inst1, owner: "o", name: "r1", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("repositories", { id: repo2, installationId: inst2, owner: "o", name: "r2", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  db.insert("prReviews", { id: review1, repoId: repo1, prNumber: 1, prTitle: "x", headSha: "a", baseSha: "b", status: "queued", verdict: null, criteria: [], taskId: prTask, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  db.insert("prReviews", { id: review2, repoId: repo2, prNumber: 2, prTitle: "y", headSha: "a", baseSha: "b", status: "queued", verdict: null, criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  db.insert("reviewLogs", { id: uuid(), reviewId: review1, kind: "ingest", at: Date.now(), action: "x" } as any);
  db.insert("repoIndex", { id: uuid(), repoId: repo1, path: "p", sha: "s", size: 1, language: "ts", summary: "", exports: [], imports: [], securityFlags: [], indexedAt: Date.now(), model: "m" } as any);
  db.insert("tasks", { id: prTask, source: "github", externalId: "e1", title: "t", endGoal: null, attachments: [], createdAt: Date.now() } as any);
  db.insert("tasks", { id: linearTask, source: "linear", externalId: "e2", title: "t", endGoal: null, attachments: [], createdAt: Date.now(), userId } as any);
  db.insert("integrations", { id: uuid(), userId, type: "linear", tokens: {}, workspaceMeta: {}, createdAt: Date.now() } as any);
  db.insert("notifications", { id: uuid(), userId, kind: "system", title: "t", meta: "", createdAt: Date.now(), readAt: null } as any);
  db.insert("authAudit", { id: uuid(), userId, at: Date.now(), event: "signin" } as any);
  db.insert("linearProjectUpdates", { id: uuid(), projectId: "p", projectName: "P", body: "", userId, createdAt: Date.now(), updatedAt: Date.now() } as any);

  return {
    userId,
    repoIds: new Set([repo1, repo2]),
    reviewIds: new Set([review1, review2]),
    taskIds: new Set([prTask]),
  };
}

// Count every row the account owns across all collections — 0 means fully erased.
function footprint(a: Seed): number {
  return (
    db.filter("users", (u) => u.id === a.userId).length +
    db.filter("subscriptions", (s) => s.userId === a.userId).length +
    db.filter("installations", (i) => i.userId === a.userId).length +
    db.filter("repositories", (r) => a.repoIds.has(r.id)).length +
    db.filter("prReviews", (r) => a.reviewIds.has(r.id)).length +
    db.filter("reviewLogs", (l) => a.reviewIds.has(l.reviewId)).length +
    db.filter("repoIndex", (e) => a.repoIds.has(e.repoId)).length +
    db.filter("tasks", (t) => t.userId === a.userId || a.taskIds.has(t.id)).length +
    db.filter("integrations", (i) => i.userId === a.userId).length +
    db.filter("notifications", (n) => n.userId === a.userId).length +
    db.filter("linearProjectUpdates", (u) => u.userId === a.userId).length +
    db.filter("authAudit", (au) => au.userId === a.userId).length
  );
}

test("DELETE /me: Stripe → GitHub → wipe, full erase, session cleared, other accounts untouched", async () => {
  const a = seedAccount();
  const other = seedAccount();
  const otherBefore = footprint(other);
  assert.ok(footprint(a) > 0, "sanity: account seeded");

  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const installIds = db.filter("installations", (i) => i.userId === a.userId).map((i) => i.installationId);
  const calls: string[] = [];

  const res = fakeRes();
  await deleteAccountHandler(reqFor(a.userId), res, {
    cancelSubscriptionForDeletion: async (s) => { calls.push(`stripe:${s.id}`); },
    uninstallApp: async (id) => { calls.push(`github:${id}`); },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.cleared, true, "session cookie cleared");
  // Order proof: Stripe cancel first, then one uninstall per installation.
  assert.deepEqual(calls, [`stripe:${sub.id}`, `github:${installIds[0]}`, `github:${installIds[1]}`]);
  assert.equal(footprint(a), 0, "every row for the account is gone");
  assert.equal(footprint(other), otherBefore, "a different account is left intact");
});

test("DELETE /me: a GitHub uninstall failure aborts the wipe (retry-safe)", async () => {
  const a = seedAccount();
  const before = footprint(a);
  const calls: string[] = [];

  const res = fakeRes();
  await deleteAccountHandler(reqFor(a.userId), res, {
    cancelSubscriptionForDeletion: async () => { calls.push("stripe"); },
    uninstallApp: async (id) => { calls.push(`github:${id}`); throw new Error("502 from GitHub"); },
  });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "github_uninstall_failed" });
  assert.equal(res.cleared, false, "session NOT cleared on failure");
  assert.equal(calls[0], "stripe", "Stripe ran before GitHub");
  assert.equal(calls.length, 2, "stopped at the first failing uninstall");
  assert.equal(footprint(a), before, "nothing deleted — the call is safe to retry");
});

test("DELETE /me: a Stripe cancel failure aborts before any GitHub call", async () => {
  const a = seedAccount();
  const before = footprint(a);
  const calls: string[] = [];

  const res = fakeRes();
  await deleteAccountHandler(reqFor(a.userId), res, {
    cancelSubscriptionForDeletion: async () => { throw new Error("Stripe down"); },
    uninstallApp: async (id) => { calls.push(`github:${id}`); },
  });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: "billing_cancel_failed" });
  assert.equal(res.cleared, false);
  assert.deepEqual(calls, [], "GitHub uninstall never attempted after a billing failure");
  assert.equal(footprint(a), before);
});

test("DELETE /me: requires a session", async () => {
  const res = fakeRes();
  await deleteAccountHandler({ cookies: {} } as any, res, {
    cancelSubscriptionForDeletion: async () => { throw new Error("should not run"); },
    uninstallApp: async () => { throw new Error("should not run"); },
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
});
