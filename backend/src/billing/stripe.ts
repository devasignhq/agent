// Stripe billing — hosted Checkout, the Customer Portal, and the webhook that
// keeps our Subscription rows in sync with Stripe.
//
// Stripe is the source of truth for plan state: we NEVER promote a user to a
// paid plan from a client request, only from a signature-verified webhook
// event. Checkout/portal sessions are created server-side and the browser is
// redirected to Stripe's hosted pages.
//
// SDK note (stripe@22, API 2026-05-27): the billing period moved off the
// top-level Subscription onto its items — read `items.data[0].current_period_end`.
import Stripe from "stripe";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import type { Subscription, SubscriptionStatus, User } from "../types.js";
import { effectivePlan, intervalOf, normalizePlan, priceFor, priceIdToPlanInterval, type Interval } from "./plans.js";
import { track } from "../statsig.js";

// null when unconfigured so the app still boots; the routes 503 before calling
// these helpers, so they can assume a live client.
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

function client(): Stripe {
  if (!stripe) throw new Error("Stripe is not configured");
  return stripe;
}

// Annual subscriptions carry the 20%-off coupon; monthly carry none. Returning
// an explicit [] on monthly is what REMOVES a lingering coupon when a sub
// switches year→month via subscriptions.update or a schedule phase.
function annualDiscounts(interval: Interval): { coupon: string }[] {
  return interval === "year" ? [{ coupon: config.stripe.annualCouponId }] : [];
}

// ─── Session creation (Checkout + Portal) ──────────────────────────────────

// Reuse the stored customer or create one, persisting the id on the sub.
export async function getOrCreateCustomer(user: User, sub: Subscription): Promise<string> {
  if (sub.stripeCustomerId) return sub.stripeCustomerId;
  const customer = await client().customers.create({
    email: user.email || undefined,
    name: user.githubLogin,
    metadata: { userId: user.id, githubLogin: user.githubLogin },
  });
  db.update("subscriptions", (s) => s.id === sub.id, { stripeCustomerId: customer.id });
  return customer.id;
}

// Align the Stripe customer email with our user record (e.g. after an OAuth email
// backfill). No-op without Stripe configured or before the user has a customer.
export async function updateCustomerEmail(user: User): Promise<void> {
  if (!stripe) return;
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub?.stripeCustomerId) return;
  await stripe.customers.update(sub.stripeCustomerId, { email: user.email || undefined });
}

// Hosted Checkout for a paid tier. Subscription mode + a 14-day trial collects
// the card up front and auto-converts on day 14. metadata.userId lets the
// webhook map the resulting subscription back to our user even before the
// customer id is persisted locally. interval picks the monthly vs annual Price;
// annual auto-applies the 20% coupon (callers gate annual on isAnnualConfigured).
export async function createCheckoutSession(
  user: User,
  sub: Subscription,
  plan: "pro" | "max",
  interval: Interval,
  // When the checkout is launched from the onboarding pricing step, return to a
  // distinct marker so the app resumes onboarding (at the repository step) rather
  // than opening Settings → Billing (the default `?billing=...` flow).
  onboarding = false
): Promise<string> {
  const customerId = await getOrCreateCustomer(user, sub);
  const successUrl = onboarding
    ? `${config.webOrigin}/?ob=billing`
    : `${config.webOrigin}/?billing=success`;
  const cancelUrl = onboarding
    ? `${config.webOrigin}/?ob=cancel`
    : `${config.webOrigin}/?billing=cancel`;
  const session = await client().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceFor(plan, interval), quantity: 1 }],
    subscription_data: { trial_period_days: 14, metadata: { userId: user.id, plan, interval } },
    client_reference_id: user.id,
    metadata: { userId: user.id, plan, interval },
    // Annual auto-applies the 20% coupon. Stripe forbids combining a coupon with
    // customer-entered promotion codes in one session, so only monthly opts into
    // allow_promotion_codes; annual passes the coupon via discounts instead.
    ...(interval === "year"
      ? { discounts: [{ coupon: config.stripe.annualCouponId }] }
      : { allow_promotion_codes: true }),
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// Hosted Billing Portal — update card, cancel, view invoices.
export async function createPortalSession(
  sub: Subscription,
  opts: { cancel?: boolean } = {}
): Promise<string> {
  if (!sub.stripeCustomerId) throw new Error("No Stripe customer for this user");
  const base: Stripe.BillingPortal.SessionCreateParams = {
    customer: sub.stripeCustomerId,
    return_url: `${config.webOrigin}/?billing=portal`,
  };
  // Cancel flow: deep-link straight into Stripe's cancel screen and auto-redirect
  // back to Billing once confirmed. The downgrade itself arrives via the
  // subscription webhook (immediate vs end-of-period is set in the portal's
  // Cancellation config). Skip it when our row already knows it's canceling, and
  // fall back to the normal portal if Stripe rejects it (e.g. it's already
  // scheduled to cancel but our row was stale from a missed webhook).
  if (opts.cancel && sub.stripeSubscriptionId && !sub.cancelAtPeriodEnd) {
    try {
      const session = await client().billingPortal.sessions.create({
        ...base,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: sub.stripeSubscriptionId },
          after_completion: {
            type: "redirect",
            redirect: { return_url: `${config.webOrigin}/?billing=canceled` },
          },
        },
      });
      return session.url;
    } catch (err) {
      console.warn("[stripe] cancel flow unavailable, opening normal portal:", (err as Error).message);
    }
  }
  const session = await client().billingPortal.sessions.create(base);
  return session.url;
}

