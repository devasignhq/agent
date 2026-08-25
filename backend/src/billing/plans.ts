// Central plan policy — the single source of truth for what each tier may do.
// Every gate (model selection, monthly review cap, private-repo access, Linear)
// resolves through here, so the tier rules live in exactly one place.
//
// Key idea: a Subscription stores the *purchased* tier, but `effectivePlan()`
// downgrades it to "free" whenever the Stripe status isn't paying (active or
// trialing). That collapses "trial expired + payment failed", "renewal failed",
// and "canceled" all into Free with no per-call special-casing — a lapsed Pro
// user is treated exactly like a Free user everywhere.
import { config } from "../config.js";
import { db } from "../db.js";
import type { Subscription } from "../types.js";

export type Plan = "free" | "pro" | "max";

export type PlanLimits = {
  model: string; // review model for this tier
  monthlyReviews: number; // unique PRs reviewable per period; Infinity = unlimited
  privateRepos: boolean; // may review private repos
  linear: boolean; // Linear integration + acceptance-criteria sync
  securityScans: boolean; // repo-wide security audits + merge gate (Security page)
  crossRepo: boolean; // cross-repo impact + parity stage on PR reviews
  priceKey: "pricePro" | "priceMax" | null; // which config.stripe price funds it
};

// Free uses the cheap model; paid tiers use the configured frontier model
// (ANTHROPIC_MODEL — opus). Reading config.llm.model means a prod model bump
// (e.g. opus-4-8) automatically applies to Pro/Max with no code change here.
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { model: "claude-haiku-4-5", monthlyReviews: 10, privateRepos: false, linear: false, securityScans: false, crossRepo: false, priceKey: null },
  pro: { model: config.llm.model, monthlyReviews: 50, privateRepos: true, linear: true, securityScans: true, crossRepo: true, priceKey: "pricePro" },
  max: { model: config.llm.model, monthlyReviews: Infinity, privateRepos: true, linear: true, securityScans: true, crossRepo: true, priceKey: "priceMax" },
};

// Tier ordering for upgrade/downgrade comparisons (free < pro < max).
export const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, max: 2 };

// Legacy rows used "team"; treat it as "max". Anything unknown → "free".
export function normalizePlan(plan: string | null | undefined): Plan {
  if (plan === "pro") return "pro";
  if (plan === "max" || plan === "team") return "max";
  return "free";
}

// The downgrade rule. Returns the purchased tier only while Stripe says we're
// collecting payment (active) or in the trial (trialing); every other status —
// past_due, canceled, incomplete, or a null/missing sub — yields "free".
export function effectivePlan(sub: Subscription | null | undefined): Plan {
  if (!sub) return "free";
  const purchased = normalizePlan(sub.plan);
  if (purchased === "free") return "free";
  return sub.status === "active" || sub.status === "trialing" ? purchased : "free";
}

export function subscriptionForUser(userId: string): Subscription | null {
  return db.find("subscriptions", (s) => s.userId === userId);
}

// The single entry point every gate uses. A lapsed sub is uniformly Free.
export function planForUser(userId: string): Plan {
  return effectivePlan(subscriptionForUser(userId));
}

export function modelForPlan(plan: Plan): string {
  return PLAN_LIMITS[plan].model;
}

// Billing cadence. Annual gets a 20% coupon (see billing/stripe.ts); the limits
// above are per-tier and identical across intervals.
export type Interval = "month" | "year";

// The four recurring Prices that fund the paid tiers, indexed by (tier, interval).
// Annual ids are "" until annual billing is configured — annual paths gate on
// isAnnualConfigured() (config.ts) before reaching for one.
function priceTable(): Record<"pro" | "max", Record<Interval, string>> {
  return {
    pro: { month: config.stripe.pricePro, year: config.stripe.priceProAnnual },
    max: { month: config.stripe.priceMax, year: config.stripe.priceMaxAnnual },
  };
}

// The Stripe Price ID funding a (tier, interval).
export function priceFor(plan: "pro" | "max", interval: Interval): string {
  return priceTable()[plan][interval];
}

// Reverse map for the Stripe webhook: which tier + interval does this Price ID
// fund? Skips empty (unconfigured) slots so a blank id never spuriously matches.
export function priceIdToPlanInterval(
  priceId: string | null | undefined
): { plan: Plan; interval: Interval } | null {
  if (!priceId) return null;
  const table = priceTable();
  for (const plan of ["pro", "max"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (table[plan][interval] && table[plan][interval] === priceId) return { plan, interval };
    }
  }
  return null;
}

// Thin wrapper for callers that only need the tier.
export function priceIdToPlan(priceId: string | null | undefined): Plan | null {
  return priceIdToPlanInterval(priceId)?.plan ?? null;
}

