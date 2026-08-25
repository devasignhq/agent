// Plan-policy unit tests — the brain of the paywall: the tier matrix, the
// status-driven downgrade (effectivePlan), and the monthly usage roll. These
// run without Stripe or Postgres (the db falls back to an in-memory store). Run:
//   node --import tsx/esm --test src/billing/plans.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import {
  PLAN_LIMITS,
  chargeForNewPRReview,
  effectivePlan,
  intervalOf,
  modelForPlan,
  normalizePlan,
  planForUser,
  priceFor,
  priceIdToPlan,
  priceIdToPlanInterval,
  privateRepoBlocked,
  rollAndCheckUsage,
  securityScanBlocked,
  crossRepoBlocked,
} from "./plans.js";
import type { Subscription, SubscriptionStatus } from "../types.js";

function sub(partial: Partial<Subscription>): Subscription {
  return {
    id: uuid(),
    userId: uuid(),
    plan: "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
    ...partial,
  };
}

test("PLAN_LIMITS encode the tier matrix", () => {
  assert.equal(PLAN_LIMITS.free.model, "claude-haiku-4-5");
  assert.equal(PLAN_LIMITS.pro.model, config.llm.model);
  assert.equal(PLAN_LIMITS.max.model, config.llm.model);
  assert.equal(PLAN_LIMITS.free.monthlyReviews, 10);
  assert.equal(PLAN_LIMITS.pro.monthlyReviews, 50);
  assert.equal(PLAN_LIMITS.max.monthlyReviews, Infinity);
  assert.equal(PLAN_LIMITS.free.privateRepos, false);
  assert.equal(PLAN_LIMITS.pro.privateRepos, true);
  assert.equal(PLAN_LIMITS.max.privateRepos, true);
  assert.equal(PLAN_LIMITS.free.linear, false);
  assert.equal(PLAN_LIMITS.pro.linear, true);
  assert.equal(PLAN_LIMITS.max.linear, true);
  assert.equal(PLAN_LIMITS.free.crossRepo, false);
  assert.equal(PLAN_LIMITS.pro.crossRepo, true);
  assert.equal(PLAN_LIMITS.max.crossRepo, true);
});

test("modelForPlan: Free → Haiku, Pro/Max → frontier", () => {
  assert.equal(modelForPlan("free"), "claude-haiku-4-5");
  assert.equal(modelForPlan("pro"), config.llm.model);
  assert.equal(modelForPlan("max"), config.llm.model);
});

test("effectivePlan: paid only while active/trialing, else downgrades to free", () => {
  assert.equal(effectivePlan(null), "free");
  assert.equal(effectivePlan(sub({ plan: "free", status: null })), "free");
  assert.equal(effectivePlan(sub({ plan: "pro", status: "active" })), "pro");
  assert.equal(effectivePlan(sub({ plan: "pro", status: "trialing" })), "pro");
  assert.equal(effectivePlan(sub({ plan: "max", status: "active" })), "max");

  // Every lapsed / non-collecting status collapses to free.
  const lapsed: (SubscriptionStatus | null)[] = ["past_due", "canceled", "incomplete", null];
  for (const s of lapsed) {
    assert.equal(effectivePlan(sub({ plan: "pro", status: s })), "free", `pro/${s}`);
    assert.equal(effectivePlan(sub({ plan: "max", status: s })), "free", `max/${s}`);
  }

  // Legacy "team" tier maps to max.
  assert.equal(effectivePlan(sub({ plan: "team" as any, status: "active" })), "max");
});

test("planForUser reads the user's subscription (defaulting to free)", () => {
  const userId = uuid();
  db.insert("subscriptions", sub({ userId, plan: "pro", status: "active" }));
  assert.equal(planForUser(userId), "pro");
  assert.equal(planForUser(uuid()), "free"); // no subscription → free
});

test("normalizePlan canonicalizes legacy/unknown plans", () => {
  assert.equal(normalizePlan("pro"), "pro");
  assert.equal(normalizePlan("max"), "max");
  assert.equal(normalizePlan("team"), "max"); // legacy tier
  assert.equal(normalizePlan("garbage"), "free");
  assert.equal(normalizePlan(null), "free");
  assert.equal(normalizePlan(undefined), "free");
});

test("priceIdToPlan maps configured price ids; unknown/null → null", () => {
  if (config.stripe.pricePro) assert.equal(priceIdToPlan(config.stripe.pricePro), "pro");
  if (config.stripe.priceMax) assert.equal(priceIdToPlan(config.stripe.priceMax), "max");
  assert.equal(priceIdToPlan("price_does_not_exist"), null);
  assert.equal(priceIdToPlan(null), null);
});

