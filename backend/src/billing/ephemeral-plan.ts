// The EPHEMERAL_PLAN → seeded-subscription decision for scripts/ephemeral-dev.ts.
//
// Lives under src rather than beside the script because the test glob only
// covers `src/**` — and because the plan string should be parsed by the same
// normalizePlan the real billing path uses, so the dev knob accepts exactly
// what production accepts ("team" seeds max as the legacy alias, junk seeds
// nothing) instead of growing its own dialect.
import { normalizePlan } from "./plans.js";

export type EphemeralSubscriptionSeed = {
  id: string;
  userId: string;
  plan: "pro" | "max";
  status: "active";
  reviewsUsed: number;
  usagePeriodStart: number;
};

// Null means "leave the user on Free" — the default, so the locked treatment
// stays the out-of-the-box state the script boots into.
export function ephemeralSubscriptionSeed(
  rawPlan: string | undefined,
  userId: string,
  now: number
): EphemeralSubscriptionSeed | null {
  const plan = normalizePlan(rawPlan);
  if (plan === "free") return null;
  return {
    id: "ephemeral-sub-1",
    userId,
    plan,
    status: "active",
    reviewsUsed: 0,
    usagePeriodStart: now,
  };
}