// The billed interval for a sub, defaulting legacy/free rows to "month".
export function intervalOf(sub: Subscription | null | undefined): Interval {
  return sub?.interval === "year" ? "year" : "month";
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type UsageCheck = { plan: Plan; used: number; limit: number; allowed: boolean };

// Rolls the usage window if it has elapsed (persisting the reset), then reports
// whether another review is allowed. Does NOT consume a review — the caller
// calls recordReviewUsage() only when it actually starts a new-PR review.
//
// `usagePeriodStart` anchors the window. The Stripe webhook resets it on each
// true renewal (invoice.payment_succeeded with billing_reason "subscription_cycle"
// — NOT the proration invoices from mid-cycle plan switches); this 30-day fallback
// covers free users (who have no webhook) and any missed renewal event. Max's
// Infinity limit makes `allowed` always true regardless.
export function rollAndCheckUsage(sub: Subscription): UsageCheck {
  const plan = effectivePlan(sub);
  const limit = PLAN_LIMITS[plan].monthlyReviews;
  const now = Date.now();
  let used = sub.reviewsUsed || 0;
  if (now - (sub.usagePeriodStart || 0) >= THIRTY_DAYS_MS) {
    used = 0;
    db.update("subscriptions", (s) => s.id === sub.id, { reviewsUsed: 0, usagePeriodStart: now });
  }
  return { plan, used, limit, allowed: used < limit };
}

// Record one consumed review. `used` must be the post-roll count returned by
// rollAndCheckUsage — NOT sub.reviewsUsed, which can be stale after a roll
// (db.update replaces the row object rather than mutating the passed reference).
export function recordReviewUsage(subId: string, used: number): void {
  db.update("subscriptions", (s) => s.id === subId, { reviewsUsed: used + 1 });
}

// Single source of truth for the private-repo rule: a private repo whose owner's
// effective plan lacks private-repo access (Free, or a lapsed paid sub) is
// blocked. Unlinked installs (no userId yet) get the onboarding grace window and
// are never blocked here — gating begins once the install is linked. The webhook
// nudges the author with an upgrade notice; runReviewJob enforces this for every
// enqueue path so no review is ever posted on a blocked private repo.
export function privateRepoBlocked(
  isPrivate: boolean,
  ownerUserId: string | null | undefined
): boolean {
  if (!isPrivate || !ownerUserId) return false;
  return !PLAN_LIMITS[planForUser(ownerUserId)].privateRepos;
}

// Single source of truth for the security-audit rule: the repo-wide audit, the
// Security page mutations and the devasign/security check-run are Pro/Max. A
// lapsed paid sub is Free here too (effectivePlan), so scanning stops when the
// subscription does. Unlinked installs (no userId yet) get the same onboarding
// grace as privateRepoBlocked and are never blocked. runSecurityAudit enforces
// this for every enqueue path, so no audit runs on a blocked repo.
//
// NB: "gate" in security/gate.ts means the GitHub check-run, not billing —
// hence the deliberately different name here.
export function securityScanBlocked(ownerUserId: string | null | undefined): boolean {
  if (!ownerUserId) return false;
  return !PLAN_LIMITS[planForUser(ownerUserId)].securityScans;
}

// Single source of truth for the cross-repo rule: the PR review's cross-repo
// impact + parity stage is Pro/Max. Same unlinked-install grace as the others —
// and the pipeline enforces it directly, because `stages` is free-editable so a
// free user can flip the toggle on through the API.
export function crossRepoBlocked(ownerUserId: string | null | undefined): boolean {
  if (!ownerUserId) return false;
  return !PLAN_LIMITS[planForUser(ownerUserId)].crossRepo;
}

// Monthly-cap enforcement for a *new* PR review, charged once per unique PR.
// Returns:
//   null               → no charge applies: a re-review of a PR we already track,
//                        a plan-blocked private repo (never reviewed, so it must
//                        not consume the cap), an unlinked install, or a user
//                        with no subscription row.
//   { allowed: true }  → new PR under the cap; one review has been charged.
//   { allowed: false } → new PR at the cap; nothing charged — caller must skip.
//
// Re-pushes/re-opens reuse the existing prReview row and are intentionally free
// (priorReview short-circuits). Called at every new-PR entry point — the `opened`
// webhook, comment-triggered ensurePRReview, and /reviews/sync — so the cap can't
// be bypassed by a path that never reaches the webhook gate.
export function chargeForNewPRReview(
  ownerUserId: string,
  repo: { id: string; private: boolean },
  prNumber: number
): { allowed: boolean; limit: number } | null {
  if (!ownerUserId) return null;
  // A private repo the plan can't review is blocked outright (privateRepoBlocked
  // / runReviewJob); it never runs, so it must never consume a review.
  if (privateRepoBlocked(repo.private, ownerUserId)) return null;
  // Charge once per unique PR — an existing row means this is a re-review.
  const priorReview = db.find(
    "prReviews",
    (r) => r.repoId === repo.id && r.prNumber === prNumber
  );
  if (priorReview) return null;
  const sub = subscriptionForUser(ownerUserId);
  if (!sub) return null;
  const usage = rollAndCheckUsage(sub);
  if (!usage.allowed) return { allowed: false, limit: usage.limit };
  recordReviewUsage(sub.id, usage.used);
  return { allowed: true, limit: usage.limit };
}
