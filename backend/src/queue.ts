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

// Distill a maintainer-attached guidance material (video/doc link or uploaded
// PDF) into review guidelines, immediately on add. Drains in the index bucket
// alongside repo indexing. For PDFs the base64 rides along on the payload —
// the in-memory queue holds the bytes so we never persist them to the DB.
export type GuidanceIngestJob = {
  id: string;
  type: "guidance_ingest";
  payload: { repoId: string; itemId: string; pdfBase64?: string; pdfMediaType?: string };
  enqueuedAt: number;
  attempts: number;
};

// Draft a bounty's acceptance criteria from its issue + the repo index, right
// after creation. Drains in the review bucket, NOT the index bucket: a sponsor
// is about to follow the "Fund bounty" link out of a GitHub comment and would
// otherwise sit behind a multi-minute repo index build.
export type BountyCriteriaJob = {
  id: string;
  type: "bounty_criteria";
  payload: { bountyId: string };
  enqueuedAt: number;
  attempts: number;
};

// Whole-codebase security audit (backend/src/security/audit.ts). Drains in the
// index bucket and is enqueued AFTER the merge's enqueueIndex, so FIFO within
// the bucket guarantees the index refresh (whose securityFlags gate the audit's
// file selection) lands before the audit reads it.
export type SecurityAuditJobPayload = {
  repoId: string;
  scanRunId: string; // pre-created SecurityScanRun row (status "queued")
  trigger: "merge" | "manual" | "nightly";
  full: boolean;
  changedPaths?: IndexJobPayload["changedPaths"];
  pr?: { number: number; title: string; mergeSha: string; author: string } | null;
};

export type SecurityAuditJob = {
  id: string;
  type: "security_audit";
  payload: SecurityAuditJobPayload;
  enqueuedAt: number;
  attempts: number;
};

// Org repository map for the cross-repo review stage. Drains in the index bucket:
// it is a latency-tolerant org walk and must never starve a PR review.
export type CrossRepoTopologyJobPayload = {
  installationId: string; // Installation.id (DB uuid)
  trigger: "cold" | "stale" | "webhook" | "manual";
};

export type CrossRepoTopologyJob = {
  id: string;
  type: "cross_repo_topology";
  payload: CrossRepoTopologyJobPayload;
  enqueuedAt: number;
  attempts: number;
};

// Verifier jobs. Their own bucket: a runner is long-polling for the plan and a
// results upload is waiting on judgment — neither may sit behind a repo index.
export type VerifyPlanJob = { id: string; type: "verify_plan"; payload: { runId: string }; enqueuedAt: number; attempts: number };
export type VerifyJudgeJob = { id: string; type: "verify_judge"; payload: { runId: string }; enqueuedAt: number; attempts: number };
export type VerifyFeedbackJob = {
  id: string;
  type: "verify_feedback";
  payload: { reviewId: string; commentId: number };
  enqueuedAt: number;
  attempts: number;
};
export type VerifyOnboardJob = {
  id: string;
  type: "verify_onboard";
  payload: { repoId: string; trigger: "install" | "manual" | "doctor" };
  enqueuedAt: number;
  attempts: number;
};

export type Job =
  | ReviewJob
  | MaintainerFeedbackJob
  | IndexJob
  | LinearIngestJob
  | GuidanceIngestJob
  | BountyCriteriaJob
  | SecurityAuditJob
  | CrossRepoTopologyJob
  | VerifyPlanJob
  | VerifyJudgeJob
  | VerifyFeedbackJob
  | VerifyOnboardJob;

const BUCKETS = ["reviews", "verify", "index"] as const;
type Bucket = (typeof BUCKETS)[number];
const pending: Record<Bucket, Job[]> = { reviews: [], verify: [], index: [] };
const subscribers: Array<(job: Job) => void> = [];