// ─── Plan switching (update the existing subscription) ──────────────────────

// Release any pending scheduled switch and clear the local markers. A schedule
// "manages" the subscription (which blocks subscriptions.update), so this also
// unblocks an immediate change.
async function releaseSchedule(sub: Subscription): Promise<void> {
  if (sub.scheduleId) {
    try {
      await client().subscriptionSchedules.release(sub.scheduleId);
    } catch (err) {
      console.warn("[stripe] schedule release failed (continuing):", (err as Error).message);
    }
  }
  if (sub.pendingPlan || sub.scheduleId) {
    db.update("subscriptions", (s) => s.id === sub.id, { pendingPlan: null, scheduleId: null });
  }
}

// Switch an active subscription to another paid tier and/or interval (e.g.
// monthly→annual). immediate=true swaps the price now (prorated, charged via
// always_invoice — trials aren't charged until they end); immediate=false defers
// the switch to the end of the current period via a 2-phase Subscription
// Schedule. discounts carries (or removes) the 20% annual coupon so a year→month
// switch drops it and a →year switch (re)applies it. The webhook syncs the
// resulting plan + interval.
export async function changePlan(
  sub: Subscription,
  plan: "pro" | "max",
  interval: Interval,
  immediate: boolean
): Promise<void> {
  if (!sub.stripeSubscriptionId) throw new Error("No active subscription to change");
  await releaseSchedule(sub);
  const newPrice = priceFor(plan, interval);
  const stripeSub = await client().subscriptions.retrieve(sub.stripeSubscriptionId);
  const currentPrice = stripeSub.items.data[0]?.price?.id;
  const currentInterval = priceIdToPlanInterval(currentPrice)?.interval ?? intervalOf(sub);

  // Only touch discounts when the annual-coupon state actually changes, so a
  // monthly→monthly tier switch leaves any promo code the user applied at
  // checkout intact (subscriptions.update's `discounts` REPLACES the whole set).
  //   → year: apply the 20% coupon · year→month: drop it · month→month: leave as-is.
  const discounts =
    interval === "year"
      ? [{ coupon: config.stripe.annualCouponId }]
      : currentInterval === "year"
      ? []
      : undefined;

  if (immediate) {
    // Active sub → charge the prorated difference now (always_invoice). Trialing
    // sub → never force an invoice (that ends the trial early); just swap the
    // price so the new rate applies when the trial converts.
    const updated = await client().subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: stripeSub.items.data[0]?.id, price: newPrice }],
      proration_behavior: stripeSub.status === "trialing" ? "none" : "always_invoice",
      ...(discounts !== undefined ? { discounts } : {}),
    });
    syncSubscription(updated); // reflect locally now; the webhook re-confirms (idempotent)
    return;
  }

  // Defer to period end: keep the current price (and its coupon) for the rest of
  // this period, then switch to the new price (with the target's coupon). Phases
  // don't inherit the subscription's discount, so set each phase's explicitly. (A
  // promo code on a monthly→monthly deferred switch isn't carried across the
  // phase boundary — rare, and schedules require per-phase discounts.)
  const schedule = await client().subscriptionSchedules.create({
    from_subscription: sub.stripeSubscriptionId,
  });
  const phase0 = schedule.phases[0];
  await client().subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        items: [{ price: currentPrice, quantity: 1 }],
        discounts: annualDiscounts(currentInterval),
        start_date: phase0.start_date,
        end_date: phase0.end_date,
      },
      { items: [{ price: newPrice, quantity: 1 }], discounts: annualDiscounts(interval) },
    ],
  });
  db.update("subscriptions", (s) => s.id === sub.id, {
    pendingPlan: plan,
    pendingInterval: interval,
    scheduleId: schedule.id,
  });
}

