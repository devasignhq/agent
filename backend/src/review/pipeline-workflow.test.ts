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
import { runReviewJob } from "./pipeline.js";

const HOLISTIC_DISABLED = "Whole-repo review disabled by workflow";

// Seed a PUBLIC repo (no private-repo gate) carrying `workflow`, plus a queued
// review, and deliberately NO matching install row so ingestContext skips every
// GitHub call. Returns the review id.
function seedReview(workflow: any): string {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(), // no install row has this id → ingest skips GitHub
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