export function enqueueReview(reviewId: string): ReviewJob {
  // Idempotent: several producers can ask for the same review (webhook
  // redelivery, the dashboard sync poll racing the webhook, a reopen). A
  // second job for a row that's still waiting would run the whole pipeline —
  // and post GitHub comments — twice, so return the queued job instead.
  const waiting = pending.reviews.find(
    (j): j is ReviewJob => j.type === "review" && j.payload.reviewId === reviewId
  );
  if (waiting) return waiting;
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

export function enqueueBountyCriteria(bountyId: string): BountyCriteriaJob {
  // Idempotent, for the same reason enqueueReview is: a webhook redelivery or a
  // re-comment could ask twice, and a second job would burn a second LLM call
  // to overwrite the first one's answer.
  const waiting = pending.reviews.find(
    (j): j is BountyCriteriaJob => j.type === "bounty_criteria" && j.payload.bountyId === bountyId
  );
  if (waiting) return waiting;
  const job: BountyCriteriaJob = {
    id: uuid(),
    type: "bounty_criteria",
    payload: { bountyId },
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

export function enqueueGuidanceIngest(
  payload: GuidanceIngestJob["payload"]
): GuidanceIngestJob {
  const job: GuidanceIngestJob = {
    id: uuid(),
    type: "guidance_ingest",
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.index.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueSecurityAudit(payload: SecurityAuditJobPayload): SecurityAuditJob {
  // Idempotent per repo: a webhook redelivery (or a manual re-scan racing a
  // merge) must not run two audits over the same files and double-pay the LLM.
  const waiting = pending.index.find(
    (j): j is SecurityAuditJob => j.type === "security_audit" && j.payload.repoId === payload.repoId
  );
  if (waiting) return waiting;
  const job: SecurityAuditJob = {
    id: uuid(),
    type: "security_audit",
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.index.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueCrossRepoTopology(
  payload: CrossRepoTopologyJobPayload
): CrossRepoTopologyJob {
  // Idempotent per installation: the hourly sweep, a webhook and a cold-cache
  // review can all ask at once, and one org walk serves all three.
  const waiting = pending.index.find(
    (j): j is CrossRepoTopologyJob =>
      j.type === "cross_repo_topology" && j.payload.installationId === payload.installationId
  );
  if (waiting) return waiting;
  const job: CrossRepoTopologyJob = {
    id: uuid(),
    type: "cross_repo_topology",
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.index.push(job);
  process.nextTick(notify);
  return job;
}

function enqueueVerify<J extends VerifyPlanJob | VerifyJudgeJob>(type: J["type"], runId: string): J {
  const waiting = pending.verify.find(
    (j): j is J => j.type === type && (j as J).payload.runId === runId
  );
  if (waiting) return waiting;
  const job = { id: uuid(), type, payload: { runId }, enqueuedAt: Date.now(), attempts: 0 } as J;
  pending.verify.push(job);
  process.nextTick(notify);
  return job;
}

export const enqueueVerifyPlan = (runId: string) => enqueueVerify<VerifyPlanJob>("verify_plan", runId);
export const enqueueVerifyJudge = (runId: string) => enqueueVerify<VerifyJudgeJob>("verify_judge", runId);

export function enqueueVerifyFeedback(reviewId: string, commentId: number): VerifyFeedbackJob {
  const job: VerifyFeedbackJob = {
    id: uuid(),
    type: "verify_feedback",
    payload: { reviewId, commentId },
    enqueuedAt: Date.now(),
    attempts: 0,
  };
  pending.verify.push(job);
  process.nextTick(notify);
  return job;
}

export function enqueueVerifyOnboard(payload: VerifyOnboardJob["payload"]): VerifyOnboardJob {
  const waiting = pending.verify.find(
    (j): j is VerifyOnboardJob => j.type === "verify_onboard" && j.payload.repoId === payload.repoId
  );
  if (waiting) return waiting;
  const job: VerifyOnboardJob = { id: uuid(), type: "verify_onboard", payload, enqueuedAt: Date.now(), attempts: 0 };
  pending.verify.push(job);
  process.nextTick(notify);
  return job;
}

export function onJob(cb: (job: Job) => void) {
  subscribers.push(cb);
  notify();
}

async function runOne(job: Job): Promise<void> {
  job.attempts += 1;
  for (const sub of subscribers) {
    try {
      await sub(job);
    } catch (err) {
      console.error("[queue] subscriber error", err);
    }
  }
}

let draining = false;
async function notify() {
  if (draining || subscribers.length === 0) return;
  draining = true;
  // Round-robin across buckets, reviews first within a round, so a freshly
  // enqueued review never sits behind an index batch and a waiting runner
  // never sits behind either.
  try {
    while (BUCKETS.some((b) => pending[b].length > 0)) {
      for (const b of BUCKETS) {
        const job = pending[b].shift();
        if (job) await runOne(job);
      }
    }
  } finally {
    draining = false;
  }
}

export function queueSnapshot() {
  return {
    pending: pending.reviews.length + pending.verify.length + pending.index.length,
    reviews: pending.reviews.length,
    verify: pending.verify.length,
    index: pending.index.length,
    subscribers: subscribers.length,
  };
}
