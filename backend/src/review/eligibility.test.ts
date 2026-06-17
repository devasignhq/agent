// Eligibility-gate unit tests — who-opened-it triggering by plan tier. Runs
// without Stripe/Postgres (the db falls back to an in-memory store). Run:
//   node --import tsx/esm --test src/review/eligibility.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import {
  isAccountOwner,
  isReviewTriggerComment,
  shouldAutoReviewOpenedPR,
} from "./eligibility.js";

// Seed a linked account: a user row + a subscription fixing the effective plan.
function seedOwner(plan: "free" | "pro" | "max", gh: { id: number; login: string }) {
  const userId = uuid();
  db.insert("users", {
    id: userId,
    githubId: gh.id,
    githubLogin: gh.login,
    email: `${gh.login}@example.com`,
    plan,
    createdAt: Date.now(),
  } as any);
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: plan === "free" ? null : "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  return userId;
}

test("isReviewTriggerComment: exact 'review' / '/review' only", () => {
  for (const ok of ["review", "Review", "  REVIEW  ", "/review", "/Review"]) {
    assert.equal(isReviewTriggerComment(ok), true, ok);
  }
  for (const no of ["", "  ", "please review", "I'll review this later", "reviews", "review!", "lgtm"]) {
    assert.equal(isReviewTriggerComment(no), false, JSON.stringify(no));
  }
});

test("isAccountOwner: matches on github id, then falls back to login", () => {
  const userId = seedOwner("free", { id: 4242, login: "alice" });

  // Id match (login can be anything).
  assert.equal(isAccountOwner(userId, "whatever", 4242), true);
  // Id mismatch is decisive even when the login happens to match.
  assert.equal(isAccountOwner(userId, "alice", 9999), false);
  // No id on the event → case-insensitive login compare.
  assert.equal(isAccountOwner(userId, "ALICE"), true);
  assert.equal(isAccountOwner(userId, "bob"), false);
  // Unknown / empty owner → never the owner.
  assert.equal(isAccountOwner("", "alice", 4242), false);
  assert.equal(isAccountOwner(uuid(), "alice", 4242), false);
});

test("shouldAutoReviewOpenedPR — Free/Pro: only the owner's own PRs", () => {
  for (const plan of ["free", "pro"] as const) {
    const ownerId = seedOwner(plan, { id: 100, login: "owner" });
    const own = { ownerUserId: ownerId, prAuthorLogin: "owner", prAuthorId: 100 };
    const member = {
      ownerUserId: ownerId,
      prAuthorLogin: "teammate",
      prAuthorId: 200,
      authorAssociation: "MEMBER",
    };
    const external = {
      ownerUserId: ownerId,
      prAuthorLogin: "stranger",
      prAuthorId: 300,
      authorAssociation: "NONE",
    };
    assert.equal(shouldAutoReviewOpenedPR(own), true, `${plan}: own PR`);
    // Even an org member's PR is NOT auto-reviewed below Max.
    assert.equal(shouldAutoReviewOpenedPR(member), false, `${plan}: member PR`);
    assert.equal(shouldAutoReviewOpenedPR(external), false, `${plan}: external PR`);
  }
});

test("shouldAutoReviewOpenedPR — Max: owner + any team member, not outsiders", () => {
  const ownerId = seedOwner("max", { id: 100, login: "owner" });
  const base = { ownerUserId: ownerId };

  assert.equal(
    shouldAutoReviewOpenedPR({ ...base, prAuthorLogin: "owner", prAuthorId: 100 }),
    true,
    "owner's own PR"
  );
  for (const assoc of ["OWNER", "MEMBER"]) {
    assert.equal(
      shouldAutoReviewOpenedPR({ ...base, prAuthorLogin: "teammate", prAuthorId: 200, authorAssociation: assoc }),
      true,
      `team member (${assoc})`
    );
  }
  for (const assoc of ["COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", undefined]) {
    assert.equal(
      shouldAutoReviewOpenedPR({ ...base, prAuthorLogin: "stranger", prAuthorId: 300, authorAssociation: assoc }),
      false,
      `non-team (${assoc})`
    );
  }
});

test("shouldAutoReviewOpenedPR — unlinked install keeps reviewing everything", () => {
  // No ownerUserId yet (onboarding grace) → review regardless of author.
  assert.equal(
    shouldAutoReviewOpenedPR({ ownerUserId: "", prAuthorLogin: "anyone", prAuthorId: 1, authorAssociation: "NONE" }),
    true
  );
});
