// Offline: the resolve handler's "no plan is coming" answers — the App's own
// onboarding PR, and a PR the webhook declined to review.
//   DATABASE_URL= node --import tsx/esm --test src/routes/v1-resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { resolveHandler } from "./v1.js";
import { NO_REVIEW_GRACE_MS, noteRunnerPoll } from "../verify/runs.js";

const SHA = "a".repeat(40);

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

function seedRepo(onboardingPrNumber?: number) {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: uuid(), accountId: 1, accountLogin: "acme", installationId: 77, repoIds: [] } as any);
  return db.insert("repositories", {
    id: uuid(), installationId: installId, owner: "acme", name: "widgets", defaultBranch: "main",
    private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
    verify: { onboarding: onboardingPrNumber ? { state: "pr_open", prNumber: onboardingPrNumber } : { state: "none" } },
  } as any);
}

const req = (repo: any, pr: number, over: Record<string, unknown> = {}) =>
  ({ body: { sha: SHA, pr, ...over }, runner: { repo, claims: { ref: "refs/heads/x" }, plan: "pro" } }) as any;

test("the App's own onboarding PR resolves empty at once, never pending", async () => {
  const repo = seedRepo(17);
  const res = fakeRes();
  await resolveHandler(req(repo, 17), res);
  assert.equal(res.body.status, "empty");
  assert.equal(res.body.reason, "onboarding_pr");
  // A different PR on the same repo is unaffected.
  const other = fakeRes();
  await resolveHandler(req(repo, 18), other);
  assert.equal(other.body.status, "pending");
});

test("no review row yet stays pending — the webhook may still be in flight", async () => {
  const repo = seedRepo();
  const res = fakeRes();
  await resolveHandler(req(repo, 42), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "pending");
  assert.ok(res.body.giveUpAfterMs > 0, "tells the runner when to stop burning CI minutes");
});

test("a runner that has polled past the grace with still no review row gets empty", async () => {
  const repo = seedRepo();
  // Backdate the first poll: the webhook has had its full grace window to arrive.
  noteRunnerPoll(repo.id, 43, SHA, Date.now() - NO_REVIEW_GRACE_MS - 1_000);
  const res = fakeRes();
  await resolveHandler(req(repo, 43), res);
  assert.equal(res.body.status, "empty");
  assert.equal(res.body.reason, "not_reviewed");
});

test("a review row created during the grace wins over the decline heuristic", async () => {
  const repo = seedRepo();
  noteRunnerPoll(repo.id, 44, SHA, Date.now() - NO_REVIEW_GRACE_MS - 1_000);
  db.insert("prReviews", {
    id: uuid(), repoId: repo.id, prNumber: 44, prTitle: "t", headSha: SHA, baseSha: "b",
    status: "queued", verdict: null, criteria: [], taskId: null, additions: null, deletions: null,
    changedFiles: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  const res = fakeRes();
  await resolveHandler(req(repo, 44), res);
  assert.equal(res.body.status, "pending", "a real review must never be answered 'empty'");
});
