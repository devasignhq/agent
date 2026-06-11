// normalizeMetadata tests. track()'s metadata accepts numbers/booleans/null for
// call-site readability, but the Statsig event metadata is string-valued, so the
// helper stringifies survivors and drops null/undefined. These shapes mirror the
// real call sites (pr_number: number, is_private: boolean, workspace_name:
// string|null — see github/webhooks.ts, linear/oauth.ts, billing/stripe.ts). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/statsig.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMetadata, track, toStatsigUser } from "./statsig.js";
import type { User } from "./types.js";

const user: User = {
  id: "u-123",
  githubId: 42,
  githubLogin: "octocat",
  email: "octo@example.com",
  plan: "pro",
  createdAt: 0,
};

test("stringifies number and boolean values", () => {
  assert.deepEqual(
    normalizeMetadata({ pr_number: 482, is_private: true, repo_count: 0, reconnected: false }),
    { pr_number: "482", is_private: "true", repo_count: "0", reconnected: "false" }
  );
});

test("drops null and undefined keys, keeps the rest", () => {
  assert.deepEqual(
    normalizeMetadata({ workspace_name: null, interval: undefined, plan: "pro" }),
    { plan: "pro" }
  );
});

test("leaves string values unchanged", () => {
  assert.deepEqual(
    normalizeMetadata({ integration_type: "slack", trigger: "opened" }),
    { integration_type: "slack", trigger: "opened" }
  );
});

test("returns undefined when no metadata is supplied", () => {
  assert.equal(normalizeMetadata(undefined), undefined);
});

test("returns an empty object when every value is dropped", () => {
  assert.deepEqual(normalizeMetadata({ a: null, b: undefined }), {});
});

// ── track(): no-op while the client is uninitialized ─────────────────────────
// initStatsig() is never called here, so the module-level client stays null.
// track() must return without throwing for every call shape — analytics is
// best-effort and must not break the request path it sits on.
test("track() is a no-op and never throws when the client is uninitialized", () => {
  assert.doesNotThrow(() => track(user, "account purged"));
  assert.doesNotThrow(() => track("u-123", "account deletion requested"));
  assert.doesNotThrow(() => track(user, "pr opened", { pr_number: 482, is_private: true }));
  assert.equal(track(user, "noop"), undefined);
});

// ── toStatsigUser(): User-vs-string mapping ──────────────────────────────────
test("toStatsigUser() maps a full User onto the StatsigUser fields", () => {
  const su = toStatsigUser(user);
  assert.equal(su.userID, user.id);
  assert.equal(su.email, user.email);
  assert.equal(su.custom?.github_login, user.githubLogin);
  assert.equal(su.custom?.plan, user.plan);
});

test("toStatsigUser() maps a bare userId string with no profile fields", () => {
  const su = toStatsigUser("webhook-user");
  assert.equal(su.userID, "webhook-user");
  assert.equal(su.email, null);
  assert.equal(su.custom, null);
});

// ── workflow-event payloads are Statsig-safe ─────────────────────────────────
// The review-pipeline events (review completed / repo indexed / video reviewed)
// hand track() a mix of numbers, booleans, and null-valued diff stats. This pins
// the contract every one of them rides on: numbers/booleans stringify, and the
// nullable fields (additions/deletions/changed_files when GitHub hasn't returned
// them yet) drop out rather than riding along as "null".
test("a review-completed payload normalizes to all-string, no-null metadata", () => {
  const out = normalizeMetadata({
    repo: "octo/app",
    pr_number: 7,
    status: "passed",
    is_private: false,
    holistic_blockers: true,
    is_first_review: true,
    is_new_commit: false,
    additions: null,
    deletions: null,
    changed_files: null,
    est_cost_usd: 3.2,
    input_tokens: 5000,
  })!;
  assert.equal(out.pr_number, "7");
  assert.equal(out.status, "passed");
  assert.equal(out.is_private, "false");
  assert.equal(out.holistic_blockers, "true");
  assert.equal(out.is_first_review, "true");
  assert.equal(out.is_new_commit, "false");
  assert.equal(out.est_cost_usd, "3.2");
  assert.equal(out.input_tokens, "5000");
  // The nullable diff stats are dropped, not stringified to "null".
  assert.equal("additions" in out, false);
  assert.equal("deletions" in out, false);
  assert.equal("changed_files" in out, false);
  assert.ok(Object.values(out).every((v) => typeof v === "string"));
});