test("price catalog: priceFor + priceIdToPlanInterval round-trip across tier × interval", () => {
  // Pin the four price ids deterministically (independent of env).
  config.stripe.pricePro = "price_pro_m";
  config.stripe.priceMax = "price_max_m";
  config.stripe.priceProAnnual = "price_pro_y";
  config.stripe.priceMaxAnnual = "price_max_y";

  assert.equal(priceFor("pro", "month"), "price_pro_m");
  assert.equal(priceFor("pro", "year"), "price_pro_y");
  assert.equal(priceFor("max", "month"), "price_max_m");
  assert.equal(priceFor("max", "year"), "price_max_y");

  assert.deepEqual(priceIdToPlanInterval("price_pro_m"), { plan: "pro", interval: "month" });
  assert.deepEqual(priceIdToPlanInterval("price_pro_y"), { plan: "pro", interval: "year" });
  assert.deepEqual(priceIdToPlanInterval("price_max_m"), { plan: "max", interval: "month" });
  assert.deepEqual(priceIdToPlanInterval("price_max_y"), { plan: "max", interval: "year" });

  // The thin wrapper still yields just the tier.
  assert.equal(priceIdToPlan("price_pro_y"), "pro");
  assert.equal(priceIdToPlan("price_max_m"), "max");

  // Unknown / null / undefined → null.
  assert.equal(priceIdToPlanInterval("price_unknown"), null);
  assert.equal(priceIdToPlanInterval(null), null);
  assert.equal(priceIdToPlanInterval(undefined), null);
});

test("priceIdToPlanInterval ignores unconfigured (empty) annual slots", () => {
  config.stripe.pricePro = "price_pro_m";
  config.stripe.priceMax = "price_max_m";
  config.stripe.priceProAnnual = "";
  config.stripe.priceMaxAnnual = "";
  // An empty incoming id never matches, and an empty slot never matches a real id.
  assert.equal(priceIdToPlanInterval(""), null);
  assert.deepEqual(priceIdToPlanInterval("price_pro_m"), { plan: "pro", interval: "month" });
});

test("intervalOf defaults legacy/free rows to month", () => {
  assert.equal(intervalOf(null), "month");
  assert.equal(intervalOf(sub({})), "month"); // no interval field (legacy row)
  assert.equal(intervalOf(sub({ interval: null })), "month");
  assert.equal(intervalOf(sub({ interval: "month" })), "month");
  assert.equal(intervalOf(sub({ interval: "year" })), "year");
});

test("rollAndCheckUsage: free blocks at the cap and rolls after a month", () => {
  // Under the cap → allowed.
  const under = db.insert("subscriptions", sub({ plan: "free", reviewsUsed: 9 }));
  const u1 = rollAndCheckUsage(under);
  assert.deepEqual({ allowed: u1.allowed, used: u1.used, limit: u1.limit }, { allowed: true, used: 9, limit: 10 });

  // At the cap → blocked.
  const atCap = db.insert("subscriptions", sub({ plan: "free", reviewsUsed: 10 }));
  assert.equal(rollAndCheckUsage(atCap).allowed, false);

  // Window elapsed (>30d) → reset to 0, allowed again, and the reset persists.
  const stale = db.insert(
    "subscriptions",
    sub({ plan: "free", reviewsUsed: 10, usagePeriodStart: Date.now() - 31 * 24 * 60 * 60 * 1000 })
  );
  const u3 = rollAndCheckUsage(stale);
  assert.equal(u3.used, 0);
  assert.equal(u3.allowed, true);
  assert.equal(db.find("subscriptions", (x) => x.id === stale.id)?.reviewsUsed, 0);

  // Max (unlimited) is always allowed regardless of usage.
  const max = db.insert("subscriptions", sub({ plan: "max", status: "active", reviewsUsed: 99999 }));
  assert.equal(rollAndCheckUsage(max).allowed, true);
});

test("privateRepoBlocked: only private repos on a no-private-repos plan, only when linked", () => {
  const free = uuid();
  db.insert("subscriptions", sub({ userId: free, plan: "free" }));
  const pro = uuid();
  db.insert("subscriptions", sub({ userId: pro, plan: "pro", status: "active" }));

  assert.equal(privateRepoBlocked(true, free), true); // private + Free → blocked
  assert.equal(privateRepoBlocked(true, pro), false); // private + paid → allowed
  assert.equal(privateRepoBlocked(false, free), false); // public → never blocked
  // Unlinked install (no userId yet) → onboarding grace window, never blocked.
  assert.equal(privateRepoBlocked(true, ""), false);
  assert.equal(privateRepoBlocked(true, null), false);
  assert.equal(privateRepoBlocked(true, undefined), false);
});

