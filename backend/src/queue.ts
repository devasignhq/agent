// In-memory job queue. Stand-in for Cloud Tasks / Pub-Sub in dev.
// One worker drains it sequentially; that's enough for local dev.

import { v4 as uuid } from "uuid";

export type MaintainerComment = {
  body: string;
  author: string;
  authorAssociation: string;
  sourceUrl: string;
  sourceEvent: "issue_comment" | "pull_request_review";
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

export type Job = ReviewJob | MaintainerFeedbackJob;

const pending: Job[] = [];
const subscribers: Array<(job: Job) => void> = [];

export function enqueueReview(reviewId: string): ReviewJob {
  const job: ReviewJob = {
    id: uuid(),
    type: "review",
    payload: { reviewId },
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.push(job);
  // Notify the worker on next tick so the producer's response can return first.
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
  pending.push(job);
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
  try {
    while (pending.length > 0) {
      const job = pending.shift()!;
      job.attempts += 1;
      for (const sub of subscribers) {
        try {
          await sub(job);
        } catch (err) {
          console.error("[queue] subscriber error", err);
        }
      }
    }
  } finally {
    draining = false;
  }
}

export function queueSnapshot() {
  return { pending: pending.length, subscribers: subscribers.length };
}
