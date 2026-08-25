// Offline end-to-end: a stored workflow stage toggle changes what the review
// agent actually does. Mirrors private-repo-gate.test.ts — seed the in-memory
// db and run the REAL pipeline with no network/LLM: no ANTHROPIC_API_KEY forces
// the LLM mock, and seeding no install row means ingest makes no GitHub calls.
// We assert on the reviewLogs the pipeline emits (the holistic stage logs whether
// it ran), which land before any GitHub posting. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/pipeline-workflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { DEFECT_STAGE_DISABLED, runReviewJob } from "./pipeline.js";
import {
  CROSS_REPO_NO_INSTALL,
  CROSS_REPO_PLAN_LOCKED,
  CROSS_REPO_STAGE_DISABLED,
} from "./cross-repo/run.js";

const HOLISTIC_DISABLED = "Whole-repo review disabled by workflow";

// Seed a PUBLIC repo (no private-repo gate) carrying `workflow`, plus a queued
// review, and deliberately NO matching install row so ingestContext skips every
// GitHub call. Returns the review id.
function seedReview(workflow: any, opts: { installId?: string } = {}): string {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: opts.installId ?? uuid(), // unmatched id → ingest skips GitHub
    owner: "acme",
    name: "widgets",
    private: false,
    reviewsEnabled: true,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    indexState: "none",
    workflow,
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 1,
    prTitle: "Add widget",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "queued",
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
  return review.id;
}

test("stages.holistic=false → pipeline skips the whole-repo review", async () => {
  const id = seedReview({ version: 1, stages: { holistic: false } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    logs.some((l) => l.action === HOLISTIC_DISABLED),
    `expected a "${HOLISTIC_DISABLED}" log when stages.holistic is off`
  );
});

test("stages.holistic=true → pipeline runs the whole-repo stage (does not log it disabled)", async () => {
  const id = seedReview({ version: 1, stages: { holistic: true } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    !logs.some((l) => l.action === HOLISTIC_DISABLED),
    `must not log "${HOLISTIC_DISABLED}" when stages.holistic is on`
  );
  // With holistic on but no index built, the stage runs and reports the empty
  // index — proving the on-branch was taken (not the disabled short-circuit).
  assert.ok(
    logs.some((l) => l.action.includes("Repo index not yet built")),
    "holistic stage should run and note the empty index"
  );
});

// ─── Bug detection stage ────────────────────────────────────────────────────
// The stage exists to close the "every criterion met, code still wrong" gap, so
// the default matters as much as the toggle: a repo that never visits the
// Workflow screen must still get it.

test("stages.defects=false → pipeline skips the bug-detection stage", async () => {
  const id = seedReview({ version: 1, stages: { defects: false } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    logs.some((l) => l.action === DEFECT_STAGE_DISABLED),
    `expected a "${DEFECT_STAGE_DISABLED}" log when stages.defects is off`
  );
});

test("bug detection is ON for a repo with no stored workflow at all", async () => {
  const id = seedReview(undefined);
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    !logs.some((l) => l.action === DEFECT_STAGE_DISABLED),
    "an un-customised repo must still get bug detection — that's the point of the default"
  );
});

test("stages.defects=true → pipeline does not log the stage disabled", async () => {
  const id = seedReview({ version: 1, stages: { defects: true } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(!logs.some((l) => l.action === DEFECT_STAGE_DISABLED));
});

// ─── Cross-repo stage ───────────────────────────────────────────────────────
// Advisory and Pro/Max-only. `stages` is a free-editable field, so the plan gate
// has to live in the pipeline — the UI lock alone is not enforcement.

// An install row + a subscription, and seedReview points the repo AT it — that is
// the point: `install` has to resolve for crossRepoBlocked(install.userId) to be
// reachable at all. Restoring a dangling id here would silently move these tests
// onto the !install branch and stop them proving anything about the plan gate.
function seedOwner(plan: "free" | "pro"): { installId: string; userId: string } {
  const userId = uuid();
  const installId = uuid();
  db.insert("installations", {
    id: installId,
    userId,
    userIds: [userId],
    accountId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    installationId: 4242,
    repoIds: [],
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
  return { installId, userId };
}

test("cross-repo is OFF for a repo with no stored workflow at all", async () => {
  const id = seedReview(undefined);
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    logs.some((l) => l.action === CROSS_REPO_STAGE_DISABLED),
    "an un-customised repo must NOT run the cross-repo stage — it is opt-in"
  );
});

test("stages.crossRepo=false → pipeline skips the cross-repo stage", async () => {
  const id = seedReview({ version: 1, stages: { crossRepo: false } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(logs.some((l) => l.action === CROSS_REPO_STAGE_DISABLED));
});

test("stages.crossRepo=true on a Free plan → the pipeline refuses, not just the UI", async () => {
  const { installId } = seedOwner("free");
  const id = seedReview({ version: 1, stages: { crossRepo: true } }, { installId });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(
    logs.some((l) => l.action === CROSS_REPO_PLAN_LOCKED),
    "a free user flipping stages.crossRepo through the API must still be gated"
  );
  assert.ok(!logs.some((l) => l.action === CROSS_REPO_STAGE_DISABLED));
});

test("stages.crossRepo=true on Pro but no install token → skipped, never thrown", async () => {
  const id = seedReview({ version: 1, stages: { crossRepo: true } });
  await runReviewJob(id);
  const logs = db.filter("reviewLogs", (l) => l.reviewId === id);
  assert.ok(logs.some((l) => l.action === CROSS_REPO_NO_INSTALL));
});

test("the cross-repo stage never changes the verdict", async () => {
  const off = seedReview({ version: 1, stages: { crossRepo: false } });
  await runReviewJob(off);
  const { installId } = seedOwner("pro");
  const on = seedReview({ version: 1, stages: { crossRepo: true } }, { installId });
  await runReviewJob(on);
  assert.equal(
    db.find("prReviews", (r) => r.id === on)!.status,
    db.find("prReviews", (r) => r.id === off)!.status
  );
});
