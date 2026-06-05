// Domain types mirror the Firestore sketch in devasign.md §3.

export type User = {
  id: string;
  githubId: number | null;
  githubLogin: string;
  email: string;
  avatarUrl?: string;
  plan: "free" | "pro" | "max";
  createdAt: number;
  // ── Account-deletion lifecycle (soft delete with a 14-day restore window) ──
  // Set when the user requests deletion; its presence means "pending deletion",
  // which pauses code review. The purge sweep wipes the account 14 days later.
  // Cleared when they log back in — logging in is what restores the account.
  deletionRequestedAt?: number;
  // Guards the one-time day-12 reminder email so the sweep doesn't resend it.
  reminderSentAt?: number;
  // One-shot flag set on restore; the frontend shows a "welcome back" pop-up,
  // then acks it (POST /api/me/welcome-back/ack) to clear it.
  welcomeBack?: boolean;
};

export type Installation = {
  id: string;
  userId: string;
  accountId: number;
  accountLogin: string;
  installationId: number;
  repoIds: number[];
};

export type Repository = {
  id: string;
  installationId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  // GitHub repo visibility. Free tier reviews public repos only; the review
  // gate refuses private repos for effective-free users. Persisted from the
  // `private` flag on install/PR webhook payloads.
  private: boolean;
  defaultModel: string;
  modelOverrides: Record<string, string>;
  reviewsEnabled: boolean;
  // Repo-index state. Optional so DB rows written before the indexer existed
  // still load — treat undefined as "none" at every branch site.
  indexState?: RepoIndexState;
  indexedAt?: number;
  indexedCommit?: string;
  indexedFileCount?: number;
  indexError?: string | null;
};

export type RepoIndexState =
  | "none"      // never indexed (legacy / pre-migration rows)
  | "queued"    // build job sitting on the index queue
  | "indexing"  // worker is actively walking the tree
  | "ready"     // index is up-to-date as of indexedAt
  | "stale"     // PR merged; awaiting incremental refresh
  | "errored";

export type RepoIndexEntry = {
  id: string;
  repoId: string;            // FK -> Repository.id
  path: string;              // "backend/src/review/pipeline.ts"
  sha: string;               // blob SHA from git tree — sha-keyed cache
  size: number;
  language: string;          // derived from extension ("ts", "tsx", "py", ...)
  summary: string;           // 2-4 sentence Haiku summary
  exports: string[];         // top-level symbol names (function/class/const)
  imports: string[];         // module specifiers as written
  securityFlags: string[];   // free-form tags ("reads-env", "raw-sql", ...)
  indexedAt: number;
  model: string;             // model that produced this entry
};

export type IntegrationType = "slack" | "linear" | "discord";

export type Integration = {
  id: string;
  userId: string;
  type: IntegrationType;
  tokens: Record<string, string>;
  workspaceMeta: Record<string, string>;
  createdAt: number;
};

export type Task = {
  id: string;
  source: "github" | "linear" | "slack" | "discord";
  externalId: string;
  title: string;
  endGoal: string | null;
  attachments: TaskAttachment[];
  createdAt: number;
  // Set when we've already asked for an end goal on a spec-less PR (no linked
  // issue/attachments). Keeps the "provide an end goal" PR comment idempotent
  // so re-reviews on later pushes don't re-spam the conversation.
  endGoalRequestedAt?: number | null;

  // ── Linear ticket support (all optional so legacy rows still load) ────────
  // Cached acceptance criteria. For a Linear-sourced task these are synthesized
  // when the ticket is opened/updated (webhook) and seeded into a PRReview when
  // a PR is matched to the ticket.
  criteria?: Criterion[];
  // Human-facing issue identifier (e.g. "ENG-123"), used to match PRs by text.
  externalKey?: string | null;
  // Canonical URL of the source issue (Linear), for linking in comments.
  url?: string;
  // Owning DevAsign user (the one who connected the Linear workspace). Lets us
  // scope/clean up Linear tasks; GitHub PR tasks leave this unset.
  userId?: string;
  // Last time the cached criteria were refreshed.
  updatedAt?: number;
  // Set on a PR's own task when the review is resolved to a Linear issue
  // (explicit ref or fuzzy match). Drives the Linear notification write-back.
  linkedLinearIssue?: { id: string; identifier: string; url: string } | null;
  // Head SHA we last posted a Linear notification comment for — keeps the
  // notification idempotent across re-reviews on later pushes.
  linearNotifiedSha?: string | null;
};

