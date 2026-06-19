// Typed API client for the DevAsign backend.
// In dev the frontend (Vite, :3001) talks to the backend (:8787) directly with
// credentials. localhost:3001 ↔ localhost:8787 is same-site (eTLD+1 = localhost),
// so the SameSite=Lax session cookie set on /api/auth/github/callback flows on
// XHR. In prod the API is deployed at https://api.devasign.ai so it stays
// same-site with https://www.devasign.ai and the session cookie remains
// first-party. Set VITE_API_BASE to override; the PROD fallback below encodes
// that origin so a missing build-time env var can't silently ship localhost.

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE ??
  ((import.meta as any).env?.PROD ? "https://api.devasign.ai" : "http://localhost:8787");

export const apiBase = API_BASE;
export const oauthStartUrl = `${API_BASE}/api/auth/github`;
export const installRedirectUrl = `${API_BASE}/api/install/redirect`;
export const linearConnectUrl = `${API_BASE}/api/auth/linear`;

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "error" in (body as any) && (body as any).error) ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, String(message), body);
  }
  return body as T;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// --- Domain types (mirror backend/src/types.ts) ---

export type User = {
  id: string;
  githubId: number | null;
  githubLogin: string;
  email: string;
  avatarUrl?: string;
  plan: Plan;
  createdAt: number;
};

export type Plan = "free" | "pro" | "max";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

// Billing cadence. Annual carries a 20% discount (see backend billing/stripe.ts).
export type Interval = "month" | "year";

export type Subscription = {
  id: string;
  userId: string;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  interval?: Interval | null;
  pendingPlan: Plan | null;
  pendingInterval?: Interval | null;
  scheduleId: string | null;
  reviewsUsed: number;
  usagePeriodStart: number;
};

// Enriched shape returned by GET /api/billing/subscription.
export type SubscriptionView = {
  subscription: Subscription | null;
  effectivePlan: Plan;
  interval: Interval; // current sub's cadence (defaults to "month")
  annualAvailable: boolean; // whether the annual option is configured
  reviewsUsed: number;
  reviewLimit: number | null; // null = unlimited (Max)
  features: { privateRepos: boolean; linear: boolean };
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
  private: boolean;
  defaultModel: string;
  modelOverrides: Record<string, string>;
  reviewsEnabled: boolean;
  // Attached by GET /api/repositories for the Workflow rail cards (not persisted).
  reviewStats?: { total: number; approved: number; blocked: number };
};

// Per-repo review workflow (mirror of backend/src/types.ts RepoWorkflow).
// `stages` is BASIC (free); `trigger`, `verdict`, `prompts` + `actions` are
// ADVANCED (Pro/Max).
export type StagePromptKey = "criteria" | "review" | "holistic" | "deferrals" | "docs";
export type RepoWorkflow = {
  version: 1;
  trigger: { onSynchronize: boolean; skipDrafts: boolean; skipBots: boolean };
  stages: { holistic: boolean; docs: boolean; deferrals: boolean };
  verdict: { blocking: boolean };
  // Per-stage maintainer instructions (the stages that make an LLM call).
  prompts?: Partial<Record<StagePromptKey, string>>;
  // Optional "Run GitHub Action" step — dispatch a workflow after a review.
  actions?: { enabled: boolean; workflow: string; runWhen: "always" | "passed" };
};

// One GitHub Actions workflow, from GET /api/repositories/:id/actions/workflows.
export type ActionWorkflow = { id: number; name: string; file: string };

// GET /api/repositories/:id/workflow response.
export type RepoWorkflowView = {
  workflow: RepoWorkflow;
  advancedLocked: boolean; // true when the user's plan can't edit advanced fields
};

// Repo-scoped guidance materials attached on the Workflow "Ingest context" node
// (mirror of backend RepoGuidanceItem). Each is distilled once on add and then
// injected into every review on the repo. `status` drives the list UI.
export type RepoGuidanceItem = {
  id: string;
  kind: "video" | "doc" | "pdf";
  title: string;
  url?: string;
  status: "indexing" | "ready" | "errored";
  summary?: string;
  error?: string | null;
  addedAt: number;
  indexedAt?: number;
  addedBy?: string;
};

