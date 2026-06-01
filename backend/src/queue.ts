// In-memory job queue. Stand-in for Cloud Tasks / Pub-Sub in dev.
// Two parallel pending lists (reviews + index) drained round-robin so a long
// initial repo-index build can't starve PR reviews. The shape survives a
// future move to two real queues backed by separate topics.

import { v4 as uuid } from "uuid";

export type MaintainerComment = {
  body: string;
  author: string;
  authorAssociation: string;
  sourceUrl: string;
  sourceEvent:
    | "issue_comment"
    | "pull_request_review"
    | "pull_request_review_comment"
    | "in_app_message";
};

export type ReviewJob = {
  id: string;
  type: "review";
  payload: { reviewId: string };
  enqueuedAt: number;
  attempts: number;
};

export type MaintainerFeedbackJob = {
  id: string;
  type: "maintainer_feedback";
  payload: { reviewId: string; comment: MaintainerComment };
  enqueuedAt: number;
  attempts: number;
};

export type IndexJobPayload = {
  repoId: string;
  full: boolean;
  changedPaths?: {
    added: string[];
    modified: string[];
    removed: string[];
    renamed: Array<{ from: string; to: string }>;
  };
};

export type IndexJob = {
  id: string;
  type: "index";
  payload: IndexJobPayload;
  enqueuedAt: number;
  attempts: number;
};

// Synthesize acceptance criteria from a Linear ticket when it's opened/updated
// (or a comment is added). Drains in the review bucket so a long index build
// can't starve ticket ingestion.
export type LinearIngestJob = {
  id: string;
  type: "linear_ingest";
  payload: { integrationId: string; issueId: string };
  enqueuedAt: number;
  attempts: number;
};

export type Job = ReviewJob | MaintainerFeedbackJob | IndexJob | LinearIngestJob;

const pending: { reviews: Job[]; index: Job[] } = { reviews: [], index: [] };
const subscribers: Array<(job: Job) => void> = [];

export function enqueueReview(reviewId: string): ReviewJob {
  const job: ReviewJob = {
    id: uuid(),
    type: "review",
    payload: { reviewId },
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.reviews.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueMaintainerFeedback(
  reviewId: string,
  comment: MaintainerComment
): MaintainerFeedbackJob {
  const job: MaintainerFeedbackJob = {
    id: uuid(),
    type: "maintainer_feedback",
    payload: { reviewId, comment },
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.reviews.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueLinearIngest(integrationId: string, issueId: string): LinearIngestJob {
  const job: LinearIngestJob = {
    id: uuid(),
    type: "linear_ingest",
    payload: { integrationId, issueId },
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.reviews.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueIndex(payload: IndexJobPayload): IndexJob {
  const job: IndexJob = {
    id: uuid(),
    type: "index",
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.index.push(job);
  process.nextTick(notify);
  return job;
}

export function onJob(cb: (job: Job) => void) {
  subscribers.push(cb);
  notify();
}

let draining = false;
async function notify() {
  if (draining || subscribers.length === 0) return;
  draining = true;
  // Round-robin: take one review-bucket job, then one index-bucket job,
  // repeat until both empty. Reviews come first inside a round so a freshly
  // enqueued review never sits behind an index batch.
  try {
    while (pending.reviews.length > 0 || pending.index.length > 0) {
      const job = pending.reviews.shift() || pending.index.shift();
      if (!job) break;
      job.attempts += 1;
      for (const sub of subscribers) {
        try {
          await sub(job);
        } catch (err) {
          console.error("[queue] subscriber error", err);
        }
      }
      // If both buckets have work, alternate by also draining one from the
      // other side this round before looping.
      if (pending.reviews.length > 0 && pending.index.length > 0) {
        const partner = job.type === "index" ? pending.reviews.shift() : pending.index.shift();
        if (partner) {
          partner.attempts += 1;
          for (const sub of subscribers) {
            try {
              await sub(partner);
            } catch (err) {
              console.error("[queue] subscriber error", err);
            }
          }
        }
      }
    }
  } finally {
    draining = false;
  }
}

export function queueSnapshot() {
  return {
    pending: pending.reviews.length + pending.index.length,
    reviews: pending.reviews.length,
    index: pending.index.length,
    subscribers: subscribers.length,
  };
}
