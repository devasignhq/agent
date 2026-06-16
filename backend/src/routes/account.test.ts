// Account-deletion lifecycle tests. Deletion is now a soft delete with a 14-day
// restore window: DELETE /api/me marks the account + pauses billing + emails,
// and only the day-14 purge sweep runs the full teardown. We drive the handler
// and the account.ts lifecycle functions directly with injected GitHub/Stripe/
// email fakes, so we assert ordering + abort semantics without touching the
// network. Runs in-memory (initDb is never called, so the db's pg pool stays
// null). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/account.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { deleteAccountHandler } from "./api.js";
import {
  REMINDER_DAY,
  RESTORE_WINDOW_DAYS,
  isDeletionPending,
  purgeAccount,
  requestAccountDeletion,
  restoreAccount,
  reviewOwnerPendingDeletion,
  runDeletionSweep,
  type DeletionDeps,
} from "../account.js";

const DAY = 24 * 60 * 60 * 1000;

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

// Lifecycle deps that record their calls into `calls`. Overrides win (and can
// still push to `calls`, since they close over it) — used by the failure tests.
function makeDeps(calls: string[], overrides: Partial<DeletionDeps> = {}): DeletionDeps {
  return {
    uninstallApp: async (id) => { calls.push(`uninstall:${id}`); },
    cancelSubscriptionForDeletion: async (s) => { calls.push(`cancel:${s.id}`); },
    pauseSubscriptionForDeletion: async (s) => { calls.push(`pause:${s.id}`); },
    resumeSubscriptionAfterRestore: async (s) => { calls.push(`resume:${s.id}`); },
    sendDeletionScheduledEmail: async (u) => { calls.push(`email:scheduled:${u.id}`); return true; },
    sendDeletionReminderEmail: async (u) => { calls.push(`email:reminder:${u.id}`); return true; },
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

// ─── Request (soft delete) ──────────────────────────────────────────────────

test("DELETE /me: soft-deletes — marks for deletion, pauses billing, emails, keeps all data, clears session", async () => {
  const a = seedAccount();
  const before = footprint(a);
  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const calls: string[] = [];

  const res = fakeRes();
  await deleteAccountHandler(reqFor(a.userId), res, makeDeps(calls));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.cleared, true, "session cookie cleared");

  const user = db.find("users", (u) => u.id === a.userId)!;
  assert.equal(typeof user.deletionRequestedAt, "number", "marked for deletion");
  assert.equal(footprint(a), before, "nothing wiped — data kept for the restore window");
  // Paused billing + sent the scheduled email; NO uninstall/cancel on request.
  assert.deepEqual(calls, [`pause:${sub.id}`, `email:scheduled:${a.userId}`]);
});

test("DELETE /me: requires a session", async () => {
  const calls: string[] = [];
  const res = fakeRes();
  await deleteAccountHandler({ cookies: {} } as any, res, makeDeps(calls));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
  assert.deepEqual(calls, [], "no external calls without a session");
});

test("requestAccountDeletion: idempotent — a repeat request is a no-op", async () => {
  const a = seedAccount();
  const first: string[] = [];
  await requestAccountDeletion(db.find("users", (u) => u.id === a.userId)!, makeDeps(first));
  const stamped = db.find("users", (u) => u.id === a.userId)!.deletionRequestedAt;
  assert.equal(typeof stamped, "number");

  const second: string[] = [];
  await requestAccountDeletion(db.find("users", (u) => u.id === a.userId)!, makeDeps(second));
  assert.deepEqual(second, [], "no pause/email on a second request");
  assert.equal(db.find("users", (u) => u.id === a.userId)!.deletionRequestedAt, stamped, "timestamp unchanged");
});

// ─── Purge (end of window) ──────────────────────────────────────────────────

test("purgeAccount: Stripe → GitHub → email → wipe, full erase, other accounts untouched", async () => {
  const a = seedAccount();
  const other = seedAccount();
  const otherBefore = footprint(other);
  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const installIds = db.filter("installations", (i) => i.userId === a.userId).map((i) => i.installationId);
  const calls: string[] = [];

  await purgeAccount(a.userId, makeDeps(calls));

  // Order proof: cancel, one uninstall per install, then the final email — all
  // before the wipe.
  assert.deepEqual(calls, [
    `cancel:${sub.id}`,
    `uninstall:${installIds[0]}`,
    `uninstall:${installIds[1]}`,
    `email:purged:${a.userId}`,
  ]);
  assert.equal(footprint(a), 0, "every row for the account is gone");
  assert.equal(footprint(other), otherBefore, "a different account is left intact");
});

test("purgeAccount: a GitHub uninstall failure aborts the wipe (retry-safe, no final email)", async () => {
  const a = seedAccount();
  const before = footprint(a);
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    uninstallApp: async (id) => { calls.push(`uninstall:${id}`); throw new Error("502 from GitHub"); },
  });

  await assert.rejects(() => purgeAccount(a.userId, deps), /502 from GitHub/);

  assert.equal(footprint(a), before, "nothing deleted — the sweep retries next tick");
  assert.equal(calls[0].startsWith("cancel:"), true, "Stripe cancel ran before GitHub");
  assert.equal(calls.includes(`email:purged:${a.userId}`), false, "no final email when teardown failed");
});

