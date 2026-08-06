// Unit tests for the EPHEMERAL_PLAN seeding decision used by
// scripts/ephemeral-dev.ts: paid plans seed an active subscription, everything
// else leaves the seeded user on Free. Run:
//   node --import tsx/esm --test src/billing/ephemeral-plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ephemeralSubscriptionSeed } from "./ephemeral-plan.js";

const NOW = 1_700_000_000_000;

test("EPHEMERAL_PLAN=pro/max seeds an active subscription for the user", () => {
  const pro = ephemeralSubscriptionSeed("pro", "ephemeral-user-1", NOW);
  assert.deepEqual(pro, {
    id: "ephemeral-sub-1",
    userId: "ephemeral-user-1",
    plan: "pro",
    status: "active",
    reviewsUsed: 0,
    usagePeriodStart: NOW,
  });
  assert.equal(ephemeralSubscriptionSeed("max", "ephemeral-user-1", NOW)?.plan, "max");
});

test("the legacy 'team' alias seeds max, same as production plan parsing", () => {
  assert.equal(ephemeralSubscriptionSeed("team", "ephemeral-user-1", NOW)?.plan, "max");
});

test("absent, free, or unrecognized plans seed nothing — the user stays Free", () => {
  assert.equal(ephemeralSubscriptionSeed(undefined, "u", NOW), null);
  assert.equal(ephemeralSubscriptionSeed("", "u", NOW), null);
  assert.equal(ephemeralSubscriptionSeed("free", "u", NOW), null);
  assert.equal(ephemeralSubscriptionSeed("premium", "u", NOW), null);
});