// Revert a pending (scheduled) switch: release the schedule, keep the current plan.
export async function cancelScheduledChange(sub: Subscription): Promise<void> {
  await releaseSchedule(sub);
}

// Hard-cancel the user's subscription as part of account deletion: release any
// pending schedule first (a schedule manages the subscription and can block a
// direct cancel), then cancel immediately so Stripe raises no further invoices.
// Idempotent — unconfigured Stripe, no subscription, or an already-canceled /
// missing one all resolve quietly, so the delete flow can retry safely.
export async function cancelSubscriptionForDeletion(sub: Subscription): Promise<void> {
  if (!stripe) return; // unconfigured — nothing to cancel
  await releaseSchedule(sub);
  if (!sub.stripeSubscriptionId) return;
  try {
    await client().subscriptions.cancel(sub.stripeSubscriptionId);
  } catch (err) {
    // Already canceled / not found is fine; re-throw anything else so the
    // caller can surface a real failure and the user can retry.
    const e = err as { statusCode?: number; code?: string };
    if (e?.statusCode === 404 || e?.code === "resource_missing") return;
    throw err;
  }
}

// Pause billing when a user *requests* deletion (vs. the hard cancel at purge):
// schedule the subscription to cancel at period end so no surprise renewal lands
// during the 14-day restore window, without losing the plan if they come back.
// Releases any pending schedule first (a schedule blocks subscriptions.update).
// No-op when Stripe is unconfigured, there's no subscription, or it's already
// set to cancel — so requesting deletion stays idempotent.
export async function pauseSubscriptionForDeletion(sub: Subscription): Promise<void> {
  if (!stripe || !sub.stripeSubscriptionId || sub.cancelAtPeriodEnd) return;
  await releaseSchedule(sub);
  try {
    const updated = await client().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    syncSubscription(updated); // reflect cancelAtPeriodEnd locally; webhook re-confirms
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (e?.statusCode === 404 || e?.code === "resource_missing") return;
    throw err;
  }
}

// Reverse pauseSubscriptionForDeletion when the user logs back in to restore:
// clear the scheduled cancellation so billing continues as before. No-op when
// Stripe is unconfigured, there's no subscription, or nothing is scheduled to
// cancel — so restore is safe even if billing was never paused.
export async function resumeSubscriptionAfterRestore(sub: Subscription): Promise<void> {
  if (!stripe || !sub.stripeSubscriptionId || !sub.cancelAtPeriodEnd) return;
  try {
    const updated = await client().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    syncSubscription(updated);
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (e?.statusCode === 404 || e?.code === "resource_missing") return;
    throw err;
  }
}

// ─── Webhook → local sync ───────────────────────────────────────────────────

function mapStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "incomplete";
    // unpaid | canceled | incomplete_expired | paused → not collecting → free
    default:
      return "canceled";
  }
}

function customerIdOf(
  c: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!c) return null;
  return typeof c === "string" ? c : c.id;
}

