// Run: node --experimental-strip-types --test src/review-status.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canMessageAgent,
  composerLockPlaceholder,
  composerLockReason,
  queueBadge,
  recentFlag,
  verdictBadge,
} from "./review-status.ts";

test("verdict pills: each status gets its own colour and label", () => {
  assert.deepEqual(queueBadge("passed"), { cls: "ok", label: "approved", pulse: false });
  assert.deepEqual(queueBadge("changes_requested"), { cls: "warn", label: "change requested", pulse: false });
  assert.deepEqual(queueBadge("blocked"), { cls: "danger", label: "blocked", pulse: false });
  assert.deepEqual(queueBadge("queued"), { cls: "", label: "queued", pulse: false });
  assert.equal(queueBadge("reviewing").pulse, true);
});

// The whole point of the change: an ordinary unmet-criteria review is amber,
// and a crashed run says "errored" instead of posing as a blocked verdict.
test("changes_requested is amber, not red", () => {
  assert.equal(queueBadge("changes_requested").cls, "warn");
  assert.notEqual(queueBadge("changes_requested").cls, "danger");
});

test("errored is red but labelled errored, not blocked", () => {
  assert.deepEqual(queueBadge("errored"), { cls: "danger", label: "errored", pulse: false });
});

test("an unknown status degrades to a pill instead of throwing", () => {
  const s = queueBadge("nonsense" as any);
  assert.equal(typeof s.cls, "string");
  assert.equal(typeof s.label, "string");
});

test("merged/closed override every verdict, including passed", () => {
  for (const status of ["passed", "changes_requested", "blocked", "errored", "queued", "reviewing"] as const) {
    assert.deepEqual(queueBadge(status, "merged"), { cls: "nit", label: "merged", pulse: false });
    assert.deepEqual(queueBadge(status, "closed"), { cls: "nit", label: "closed", pulse: false });
  }
});

test("an absent or open prState leaves the verdict showing", () => {
  assert.equal(queueBadge("passed", undefined).label, "approved");
  assert.equal(queueBadge("passed", "open").label, "approved");
});

// The queue card goes gray, but the detail pane must still show what the review
// concluded — that is where a merged PR's verdict stays legible.
test("verdictBadge ignores lifecycle so the detail pane keeps the verdict", () => {
  assert.equal(verdictBadge("blocked").label, "blocked");
  assert.equal(verdictBadge("passed").label, "approved");
});

test("canMessageAgent: open and legacy rows yes, merged/closed no", () => {
  assert.equal(canMessageAgent(undefined), true);
  assert.equal(canMessageAgent("open"), true);
  assert.equal(canMessageAgent("merged"), false);
  assert.equal(canMessageAgent("closed"), false);
});

test("lock copy names the actual lifecycle state, and is absent when open", () => {
  assert.equal(composerLockReason("merged"), "PR merged, messaging closed");
  assert.equal(composerLockReason("closed"), "PR closed, messaging closed");
  assert.equal(composerLockReason("open"), null);
  assert.equal(composerLockReason(undefined), null);
  assert.match(composerLockPlaceholder("merged")!, /merged/);
  assert.equal(composerLockPlaceholder(undefined), null);
});

test("sidebar flag: only red tiers are blockers, finished PRs are ok", () => {
  assert.equal(recentFlag("blocked"), "blocker");
  assert.equal(recentFlag("errored"), "blocker");
  assert.equal(recentFlag("changes_requested"), "review");
  assert.equal(recentFlag("passed"), "ok");
  assert.equal(recentFlag("blocked", "merged"), "ok");
  assert.equal(recentFlag("changes_requested", "closed"), "ok");
});
