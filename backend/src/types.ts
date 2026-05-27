// Domain types mirror the Firestore sketch in devasign.md §3.

export type User = {
  id: string;
  githubId: number | null;
  githubLogin: string;
  email: string;
  avatarUrl?: string;
  plan: "free" | "pro" | "team";
  createdAt: number;
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
};

export type TaskAttachment = {
  kind: "loom" | "figma" | "image" | "pdf" | "link" | "text";
  url?: string;
  contentRef?: string; // Cloud Storage path
  note?: string;
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
  | "holistic";

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

export type Subscription = {
  id: string;
  userId: string;
  plan: "free" | "pro" | "team";
  credits: number;
  autoRefill: boolean;
  stripeCustomerId: string | null;
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
};