function periodEndMs(stripeSub: Stripe.Subscription): number | null {
  // `current_period_end` moved from the Subscription top-level (≤ 2025-01 acacia)
  // onto the subscription item (2025-03 basil+, which our SDK pins). Read the
  // item first, then fall back to the legacy top-level field, so a webhook
  // destination configured on an older API version still yields a renewal date.
  const sec =
    stripeSub.items?.data?.[0]?.current_period_end ??
    (stripeSub as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  return typeof sec === "number" ? sec * 1000 : null;
}

// Find our Subscription row for a Stripe subscription: by stripe sub id, then
// by customer id, then by the userId we stamped into metadata at checkout
// (covers the very first event, before either id is persisted locally).
function findOurSub(stripeSub: Stripe.Subscription): Subscription | null {
  const custId = customerIdOf(stripeSub.customer);
  const metaUserId = stripeSub.metadata?.userId;
  return (
    db.find("subscriptions", (s) => s.stripeSubscriptionId === stripeSub.id) ||
    (custId ? db.find("subscriptions", (s) => s.stripeCustomerId === custId) : null) ||
    (metaUserId ? db.find("subscriptions", (s) => s.userId === metaUserId) : null)
  );
}

// Mirror the effective plan onto the user row so /me + the UI reflect reality.
function mirrorUserPlan(sub: Subscription, patch: Partial<Subscription>): void {
  db.update("users", (u) => u.id === sub.userId, { plan: effectivePlan({ ...sub, ...patch }) });
}

// Apply a Stripe subscription's full state to our row. `resetUsage` true when a
// new paid period has begun (fresh trial / successful renewal).
function syncSubscription(stripeSub: Stripe.Subscription, resetUsage = false): void {
  const sub = findOurSub(stripeSub);
  if (!sub) {
    console.warn(`[stripe] no local subscription for ${stripeSub.id} (cust ${customerIdOf(stripeSub.customer)})`);
    return;
  }
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  const resolved = priceIdToPlanInterval(priceId);
  const newPlan = resolved?.plan ?? normalizePlan(sub.plan);
  const newInterval = resolved?.interval ?? intervalOf(sub);
  const patch: Partial<Subscription> = {
    plan: newPlan,
    interval: newInterval,
    status: mapStatus(stripeSub.status),
    stripeSubscriptionId: stripeSub.id,
    stripeCustomerId: customerIdOf(stripeSub.customer) ?? sub.stripeCustomerId,
    currentPeriodEnd: periodEndMs(stripeSub),
    cancelAtPeriodEnd: Boolean(stripeSub.cancel_at_period_end),
  };
  // A scheduled switch that just transitioned at period end → clear the markers.
  // Require the interval to match too (a tier-only pending switch left
  // pendingInterval null, in which case the interval check is a no-op).
  if (
    sub.pendingPlan &&
    newPlan === sub.pendingPlan &&
    newInterval === (sub.pendingInterval ?? newInterval)
  ) {
    patch.pendingPlan = null;
    patch.pendingInterval = null;
    patch.scheduleId = null;
  }
  if (resetUsage) {
    patch.reviewsUsed = 0;
    patch.usagePeriodStart = Date.now();
  }
  db.update("subscriptions", (s) => s.id === sub.id, patch);
  mirrorUserPlan(sub, patch);
  console.log(
    `[stripe] user ${sub.userId}: plan=${patch.plan} status=${patch.status} → effective=${effectivePlan({ ...sub, ...patch })}`
  );
}

// Invoice events carry a customer but (since API 2025+) no top-level
// subscription field — look our row up by customer id.
function syncFromInvoice(invoice: Stripe.Invoice, patch: Partial<Subscription>): void {
  const custId = customerIdOf(invoice.customer);
  const sub = custId ? db.find("subscriptions", (s) => s.stripeCustomerId === custId) : null;
  if (!sub) return;
  db.update("subscriptions", (s) => s.id === sub.id, patch);
  mirrorUserPlan(sub, patch);
}

// ─── Reconcile from Stripe (self-heal) ──────────────────────────────────────

// Pull live subscription state from Stripe — the source of truth — and apply it
// locally whenever our copy says "free". This self-heals the plan when the
// webhook-driven state was never recorded or was lost: a webhook that wasn't
// configured / didn't arrive, or (the common one) the in-memory store being
// wiped on a redeploy with DATABASE_URL unset, which re-mints the user as a fresh
// free row even though Stripe still has them trialing with a card on file.
//
// Gated to non-paying local rows so already active/trialing users cost no Stripe
// call, and genuine downgrades (cancel / payment failure) still flow through the
// webhook. Best-effort and idempotent — it only ever raises us to what Stripe
// already reports. Runs on sign-in (see github/oauth.ts).
export async function reconcileSubscriptionFromStripe(user: User): Promise<void> {
  if (!stripe) return;
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub) return;
  // Already paying locally (active or trialing) → trust the webhook for any
  // future change and skip the round-trip.
  if (effectivePlan(sub) !== "free") return;

  // Resolve the Stripe customer. Our stored id wins; otherwise match by email —
  // the only stable link after an ephemeral wipe re-mints userId (the customer's
  // metadata.userId is then stale, but its email + login still match). Require the
  // githubLogin we stamp on every customer (getOrCreateCustomer) to match too, so
  // a shared email across two GitHub accounts can't attribute one's paid sub to
  // the other.
  let customerId = sub.stripeCustomerId;
  if (!customerId && user.email) {
    const matches = await stripe.customers.list({ email: user.email, limit: 10 });
    const mine = matches.data.find((c) => c.metadata?.githubLogin === user.githubLogin);
    customerId = mine?.id ?? null;
    if (customerId) db.update("subscriptions", (s) => s.id === sub.id, { stripeCustomerId: customerId });
  }
  if (!customerId) return; // never a customer → genuinely free

  // Prefer a paying subscription (trialing or active); fall back to the most
  // recent so a past_due/canceled one still backfills the Stripe ids (so the
  // Billing portal works) without changing the effective plan.
  const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const chosen =
    list.data.find((s) => s.status === "trialing" || s.status === "active") ?? list.data[0];
  if (chosen) {
    syncSubscription(chosen);
    console.log(`[stripe] reconciled user ${user.id} from Stripe customer ${customerId}`);
  }
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  if (!stripe || !config.stripe.webhookSecret) {
    res.status(503).json({ error: "stripe_not_configured" });
    return;
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).send("missing stripe-signature");
    return;
  }
  let event: Stripe.Event;
  try {
    // req.body is the raw Buffer — this route is mounted with express.raw()
    // BEFORE express.json(), so the bytes are intact for signature verification.
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripe.webhookSecret);
  } catch (err) {
    console.warn("[stripe] webhook signature verification failed:", (err as Error).message);
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Link the customer to our user, then sync the new subscription.
        const userId = session.client_reference_id || session.metadata?.userId || null;
        const custId = customerIdOf(session.customer);
        if (userId && custId) {
          const ourSub = db.find("subscriptions", (s) => s.userId === userId);
          if (ourSub && !ourSub.stripeCustomerId) {
            db.update("subscriptions", (s) => s.id === ourSub.id, { stripeCustomerId: custId });
          }
        }
        if (session.subscription) {
          const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          syncSubscription(await stripe.subscriptions.retrieve(subId), true);
        }
        if (userId) {
          track(userId, "subscription activated", {
            plan: session.metadata?.plan || null,
            interval: session.metadata?.interval || null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.payment_succeeded": {
        // New paid period: mark active and reset the monthly usage window.
        syncFromInvoice(event.data.object as Stripe.Invoice, {
          status: "active",
          reviewsUsed: 0,
          usagePeriodStart: Date.now(),
        });
        break;
      }
      case "invoice.payment_failed": {
        // Dunning: past_due → effectivePlan drops them to Free until recovered.
        const failedInvoice = event.data.object as Stripe.Invoice;
        syncFromInvoice(failedInvoice, { status: "past_due" });
        const failedCustId = customerIdOf(failedInvoice.customer);
        const failedSub = failedCustId ? db.find("subscriptions", (s) => s.stripeCustomerId === failedCustId) : null;
        if (failedSub) {
          track(failedSub.userId, "payment failed", { plan: failedSub.plan });
        }
        break;
      }
      default:
        // Many event types we don't act on — acknowledge them so Stripe stops
        // retrying.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`[stripe] handler error for ${event.type}:`, err);
    res.status(500).send("handler error");
  }
}