// ─── Restore (login within the window) ──────────────────────────────────────

test("restoreAccount: clears the flags, resumes billing, flags welcome-back, leaves a notification", async () => {
  const a = seedAccount();
  await requestAccountDeletion(db.find("users", (u) => u.id === a.userId)!, makeDeps([]));
  // Pretend the day-12 reminder already went out, to prove restore clears it too.
  db.update("users", (u) => u.id === a.userId, { reminderSentAt: Date.now() });

  const sub = db.find("subscriptions", (s) => s.userId === a.userId)!;
  const pending = db.find("users", (u) => u.id === a.userId)!;
  assert.equal(isDeletionPending(pending), true, "sanity: pending before restore");

  const calls: string[] = [];
  await restoreAccount(pending, makeDeps(calls));

  const after = db.find("users", (u) => u.id === a.userId)!;
  assert.equal(isDeletionPending(after), false, "deletion flag cleared");
  assert.equal(after.reminderSentAt, undefined, "reminder flag cleared");
  assert.equal(after.welcomeBack, true, "welcome-back flagged for the pop-up");
  assert.deepEqual(calls, [`resume:${sub.id}`], "billing resumed");
  const note = db.filter("notifications", (n) => n.userId === a.userId && n.title === "Welcome back");
  assert.equal(note.length, 1, "left a durable welcome-back notification");
});

// ─── Review pause (worker gate) ─────────────────────────────────────────────

test("reviewOwnerPendingDeletion: true only while the install owner is pending", async () => {
  const a = seedAccount();
  const review = db.filter("prReviews", (r) => a.reviewIds.has(r.id))[0];

  assert.equal(reviewOwnerPendingDeletion(review.id), false, "not pending initially → review posts");
  db.update("users", (u) => u.id === a.userId, { deletionRequestedAt: Date.now() });
  assert.equal(reviewOwnerPendingDeletion(review.id), true, "pending → worker skips the review");
  assert.equal(reviewOwnerPendingDeletion("does-not-exist"), false, "unknown review → not pending");
});

// ─── Sweep (reminder + purge) ───────────────────────────────────────────────

test("runDeletionSweep: reminds once in the window, purges past it", async () => {
  const a = seedAccount();
  // Requested past the day-12 reminder but before the day-14 purge.
  db.update("users", (u) => u.id === a.userId, {
    deletionRequestedAt: Date.now() - (REMINDER_DAY + 1) * DAY,
  });

  const first: string[] = [];
  await runDeletionSweep(makeDeps(first));
  assert.deepEqual(first, [`email:reminder:${a.userId}`], "reminder sent in the window");
  assert.equal(typeof db.find("users", (u) => u.id === a.userId)!.reminderSentAt, "number", "reminder marked");
  assert.ok(footprint(a) > 0, "not purged yet");

  const second: string[] = [];
  await runDeletionSweep(makeDeps(second));
  assert.deepEqual(second, [], "reminder is not resent on the next tick");

  // Age past the window → purge on the next sweep.
  db.update("users", (u) => u.id === a.userId, {
    deletionRequestedAt: Date.now() - (RESTORE_WINDOW_DAYS + 1) * DAY,
  });
  const third: string[] = [];
  await runDeletionSweep(makeDeps(third));
  assert.equal(footprint(a), 0, "account purged after the 14-day window");
  assert.ok(third.includes(`email:purged:${a.userId}`), "final email sent");
});
