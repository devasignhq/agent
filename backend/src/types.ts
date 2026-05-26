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
  | "error";

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
};
