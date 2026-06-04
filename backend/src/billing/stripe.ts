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
import { effectivePlan, normalizePlan, priceIdToPlan } from "./plans.js";

// null when unconfigured so the app still boots; the routes 503 before calling
// these helpers, so they can assume a live client.
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

function client(): Stripe {
  if (!stripe) throw new Error("Stripe is not configured");
  return stripe;
}

const PRICE_BY_PLAN: Record<"pro" | "max", () => string> = {
  pro: () => config.stripe.pricePro,
  max: () => config.stripe.priceMax,
};

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

// Hosted Checkout for a paid tier. Subscription mode + a 14-day trial collects
// the card up front and auto-converts on day 14. metadata.userId lets the
// webhook map the resulting subscription back to our user even before the
// customer id is persisted locally.
export async function createCheckoutSession(
  user: User,
  sub: Subscription,
  plan: "pro" | "max"
): Promise<string> {
  const customerId = await getOrCreateCustomer(user, sub);
  const session = await client().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: PRICE_BY_PLAN[plan](), quantity: 1 }],
    subscription_data: { trial_period_days: 14, metadata: { userId: user.id, plan } },
    client_reference_id: user.id,
    metadata: { userId: user.id, plan },
    allow_promotion_codes: true,
    success_url: `${config.webOrigin}/?billing=success`,
    cancel_url: `${config.webOrigin}/?billing=cancel`,
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

// Switch an active subscription to another paid tier. immediate=true swaps the
// price now (prorated, charged via always_invoice — trials aren't charged until
// they end); immediate=false defers the switch to the end of the current period
// via a 2-phase Subscription Schedule. The webhook syncs the resulting plan.
export async function changePlan(
  sub: Subscription,
  plan: "pro" | "max",
  immediate: boolean
): Promise<void> {
  if (!sub.stripeSubscriptionId) throw new Error("No active subscription to change");
  await releaseSchedule(sub);
  const newPrice = PRICE_BY_PLAN[plan]();
  const stripeSub = await client().subscriptions.retrieve(sub.stripeSubscriptionId);

  if (immediate) {
    // Active sub → charge the prorated difference now (always_invoice). Trialing
    // sub → never force an invoice (that ends the trial early); just swap the
    // price so the new rate applies when the trial converts.
    const updated = await client().subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: stripeSub.items.data[0]?.id, price: newPrice }],
      proration_behavior: stripeSub.status === "trialing" ? "none" : "always_invoice",
    });
    syncSubscription(updated); // reflect locally now; the webhook re-confirms (idempotent)
    return;
  }

  // Defer to period end: keep the current price for the rest of this period,
  // then switch to the new price.
  const currentPrice = stripeSub.items.data[0]?.price?.id;
  const schedule = await client().subscriptionSchedules.create({
    from_subscription: sub.stripeSubscriptionId,
  });
  const phase0 = schedule.phases[0];
  await client().subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      { items: [{ price: currentPrice, quantity: 1 }], start_date: phase0.start_date, end_date: phase0.end_date },
      { items: [{ price: newPrice, quantity: 1 }] },
    ],
  });
  db.update("subscriptions", (s) => s.id === sub.id, { pendingPlan: plan, scheduleId: schedule.id });
}

// Revert a pending (scheduled) switch: release the schedule, keep the current plan.
export async function cancelScheduledChange(sub: Subscription): Promise<void> {
  await releaseSchedule(sub);
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
  const sec = stripeSub.items?.data?.[0]?.current_period_end;
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
  const newPlan = priceIdToPlan(priceId) ?? normalizePlan(sub.plan);
  const patch: Partial<Subscription> = {
    plan: newPlan,
    status: mapStatus(stripeSub.status),
    stripeSubscriptionId: stripeSub.id,
    stripeCustomerId: customerIdOf(stripeSub.customer) ?? sub.stripeCustomerId,
    currentPeriodEnd: periodEndMs(stripeSub),
    cancelAtPeriodEnd: Boolean(stripeSub.cancel_at_period_end),
  };
  // A scheduled downgrade that just transitioned at period end → clear the marker.
  if (sub.pendingPlan && newPlan === sub.pendingPlan) {
    patch.pendingPlan = null;
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
        syncFromInvoice(event.data.object as Stripe.Invoice, { status: "past_due" });
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
