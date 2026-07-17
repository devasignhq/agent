// Offline end-to-end: a PR that delivers a bounty reviews against the bounty's
// LOCKED acceptance list — seeded verbatim (no synthesis), stamped with the
// bountyId, and the assignee is notified when verdicts land. Mirrors
// pipeline-workflow.test.ts: real pipeline, mock LLM (no ANTHROPIC_API_KEY),
// no install row so ingest makes no GitHub calls. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/review/bounty-seed.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { runReviewJob } from "./pipeline.js";

const ACCEPTANCE = [
  "Reads an Idempotency-Key header and scopes it per-account",
  "A replayed key within 24h returns the original response",
  "Keys expire after 24h; idempotency.test.ts covers replay and expiry",
];

const DEV = { githubId: 4242, githubLogin: "devon" };

function seed(opts: { withBounty: boolean; viaClosingRef?: boolean }) {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(), // no install row → ingest skips GitHub entirely
    owner: "acme",
    name: "pay",
    private: false,
    reviewsEnabled: true,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    indexState: "none",
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "feat: idempotency keys",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "queued",
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
  let bountyId: string | null = null;
  if (opts.withBounty) {
    const b = db.insert("bounties", {
      id: uuid(),
      seq: 1,
      code: "BNTY-1",
      source: "github",
      installationId: 1,
      repo: "acme/pay",
      issueNumber: 492,
      issueUrl: "https://github.com/acme/pay/issues/492",
      title: "Add idempotency keys to the payments API",
      description: "Prevent double charges.\n\nDetails…",
      acceptance: ACCEPTANCE,
      taskId: "T".repeat(25),
      contractId: "C1",
      amountStroops: "7500000000",
      amountUsdc: 750,
      deliveryDays: 10,
      status: "IN_REVIEW",
      onchainStatus: "Open",
      applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
      assigneeGithubId: DEV.githubId,
      assigneeGithubLogin: DEV.githubLogin,
      assigneeAddress: "G" + "A".repeat(55),
      // The explicit prNumber link (what markInReview / POST /submit set) —
      // unless the test wants closing-ref resolution instead.
      prNumber: opts.viaClosingRef ? null : 7,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
    bountyId = b.id;
  }
  return { reviewId: review.id, bountyId };
}

beforeEach(() => {
  for (const t of ["repositories", "prReviews", "reviewLogs", "bounties", "users", "notifications", "tasks"] as const) {
    db.remove(t as any, () => true);
  }
  db.insert("users", { id: uuid(), githubId: DEV.githubId, githubLogin: DEV.githubLogin, email: "d@e.com", plan: "free", createdAt: Date.now() } as any);
});

test("bounty PR: criteria seeded verbatim from the locked acceptance list, synthesis skipped", async () => {
  const { reviewId, bountyId } = seed({ withBounty: true });
  await runReviewJob(reviewId);

  const review = db.find("prReviews", (r) => r.id === reviewId)!;
  assert.equal(review.bountyId, bountyId, "review row is stamped with the bounty id");
  assert.equal(review.criteria.length, ACCEPTANCE.length);
  review.criteria.forEach((c, i) => {
    assert.equal(c.id, `bounty-${i + 1}`);
    assert.equal(c.text, ACCEPTANCE[i], "acceptance text is used verbatim");
  });

  const logs = db.filter("reviewLogs", (l) => l.reviewId === reviewId);
  assert.ok(
    logs.some((l) => l.action === "Criteria seeded from bounty (locked at funding)"),
    "seed log present"
  );
  assert.ok(
    !logs.some((l) => l.action === "End goal synthesized"),
    "criteria synthesis must be skipped for a bounty PR"
  );

  // The assignee got a "review complete" notification with the met count.
  const dev = db.find("users", (u) => u.githubId === DEV.githubId)!;
  const notes = db.filter("notifications", (n) => n.userId === dev.id && n.kind === "bounty");
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /BNTY-1 review complete — \d+ of 3 criteria met/);

  // …and the activity log captured the review as a lifecycle event.
  const bounty = db.find("bounties", (x) => x.id === bountyId)!;
  const reviewEvent = (bounty.events ?? []).find((e) => e.kind === "review_completed");
  assert.ok(reviewEvent, "review_completed event appended");
  assert.match(reviewEvent!.detail ?? "", /\d+ of 3 criteria met/);
});

test("non-bounty PR: no bounty stamp, normal synthesis path", async () => {
  const { reviewId } = seed({ withBounty: false });
  await runReviewJob(reviewId);
  const review = db.find("prReviews", (r) => r.id === reviewId)!;
  assert.ok(!review.bountyId, "no bounty linkage on an ordinary PR");
  const logs = db.filter("reviewLogs", (l) => l.reviewId === reviewId);
  assert.ok(!logs.some((l) => l.action === "Criteria seeded from bounty (locked at funding)"));
});

test("re-review keeps the frozen bounty list (no re-seed over existing criteria)", async () => {
  const { reviewId } = seed({ withBounty: true });
  await runReviewJob(reviewId);
  const first = db.find("prReviews", (r) => r.id === reviewId)!;
  const firstIds = first.criteria.map((c) => c.id);

  // Simulate a push: requeue and run again.
  db.update("prReviews", (r) => r.id === reviewId, { status: "queued", headSha: "bcd2345" });
  await runReviewJob(reviewId);
  const second = db.find("prReviews", (r) => r.id === reviewId)!;
  assert.deepEqual(
    second.criteria.map((c) => c.id).slice(0, firstIds.length),
    firstIds,
    "the locked list survives a re-review"
  );
});
