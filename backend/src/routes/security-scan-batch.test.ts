// POST /api/security/scan — the bulk re-scan behind the Security page's Rescan
// picker. Covers the auth/plan gates, the installation scoping (a repo id the
// caller doesn't own must be dropped, not honoured), and the in-flight rule
// that reports a busy repo as skipped instead of failing the whole call.
// In-memory (initDb is never called, so the db's pg pool stays null). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/security-scan-batch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { securityScanBatchHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => {
    res.statusCode = n;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

const reqFor = (userId: string | null, body: unknown = {}): any => ({
  cookies: userId ? { devasign_session: signSession(userId) } : {},
  body,
});

function reset() {
  for (const c of [
    "users",
    "subscriptions",
    "installations",
    "repositories",
    "securityScans",
  ] as const) {
    db.remove(c, () => true);
  }
}

// A Pro user with one installation and `names.length` repos under it.
function seed(names: string[], plan: "free" | "pro" = "pro") {
  const userId = uuid();
  const installId = uuid();
  db.insert("users", {
    id: userId,
    githubId: 1,
    githubLogin: "octocat",
    email: "o@e.com",
    plan: "free",
    createdAt: Date.now(),
  } as any);
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: plan === "free" ? null : "active",
    currentPeriodEnd: Date.now() + 30 * 24 * 3600_000,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  db.insert("installations", {
    id: installId,
    userId,
    accountId: 1,
    accountLogin: "octocat",
    installationId: 1,
    repoIds: [],
  } as any);
  const repoIds = names.map((name) => {
    const id = uuid();
    db.insert("repositories", {
      id,
      installationId: installId,
      owner: "octocat",
      name,
      defaultBranch: "main",
      private: false,
      defaultModel: "",
      modelOverrides: {},
      reviewsEnabled: true,
    } as any);
    return id;
  });
  return { userId, installId, repoIds };
}

test("401 without a session", () => {
  reset();
  const res = fakeRes();
  securityScanBatchHandler(reqFor(null), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
});

test("403 on a Free plan — audits are Pro/Max", () => {
  reset();
  const { userId } = seed(["a"], "free");
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "upgrade_required");
  assert.equal(db.filter("securityScans", () => true).length, 0);
});

test("no repoIds means every repo the app is installed for", () => {
  reset();
  const { userId, repoIds } = seed(["a", "b", "c"]);
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.queued.length, 3);
  assert.deepEqual(res.body.skipped, []);
  assert.deepEqual(res.body.queued.map((q: any) => q.repoId).sort(), [...repoIds].sort());
  // One queued run row per repo, and a manual re-scan is full by default.
  const runs = db.filter("securityScans", () => true);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === "queued" && r.trigger === "manual" && r.full));
});

test("an explicit EMPTY repoIds queues nothing — it must not mean 'all'", () => {
  reset();
  const { userId } = seed(["a", "b", "c"]);
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId, { repoIds: [] }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.queued, []);
  assert.deepEqual(res.body.skipped, []);
  // The whole point: asking for nothing must not scan every repo the user owns.
  assert.equal(db.filter("securityScans", () => true).length, 0);
});

test("an explicit subset queues only those repos", () => {
  reset();
  const { userId, repoIds } = seed(["a", "b", "c"]);
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId, { repoIds: [repoIds[1]] }), res);
  assert.equal(res.body.queued.length, 1);
  assert.equal(res.body.queued[0].repoId, repoIds[1]);
  assert.equal(db.filter("securityScans", () => true).length, 1);
});

test("a repo id outside the caller's installations is dropped, not scanned", () => {
  reset();
  const { userId } = seed(["a"]);
  const stranger = seed(["not-yours"]); // a different user's repo
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId, { repoIds: [stranger.repoIds[0]] }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.queued, []);
  assert.equal(db.filter("securityScans", () => true).length, 0);
});

test("a repo already scanning comes back skipped, the rest still queue", () => {
  reset();
  const { userId, repoIds } = seed(["a", "b"]);
  db.insert("securityScans", {
    id: "in-flight",
    repoId: repoIds[0],
    trigger: "merge",
    full: false,
    status: "running",
    startedAt: Date.now(),
    filesScanned: 0,
    cacheHits: 0,
    introduced: 0,
    resolved: 0,
    stillOpen: 0,
    log: [],
  } as any);
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.skipped, [{ repoId: repoIds[0], reason: "in_progress" }]);
  assert.equal(res.body.queued.length, 1);
  assert.equal(res.body.queued[0].repoId, repoIds[1]);
  // No second run row for the busy repo.
  assert.equal(db.filter("securityScans", (s) => s.repoId === repoIds[0]).length, 1);
});

test("full: false is honoured (differential re-scan)", () => {
  reset();
  const { userId } = seed(["a"]);
  const res = fakeRes();
  securityScanBatchHandler(reqFor(userId, { full: false }), res);
  assert.equal(db.filter("securityScans", () => true)[0].full, false);
});