export type IntegrationType = "slack" | "linear" | "discord";

export type IntegrationView = {
  id: string;
  type: IntegrationType;
  workspaceMeta: Record<string, string>;
  createdAt: number;
};

export type LinearTeam = { id: string; name: string; key: string };
export type LinearTeamsView = {
  connected: boolean;
  workspace?: string;
  teams: LinearTeam[];
};

export type TaskAttachment = {
  id: string;
  kind: "loom" | "figma" | "image" | "pdf" | "link" | "text";
  url?: string;
  contentRef?: string;
  note?: string;
  createdAt?: number;
};

export type Task = {
  id: string;
  source: "github" | "linear" | "slack" | "discord";
  externalId: string;
  title: string;
  endGoal: string | null;
  attachments: TaskAttachment[];
  createdAt: number;
  // Linear ticket support (optional; mirror of backend/src/types.ts).
  criteria?: Criterion[];
  externalKey?: string | null;
  url?: string;
  userId?: string;
  updatedAt?: number;
  linkedLinearIssue?: { id: string; identifier: string; url: string } | null;
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
  // Criterion ids that an earlier commit met but a later commit broke. Lets the
  // timeline flag a "previously met, now broken" regression instead of just
  // "unmet" (mirror of backend/src/types.ts). Optional — absent on older rows.
  regressedCriteriaIds?: string[];
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

export type AuthAuditEntry = {
  id: string;
  userId: string;
  at: number;
  event: string;
  meta?: Record<string, unknown>;
};

export type NotificationKind = "review" | "blocker" | "system";

export type Notification = {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  meta: string;
  link?: string;
  reviewId?: string;
  createdAt: number;
  readAt: number | null;
};

export type Health = {
  ok: boolean;
  llm: "live" | "mock";
  githubApp: "configured" | "missing";
  githubAppName: string;
};

// --- Endpoints ---

export const api = {
  // identity
  me: () => request<{ user: User; subscription: Subscription | null }>("/api/me"),
  health: () => request<Health>("/api/health"),
  signOut: () =>
    request<{ ok: true }>("/api/auth/signout", { method: "POST", body: "{}" }),
  // Delete the account immediately and permanently. The backend cancels billing,
  // uninstalls the GitHub App, wipes every row, and clears the session cookie —
  // so the caller should sign out afterward. There is no restore window.
  deleteAccount: () =>
    request<{ ok: true }>("/api/me", { method: "DELETE" }),

  // installations & repos
  installations: () => request<Installation[]>("/api/installations"),
  // Fast variant: backend returns the DB snapshot immediately and runs the
  // GitHub reconcile in the background. Used by Settings → Installation for
  // instant first paint; the slower `installations()` call is fired right
  // after to pick up any rows the reconcile materialised.
  installationsFast: () => request<Installation[]>("/api/installations?fast=1"),
  linkInstallation: (installationId: number) =>
    request<{ ok: true }>(`/api/installations/${installationId}/link`, {
      method: "POST",
      body: "{}",
    }),
  repositories: () => request<Repository[]>("/api/repositories"),
  // Per-repo review workflow: read the effective config (+ whether advanced
  // controls are locked for this plan), and save it. The backend refuses
  // advanced (trigger/verdict) changes from free users with 403 upgrade_required.
  repoWorkflow: (id: string) =>
    request<RepoWorkflowView>(`/api/repositories/${id}/workflow`),
  setRepoWorkflow: (id: string, workflow: RepoWorkflow) =>
    request<{ ok: true; workflow: RepoWorkflow }>(`/api/repositories/${id}/workflow`, {
      method: "PUT",
      body: JSON.stringify({ workflow }),
    }),
  repoActionWorkflows: (id: string) =>
    request<{ workflows: ActionWorkflow[]; error?: string }>(
      `/api/repositories/${id}/actions/workflows`
    ),
  // Per-repo guidance materials on the "Ingest context" node. Adding a link or
  // PDF kicks off immediate indexing (item starts `status:"indexing"`); poll
  // repoGuidance() until items settle to ready/errored.
  repoGuidance: (id: string) =>
    request<{ items: RepoGuidanceItem[] }>(`/api/repositories/${id}/guidance`),
  addRepoGuidanceLink: (id: string, kind: "video" | "doc", url: string) =>
    request<{ ok: true; item: RepoGuidanceItem }>(`/api/repositories/${id}/guidance`, {
      method: "POST",
      body: JSON.stringify({ kind, url }),
    }),
  // Sent as a raw application/pdf body (the route reads req.body as a Buffer);
  // the filename rides on the query string.
  uploadRepoGuidancePdf: (id: string, file: File) =>
    request<{ ok: true; item: RepoGuidanceItem }>(
      `/api/repositories/${id}/guidance/pdf?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file, headers: { "Content-Type": "application/pdf" } }
    ),
  deleteRepoGuidance: (id: string, itemId: string) =>
    request<{ ok: true }>(`/api/repositories/${id}/guidance/${itemId}`, { method: "DELETE" }),

  // reviews
  reviews: (status?: PRReviewStatus) =>
    request<PRReview[]>(`/api/reviews${status ? `?status=${status}` : ""}`),
  review: (id: string) =>
    request<{ review: PRReview; logs: ReviewLogEntry[]; task: Task | null }>(
      `/api/reviews/${id}`
    ),
  rerunReview: (id: string) =>
    request<{ ok: true }>(`/api/reviews/${id}/rerun`, {
      method: "POST",
      body: "{}",
    }),
  syncReviews: () =>
    request<{ ok: true; discovered: number; enqueued: number; errors: Array<{ repo: string; message: string }> }>(
      `/api/reviews/sync`,
      { method: "POST", body: "{}" }
    ),

  // tasks
  task: (id: string) => request<Task>(`/api/tasks/${id}`),
  addAttachment: (
    taskId: string,
    att: { kind: TaskAttachment["kind"]; url?: string; note?: string }
  ) =>
    request<{ ok: true; attachment: TaskAttachment }>(
      `/api/tasks/${taskId}/attachments`,
      { method: "POST", body: JSON.stringify(att) }
    ),
  deleteAttachment: (taskId: string, attachmentId: string) =>
    request<{ ok: true; removed: TaskAttachment }>(
      `/api/tasks/${taskId}/attachments/${attachmentId}`,
      { method: "DELETE" }
    ),

  // integrations
  integrations: () => request<IntegrationView[]>("/api/integrations"),
  addIntegration: (input: {
    type: IntegrationType;
    tokens: Record<string, string>;
    workspaceMeta?: Record<string, string>;
  }) =>
    request<{ ok: true; id: string }>(`/api/integrations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeIntegration: (id: string) =>
    request<{ ok: true }>(`/api/integrations/${id}`, { method: "DELETE" }),
  linearTeams: () =>
    request<LinearTeamsView>("/api/integrations/linear/teams"),
  validateLinear: () =>
    request<{ connected: boolean }>("/api/integrations/linear/validate", { method: "POST" }),

  // billing
  subscription: () => request<SubscriptionView>("/api/billing/subscription"),
  checkout: (plan: "pro" | "max", interval: Interval = "month", opts?: { onboarding?: boolean }) =>
    request<{ url: string }>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan, interval, onboarding: Boolean(opts?.onboarding) }),
    }),
  portal: (opts?: { cancel?: boolean }) =>
    request<{ url: string }>("/api/billing/portal", {
      method: "POST",
      body: JSON.stringify(opts?.cancel ? { flow: "cancel" } : {}),
    }),
  changePlan: (plan: "pro" | "max", opts?: { interval?: Interval; immediate?: boolean }) =>
    request<{ ok: true }>("/api/billing/change-plan", {
      method: "POST",
      body: JSON.stringify({ plan, interval: opts?.interval ?? "month", immediate: Boolean(opts?.immediate) }),
    }),
  cancelScheduledChange: () =>
    request<{ ok: true }>("/api/billing/scheduled-change/cancel", { method: "POST", body: "{}" }),

  // audit
  audit: () => request<AuthAuditEntry[]>("/api/audit"),

  // notifications
  notifications: () =>
    request<{ items: Notification[]; unreadCount: number }>("/api/notifications"),
  markNotificationsRead: () =>
    request<{ ok: true; marked: number }>("/api/notifications/read", {
      method: "POST",
      body: "{}",
    }),
};
