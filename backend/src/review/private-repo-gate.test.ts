// Worker-chokepoint private-repo gate. runReviewJob must refuse a free/lapsed
// owner's private-repo PR no matter which path enqueued it (comment-triggered
// ensurePRReview, /reviews/sync, rerun, synchronize, maintainer feedback),
// posting nothing and dropping the stray row + logs. The gate short-circuits
// before any LLM/GitHub call, so this runs fully offline. Run:
//   node --import tsx/esm --test src/review/private-repo-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { runReviewJob } from "./pipeline.js";

test("runReviewJob drops a free-plan private-repo review without posting", async () => {
  const userId = uuid();
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan: "free",
    status: null,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
  } as any);
  const install = db.insert("installations", {
    id: uuid(),
    installationId: 12345,
    userId,
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: "secret",
    private: true,
    reviewsEnabled: true,
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 1,
    status: "queued",
    criteria: [],
  } as any);
  db.insert("reviewLogs", {
    id: uuid(),
    reviewId: review.id,
    kind: "ingest",
    at: Date.now(),
    action: "commit.push",
  } as any);

  // Resolves immediately — the gate returns before withModel/ingest, so no
  // network or LLM is touched.
  await runReviewJob(review.id);

  // The stray row and its logs are gone; nothing was posted to GitHub.
  assert.equal(db.find("prReviews", (r) => r.id === review.id), null);
  assert.equal(db.filter("reviewLogs", (l) => l.reviewId === review.id).length, 0);
});
