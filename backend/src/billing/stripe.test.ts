// Stripe webhook usage-reset tests — the monthly PR-review counter (reviewsUsed)
// must roll ONLY when the billing period genuinely advances. A mid-cycle plan
// switch produces a paid *proration* invoice (billing_reason "subscription_update");
// resetting on that wrongly zeroes a user's usage when they upgrade then downgrade
// mid-month (the reported bug: Pro 23/50 → Max → Pro showed 0/50). Runs without
// Stripe or Postgres (in-memory db fallback; the module's Stripe client is null
// when STRIPE_SECRET_KEY is unset and applyPaidInvoice never touches it). Run:
//   node --import tsx/esm --test src/billing/stripe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import type Stripe from "stripe";
import { db } from "../db.js";
import { applyPaidInvoice } from "./stripe.js";
import type { Subscription } from "../types.js";

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

// Seed a paying Pro sub with a known customer id (syncFromInvoice looks our row
// up by stripeCustomerId) that has already consumed `reviewsUsed` this period.
function seedPro(reviewsUsed: number, usagePeriodStart: number): Subscription {
  return db.insert("subscriptions", {
    id: uuid(),
    userId: uuid(),
    plan: "pro",
    stripeCustomerId: `cus_${uuid()}`,
    stripeSubscriptionId: `sub_${uuid()}`,
    status: "active",
    interval: "month",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pendingPlan: null,
    pendingInterval: null,
    scheduleId: null,
    reviewsUsed,
    usagePeriodStart,
  });
}

function invoice(customerId: string, reason: Stripe.Invoice.BillingReason): Stripe.Invoice {
  return { customer: customerId, billing_reason: reason } as unknown as Stripe.Invoice;
}

test("proration invoice from a mid-cycle plan switch preserves reviewsUsed", () => {
  const start = Date.now() - TEN_DAYS_MS;
  const sub = seedPro(23, start);

  applyPaidInvoice(invoice(sub.stripeCustomerId!, "subscription_update"));

  const after = db.find("subscriptions", (s) => s.id === sub.id)!;
  assert.equal(after.reviewsUsed, 23, "count must survive a mid-cycle tier switch");
  assert.equal(after.usagePeriodStart, start, "window anchor must not move");
  assert.equal(after.status, "active");
});

test("renewal invoice (subscription_cycle) rolls the usage window", () => {
  const start = Date.now() - TEN_DAYS_MS;
  const sub = seedPro(23, start);

  applyPaidInvoice(invoice(sub.stripeCustomerId!, "subscription_cycle"));

  const after = db.find("subscriptions", (s) => s.id === sub.id)!;
  assert.equal(after.reviewsUsed, 0, "a true renewal resets the count");
  assert.ok(after.usagePeriodStart > start, "window anchor advances to now");
  assert.equal(after.status, "active");
});

test("initial create invoice does not reset usage", () => {
  const start = Date.now() - TEN_DAYS_MS;
  const sub = seedPro(5, start);

  applyPaidInvoice(invoice(sub.stripeCustomerId!, "subscription_create"));

  const after = db.find("subscriptions", (s) => s.id === sub.id)!;
  assert.equal(after.reviewsUsed, 5);
  assert.equal(after.usagePeriodStart, start);
});
