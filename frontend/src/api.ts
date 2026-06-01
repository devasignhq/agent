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
  plan: "free" | "pro" | "team";
  createdAt: number;
};

export type Subscription = {
  id: string;
  userId: string;
  plan: "free" | "pro" | "team";
  credits: number;
  autoRefill: boolean;
  stripeCustomerId: string | null;
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

export type IntegrationView = {
  id: string;
  type: IntegrationType;
  workspaceMeta: Record<string, string>;
  createdAt: number;
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

  // billing
  subscription: () => request<Subscription | null>("/api/billing/subscription"),
  addCredits: (add: number) =>
    request<{ ok: true }>("/api/billing/credits", {
      method: "POST",
      body: JSON.stringify({ add }),
    }),

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
