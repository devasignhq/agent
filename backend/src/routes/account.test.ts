// Account-deletion tests. Deletion is now immediate and permanent: DELETE
// /api/me runs the full teardown (cancel billing → uninstall the App → final
// email → wipe every row) and clears the session — there's no restore window,
// confirmation email, or background sweep. The external teardown is best-effort:
// a Stripe/GitHub failure is logged but never aborts the wipe. We drive the
// handler and purgeAccount directly with injected GitHub/Stripe/email fakes, so
// we assert ordering + best-effort semantics without touching the network. Runs
// in-memory (initDb is never called, so the db's pg pool stays null). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/account.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { deleteAccountHandler } from "./api.js";
import { purgeAccount, type DeletionDeps } from "../account.js";

// Make both teardown guards (isGithubAppConfigured / isStripeConfigured) pass so
// the lifecycle exercises the Stripe + GitHub branches; the injected deps below
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

// A signed-in request for `userId` — mints the same signed-JWT session cookie
// oauth.ts issues, so getSessionUser() verifies it exactly as it does in prod.
function reqFor(userId: string): any {
  return { cookies: { devasign_session: signSession(userId) } };
}

// Teardown deps that record their calls into `calls`. Overrides win (and can
// still push to `calls`, since they close over it) — used by the failure tests.
function makeDeps(calls: string[], overrides: Partial<DeletionDeps> = {}): DeletionDeps {
  return {
    uninstallApp: async (id) => { calls.push(`uninstall:${id}`); },
    cancelSubscriptionForDeletion: async (s) => { calls.push(`cancel:${s.id}`); },
    sendAccountPurgedEmail: async (u) => { calls.push(`email:purged:${u.id}`); return true; },
    ...overrides,
  };
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

// ─── DELETE /me (immediate hard delete) ──────────────────────────────────────

test("DELETE /me: deletes immediately — cancels billing, uninstalls, emails, wipes all data, clears session", async () => {
  const a = seedAccount();
  const other = seedAccount();
  const otherBefore = footprint(other);
  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const installIds = db.filter("installations", (i) => i.userId === a.userId).map((i) => i.installationId);
  const calls: string[] = [];

  const res = fakeRes();
  await deleteAccountHandler(reqFor(a.userId), res, makeDeps(calls));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.cleared, true, "session cookie cleared");

  // Order proof: cancel, one uninstall per install, then the final email — all
  // before the wipe.
  assert.deepEqual(calls, [
    `cancel:${sub.id}`,
    `uninstall:${installIds[0]}`,
    `uninstall:${installIds[1]}`,
    `email:purged:${a.userId}`,
  ]);
  assert.equal(footprint(a), 0, "every row for the account is gone immediately");
  assert.equal(footprint(other), otherBefore, "a different account is left intact");
});

test("DELETE /me: requires a session", async () => {
  const calls: string[] = [];
  const res = fakeRes();
  await deleteAccountHandler({ cookies: {} } as any, res, makeDeps(calls));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
  assert.deepEqual(calls, [], "no external calls without a session");
});

// ─── purgeAccount (teardown + best-effort external calls) ────────────────────

test("purgeAccount: Stripe → GitHub → email → wipe, full erase, other accounts untouched", async () => {
  const a = seedAccount();
  const other = seedAccount();
  const otherBefore = footprint(other);
  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const installIds = db.filter("installations", (i) => i.userId === a.userId).map((i) => i.installationId);
  const calls: string[] = [];

  await purgeAccount(a.userId, makeDeps(calls));

  assert.deepEqual(calls, [
    `cancel:${sub.id}`,
    `uninstall:${installIds[0]}`,
    `uninstall:${installIds[1]}`,
    `email:purged:${a.userId}`,
  ]);
  assert.equal(footprint(a), 0, "every row for the account is gone");
  assert.equal(footprint(other), otherBefore, "a different account is left intact");
});

test("purgeAccount: a GitHub uninstall failure is best-effort — the wipe still runs", async () => {
  const a = seedAccount();
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    uninstallApp: async (id) => { calls.push(`uninstall:${id}`); throw new Error("502 from GitHub"); },
  });

  // No throw — deletion must complete even when the external call fails.
  await purgeAccount(a.userId, deps);

  assert.equal(footprint(a), 0, "account fully wiped despite the uninstall failure");
  assert.equal(calls[0].startsWith("cancel:"), true, "Stripe cancel ran before GitHub");
  assert.ok(calls.includes(`email:purged:${a.userId}`), "final email still sent");
});

test("purgeAccount: a Stripe cancel failure is best-effort — the wipe still runs", async () => {
  const a = seedAccount();
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    cancelSubscriptionForDeletion: async (s) => { calls.push(`cancel:${s.id}`); throw new Error("stripe down"); },
  });

  await purgeAccount(a.userId, deps);

  assert.equal(footprint(a), 0, "account fully wiped despite the Stripe failure");
  assert.ok(calls.includes(`email:purged:${a.userId}`), "final email still sent");
});

test("purgeAccount: an unknown user is a no-op", async () => {
  const calls: string[] = [];
  await purgeAccount("does-not-exist", makeDeps(calls));
  assert.deepEqual(calls, [], "no external calls for a missing account");
});
