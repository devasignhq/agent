// GET /api/reviews with ?q=. The search must never widen visibility: it applies
// after the install-owner and plan gates, and the repo owner/name match joins
// through the already plan-scoped repositories. Drives the exported handler with
// a fake session req/res, as review-auth.test.ts does. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/review-list-search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { REVIEW_SEARCH_LIMIT } from "../review/search.js";
import { listReviewsHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function authedReq(userId: string, query: any = {}): any {
  return { cookies: { devasign_session: signSession(userId) }, query };
}

function list(userId: string, query: any = {}) {
  const res = fakeRes();
  listReviewsHandler(authedReq(userId, query), res);
  return res;
}

const titles = (res: any) => (res.body as any[]).map((r) => r.prTitle).sort();

let clock = 1_000_000;
function addReview(repoId: string, prNumber: number, prTitle: string, status = "passed") {
  const id = uuid();
  db.insert("prReviews", {
    id, repoId, prNumber, prTitle, headSha: "a", baseSha: "b", status, verdict: null,
    criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null,
    createdAt: clock, updatedAt: clock++,
  } as any);
  return id;
}

function addUser(plan: "free" | "pro") {
  const userId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId: gh, githubLogin: `u${gh}`, email: "u@x.z", createdAt: Date.now() } as any);
  // planForUser reads subscriptions, not users.plan — no row means free.
  if (plan !== "free") {
    db.insert("subscriptions", {
      id: uuid(), userId, plan, stripeCustomerId: null, stripeSubscriptionId: null,
      status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false,
    } as any);
  }
  const instId = uuid();
  db.insert("installations", { id: instId, userId, accountId: gh, accountLogin: "a", installationId: gh, repoIds: [] } as any);
  return { userId, instId };
}

function addRepo(instId: string, owner: string, name: string, isPrivate = false) {
  const id = uuid();
  db.insert("repositories", {
    id, installationId: instId, owner, name, defaultBranch: "main",
    private: isPrivate, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
  } as any);
  return id;
}

// Owner with two public repos, plus an unrelated stranger whose review title
// would match the same queries.
function seed() {
  const { userId, instId } = addUser("pro");
  const payId = addRepo(instId, "acme", "pay");
  const webId = addRepo(instId, "acme", "web");
  addReview(payId, 482, "Fix login redirect");
  addReview(payId, 48, "Bump to 2024");
  addReview(webId, 9, "Add dark mode", "changes_requested");

  const stranger = addUser("pro");
  const strangerRepo = addRepo(stranger.instId, "acme", "pay");
  addReview(strangerRepo, 777, "Fix login redirect");

  return { userId, strangerId: stranger.userId };
}

test("rejects a signed-out caller with 401", () => {
  const res = fakeRes();
  listReviewsHandler({ cookies: {}, query: {} } as any, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "not_signed_in");
});

test("no q returns every visible review, newest first and uncapped", () => {
  const { userId } = seed();
  const body = list(userId).body as any[];
  assert.equal(body.length, 3);
  assert.deepEqual(body.map((r) => r.prNumber), [9, 48, 482]);
});

test("q matches the PR title", () => {
  const { userId } = seed();
  assert.deepEqual(titles(list(userId, { q: "login" })), ["Fix login redirect"]);
});

test("q matches the repo owner and name, which live on repositories not the review", () => {
  const { userId } = seed();
  assert.equal((list(userId, { q: "acme" }).body as any[]).length, 3);
  assert.deepEqual(titles(list(userId, { q: "web" })), ["Add dark mode"]);
  assert.deepEqual(titles(list(userId, { q: "acme/web" })), ["Add dark mode"]);
});

test("q matches the PR number by prefix", () => {
  const { userId } = seed();
  assert.deepEqual((list(userId, { q: "482" }).body as any[]).map((r) => r.prNumber), [482]);
  assert.deepEqual((list(userId, { q: "48" }).body as any[]).map((r) => r.prNumber), [48, 482]);
  assert.deepEqual((list(userId, { q: "#9" }).body as any[]).map((r) => r.prNumber), [9]);
});

test("multiple terms are ANDed", () => {
  const { userId } = seed();
  assert.deepEqual(titles(list(userId, { q: "acme dark" })), ["Add dark mode"]);
  assert.equal((list(userId, { q: "web login" }).body as any[]).length, 0);
});

test("q composes with status as an independent AND", () => {
  const { userId } = seed();
  assert.deepEqual(titles(list(userId, { q: "acme", status: "changes_requested" })), ["Add dark mode"]);
  assert.equal((list(userId, { q: "login", status: "changes_requested" }).body as any[]).length, 0);
});

test("a blank or whitespace q behaves exactly like no q", () => {
  const { userId } = seed();
  const base = (list(userId).body as any[]).length;
  assert.equal((list(userId, { q: "" }).body as any[]).length, base);
  assert.equal((list(userId, { q: "   " }).body as any[]).length, base);
});

test("a non-string q is treated as no query rather than crashing", () => {
  const { userId } = seed();
  const base = (list(userId).body as any[]).length;
  const arr = list(userId, { q: ["a", "b"] });
  assert.equal(arr.statusCode, 200);
  assert.equal((arr.body as any[]).length, base);
  const obj = list(userId, { q: { x: "1" } });
  assert.equal(obj.statusCode, 200);
  assert.equal((obj.body as any[]).length, base);
});

test("a matching review the caller does not own stays hidden", () => {
  const { userId, strangerId } = seed();
  const mine = list(userId, { q: "login" }).body as any[];
  assert.deepEqual(mine.map((r) => r.prNumber), [482]);
  const theirs = list(strangerId, { q: "login" }).body as any[];
  assert.deepEqual(theirs.map((r) => r.prNumber), [777]);
});

test("q does not route around the private-repo plan gate", () => {
  const free = addUser("free");
  const freePriv = addRepo(free.instId, "acme", "secret", true);
  addReview(freePriv, 1, "Fix login redirect");
  assert.equal((list(free.userId, { q: "login" }).body as any[]).length, 0);
  assert.equal((list(free.userId, { q: "secret" }).body as any[]).length, 0);

  const paid = addUser("pro");
  const paidPriv = addRepo(paid.instId, "acme", "secret", true);
  addReview(paidPriv, 2, "Fix login redirect");
  assert.equal((list(paid.userId, { q: "login" }).body as any[]).length, 1);
});

test("search results are capped at the most recent REVIEW_SEARCH_LIMIT", () => {
  const { userId, instId } = addUser("pro");
  const repoId = addRepo(instId, "bulk", "repo");
  const total = REVIEW_SEARCH_LIMIT + 5;
  for (let i = 0; i < total; i++) addReview(repoId, i + 1, `cap probe ${i}`);

  const capped = list(userId, { q: "probe" }).body as any[];
  assert.equal(capped.length, REVIEW_SEARCH_LIMIT);
  // The five dropped rows must be the oldest, not an arbitrary slice.
  const oldest = Math.min(...capped.map((r) => r.updatedAt));
  assert.equal(capped[0].prTitle, `cap probe ${total - 1}`);
  assert.ok(capped.every((r) => r.updatedAt >= oldest));

  // The unsearched list stays uncapped, exactly as before.
  assert.equal((list(userId).body as any[]).length, total);
});