export type TaskAttachment = {
  id: string;
  kind: "loom" | "figma" | "image" | "pdf" | "link" | "text";
  url?: string;
  contentRef?: string; // Cloud Storage path
  note?: string;
  createdAt?: number;
};

export type PRReviewStatus =
  | "queued"
  | "reviewing"
  | "passed"
  | "changes_requested"
  | "errored";

export type Criterion = {
  id: string;
  text: string;
  met: boolean | null;
  evidence: string | null;
};

export type PRReview = {
  id: string;
  repoId: string;
  prNumber: number;
  prTitle: string;
  headSha: string;
  baseSha: string;
  status: PRReviewStatus;
  verdict: string | null;
  criteria: Criterion[];
  taskId: string | null;
  // Diff stats from GitHub. Populated on review materialization and refreshed
  // by the pipeline; may be null until we've fetched the full PR object.
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ReviewLogKind =
  | "ingest"
  | "criteria"
  | "review"
  | "tool"
  | "comment"
  | "verdict"
  | "error"
  | "holistic"
  | "finding";

export type ReviewLogEntry = {
  id: string;
  reviewId: string;
  kind: ReviewLogKind;
  at: number;
  action: string;
  target?: string;
  detail?: string;
  meta?: Record<string, unknown>;
};

// Mirrors the Stripe subscription status enum (the subset we act on).
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

export type Subscription = {
  id: string;
  userId: string;
  // The PURCHASED tier. Gating never reads this directly — it goes through
  // effectivePlan() (billing/plans.ts), which downgrades to "free" whenever
  // `status` isn't active/trialing. So a lapsed sub is treated as Free without
  // rewriting this field, and the UI still knows what to restore.
  plan: "free" | "pro" | "max";
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  // null for a brand-new free row that never had a Stripe subscription.
  status: SubscriptionStatus | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  // The billed interval, synced from the Stripe price. Optional/absent on legacy
  // rows and brand-new free rows; read via intervalOf() which defaults to "month".
  interval?: "month" | "year" | null;
  // A deferred switch scheduled via a Stripe Subscription Schedule: the tier and
  // interval it switches to at period end + the schedule id (for revert). null
  // when none. pendingInterval is optional so old rows still load.
  pendingPlan: "free" | "pro" | "max" | null;
  pendingInterval?: "month" | "year" | null;
  scheduleId: string | null;
  // Monthly PR-review usage: `reviewsUsed` counts unique PRs reviewed in the
  // window that began at `usagePeriodStart` (rolls monthly for free; synced to
  // the Stripe billing period for paid).
  reviewsUsed: number;
  usagePeriodStart: number;
  // Legacy credits model — kept optional so old rows still load; no longer read.
  credits?: number;
  autoRefill?: boolean;
};

export type AuthAuditEntry = {
  id: string;
  userId: string;
  at: number;
  event:
    | "signin"
    | "signout"
    | "install"
    | "uninstall"
    | "2fa_enrolled"
    | "2fa_disabled";
  meta?: Record<string, unknown>;
};

// App-level notifications that feed the bell + popover in the dashboard.
// Mirrors the existing UI shape (kind drives dot color via NOTIF_DOT in
// frontend/src/app.tsx); `createdAt` is a number so the frontend can render
// relative time itself.
export type NotificationKind = "review" | "blocker" | "system";

export type Notification = {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  meta: string;
  link?: string;       // app path to navigate on click, e.g. "/reviews/{id}"
  reviewId?: string;   // FK back to a PRReview row for dedup / navigation
  createdAt: number;
  readAt: number | null;
};

// A status post on a Linear project, captured from ProjectUpdate webhooks.
// Stored per-update and pulled in as background context when synthesizing
// criteria for any issue belonging to that project.
export type LinearProjectUpdate = {
  id: string;            // Linear ProjectUpdate id
  projectId: string;
  projectName: string;
  body: string;
  health?: string;       // onTrack | atRisk | offTrack (Linear's health enum)
  userId?: string;       // owning DevAsign user (the connector)
  createdAt: number;
  updatedAt: number;
};

export type DB = {
  users: User[];
  installations: Installation[];
  repositories: Repository[];
  integrations: Integration[];
  tasks: Task[];
  prReviews: PRReview[];
  reviewLogs: ReviewLogEntry[];
  subscriptions: Subscription[];
  authAudit: AuthAuditEntry[];
  repoIndex: RepoIndexEntry[];
  notifications: Notification[];
  linearProjectUpdates: LinearProjectUpdate[];
};