test("securityScanBlocked: audits are Pro/Max, and stop when the sub lapses", () => {
  const free = uuid();
  db.insert("subscriptions", sub({ userId: free, plan: "free" }));
  const pro = uuid();
  db.insert("subscriptions", sub({ userId: pro, plan: "pro", status: "active" }));
  const max = uuid();
  db.insert("subscriptions", sub({ userId: max, plan: "max", status: "trialing" }));
  const lapsed = uuid();
  db.insert("subscriptions", sub({ userId: lapsed, plan: "pro", status: "canceled" }));
  const noSub = uuid();

  assert.equal(securityScanBlocked(free), true);
  assert.equal(securityScanBlocked(pro), false);
  assert.equal(securityScanBlocked(max), false); // trialing counts as paying
  assert.equal(securityScanBlocked(lapsed), true); // effectivePlan downgrades it
  assert.equal(securityScanBlocked(noSub), true); // no row → Free
  // Unlinked install (no userId yet) → onboarding grace, never blocked.
  assert.equal(securityScanBlocked(""), false);
  assert.equal(securityScanBlocked(null), false);
  assert.equal(securityScanBlocked(undefined), false);
});

test("crossRepoBlocked: cross-repo review is Pro/Max, and stops when the sub lapses", () => {
  const free = uuid();
  db.insert("subscriptions", sub({ userId: free, plan: "free" }));
  const pro = uuid();
  db.insert("subscriptions", sub({ userId: pro, plan: "pro", status: "active" }));
  const max = uuid();
  db.insert("subscriptions", sub({ userId: max, plan: "max", status: "trialing" }));
  const lapsed = uuid();
  db.insert("subscriptions", sub({ userId: lapsed, plan: "pro", status: "canceled" }));
  const noSub = uuid();

  assert.equal(crossRepoBlocked(free), true);
  assert.equal(crossRepoBlocked(pro), false);
  assert.equal(crossRepoBlocked(max), false); // trialing counts as paying
  assert.equal(crossRepoBlocked(lapsed), true); // effectivePlan downgrades it
  assert.equal(crossRepoBlocked(noSub), true); // no row → Free
  // Unlinked install (no userId yet) → onboarding grace, never blocked.
  assert.equal(crossRepoBlocked(""), false);
  assert.equal(crossRepoBlocked(null), false);
  assert.equal(crossRepoBlocked(undefined), false);
});

test("chargeForNewPRReview: charges a new under-cap PR exactly once", () => {
  const userId = uuid();
  db.insert("subscriptions", sub({ userId, plan: "free", reviewsUsed: 9 }));
  const repo = { id: uuid(), private: false };

  assert.deepEqual(chargeForNewPRReview(userId, repo, 1), { allowed: true, limit: 10 });
  // The charge persisted: 9 → 10.
  assert.equal(db.find("subscriptions", (s) => s.userId === userId)?.reviewsUsed, 10);
});

test("chargeForNewPRReview: blocks a new PR at the cap without charging", () => {
  const userId = uuid();
  db.insert("subscriptions", sub({ userId, plan: "free", reviewsUsed: 10 }));
  const repo = { id: uuid(), private: false };

  assert.deepEqual(chargeForNewPRReview(userId, repo, 1), { allowed: false, limit: 10 });
  assert.equal(db.find("subscriptions", (s) => s.userId === userId)?.reviewsUsed, 10); // untouched
});

test("chargeForNewPRReview: re-review of a known PR is free (null, no charge)", () => {
  const userId = uuid();
  db.insert("subscriptions", sub({ userId, plan: "free", reviewsUsed: 10 }));
  const repo = { id: uuid(), private: false };
  // A prior review row for this repo+PR makes this a re-review (re-push/re-open).
  db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 7 } as any);

  assert.equal(chargeForNewPRReview(userId, repo, 7), null);
  assert.equal(db.find("subscriptions", (s) => s.userId === userId)?.reviewsUsed, 10); // never re-charges
});

test("chargeForNewPRReview: a plan-blocked private repo never consumes the cap", () => {
  const userId = uuid();
  db.insert("subscriptions", sub({ userId, plan: "free", reviewsUsed: 0 }));
  // Private repo on Free is refused outright by runReviewJob, so it must not
  // charge against the public-repo allowance even though it's under the cap.
  assert.equal(chargeForNewPRReview(userId, { id: uuid(), private: true }, 1), null);
  assert.equal(db.find("subscriptions", (s) => s.userId === userId)?.reviewsUsed, 0);
});

test("chargeForNewPRReview: no gating without a linked owner or a subscription row", () => {
  // Unlinked install (empty ownerUserId) → null.
  assert.equal(chargeForNewPRReview("", { id: uuid(), private: false }, 1), null);
  // Linked owner with no subscription row → null (preserves the prior behavior).
  assert.equal(chargeForNewPRReview(uuid(), { id: uuid(), private: false }, 1), null);
});
