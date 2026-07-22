// Typed API client for the DevAsign backend — contributor-app surface only.
// In dev the app (Vite, :3002) talks to the backend (:8787) directly with
// credentials. localhost:3002 ↔ localhost:8787 is same-site (eTLD+1 =
// localhost), so the SameSite=Lax session cookie set on
// /api/auth/github/callback flows on XHR. In prod the API is deployed at
// https://api.devasign.ai so it stays same-site with
// https://contributors.devasign.ai and the session cookie remains first-party.
// Set VITE_API_BASE to override; the PROD fallback below encodes that origin so
// a missing build-time env var can't silently ship localhost.

const API_BASE =
  (import.meta as any).env?.VITE_API_BASE ??
  ((import.meta as any).env?.PROD ? "https://api.devasign.ai" : "http://localhost:8787");

export const apiBase = API_BASE;

// A stable id for THIS browser tab, sent on every mutation and on the SSE stream
// URL. It lets the backend skip pushing a live-refresh frame back to the tab
// that caused the write — that tab already refetches explicitly, so the frame
// would only buy a second, redundant fetch. Every other tab, including this
// user's own, still gets it. Per-tab (not persisted) by design: a new tab is a
// new subscriber.
export const tabId: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// GitHub OAuth start URL for THIS app: `app=contributor` makes the backend
// redirect back to the contributor origin after the callback, and `returnTo`
// (a same-app path like "/bounties/:id?apply=1") lands the user exactly where
// they started — the discovery page auto-opens the apply modal on return.
export function oauthStartUrl(returnTo: string = "/"): string {
  const u = new URL(`${API_BASE}/api/auth/github`);
  u.searchParams.set("app", "contributor");
  u.searchParams.set("returnTo", returnTo);
  return u.toString();
}

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
      "X-Devasign-Tab": tabId,
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
  plan: "free" | "pro" | "max";
  createdAt: number;
  stellarPayoutAddress?: string;
  stellarPayoutMemo?: string;
  stellarPayoutTrustline?: boolean;
};

export type Subscription = Record<string, unknown>;

export type BountyStatus =
  | "PENDING_FUNDING"
  | "OPEN"
  | "DELEGATED"
  | "IN_REVIEW"
  | "PAID"
  | "CANCELLED";

export type BountyApplication = {
  githubId: number;
  githubLogin: string;
  note?: string;
  appliedAt: number;
  status: "pending" | "approved" | "accepted" | "rejected";
  // Payout wallet bound at apply time ("approved" is a legacy substatus).
  address?: string;
  memo?: string | null;
  trustline?: boolean;
};

export type SupportingLink = { type: string; url: string; addedAt: number };
export type SubmissionRejection = { reason: string; byLogin: string; at: number };

// One entry in the bounty's append-only activity log (mirrors backend
// BountyEvent; already filtered server-side to this contributor's view).
export type BountyEventKind =
  | "created" | "funding_submitted" | "funded" | "applied"
  | "application_approved" | "application_rejected" | "application_withdrawn"
  | "accepted" | "pr_opened" | "submitted" | "review_completed"
  | "payout_requested" | "extension_requested" | "extension_approved" | "extension_declined"
  | "submission_rejected" | "rejection_accepted"
  | "payout_submitted" | "paid" | "refund_submitted" | "refunded" | "cancelled";

export type BountyEvent = {
  at: number;
  kind: BountyEventKind;
  actor?: string | null;
  subject?: string | null;
  detail?: string | null;
};

// The (single) timeline-extension request on a bounty (backend types.ts
// BountyExtension). Only the assignee ever receives it — the projection nulls
// it for everyone else.
export type BountyExtension = {
  days: number;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  status: "pending" | "approved" | "declined";
  respondedBy?: string | null;
  respondedAt?: number | null;
};

// Compact AI-review projection carried on every contributor bounty row.
export type ReviewProjection = {
  prTitle: string;
  summary: string | null;
  counts: { met: number; unmet: number; pending: number; total: number };
};

// The unauthenticated discovery payload (backend bounties/public-view.ts).
export type PublicBounty = {
  id: string;
  code: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  description: string;
  acceptance: string[];
  amountUsdc: number;
  status: BountyStatus;
  deliveryDays: number;
  createdAt: number;
  applicantCount: number;
  escrow: { txHash: string | null; contractId: string | null; fundedAt: number | null };
};

// The contributor-scoped bounty view (backend routes/contributor.ts).
export type ContributorBounty = {
  id: string;
  code: string;
  source: "github" | "linear";
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  description: string;
  acceptance: string[];
  amountUsdc: number;
  deliveryDays: number;
  status: BountyStatus;
  createdAt: number;
  updatedAt: number;
  applicantCount: number;
  myApplication: BountyApplication | null;
  isAssignee: boolean;
  assigneeGithubLogin: string | null;
  assigneeAddress: string | null;
  assigneeMemo: string | null;
  acceptedAt: number | null;
  deadlineAt: number | null;
  prNumber: number | null;
  submittedAt: number | null;
  supportingLinks: SupportingLink[];
  payoutRequestedAt: number | null;
  rejection: SubmissionRejection | null;
  extension: BountyExtension | null;
  cancelReason: string | null;
  escrowTxHash: string | null;
  payoutTxHash: string | null;
  escrowContract: string | null;
  sponsorLogin: string | null;
  events: BountyEvent[];
  fundedAt: number | null;
  awardedAt: number | null;
  paidAt: number | null;
  refundedAt: number | null;
  review: ReviewProjection | null;
};

export type ContributorSummary = {
  active: number;
  applied: number;
  completed: number;
  inEscrowUsdc: number;
  lifetimeEarnedUsdc: number;
};

export type PayoutTransaction = {
  id: string;
  bountyId: string | null;
  code: string | null;
  title: string | null;
  repo: string | null;
  issueNumber: number | null;
  amountUsdc: number;
  status: "pending" | "confirmed" | "failed";
  hash: string | null;
  createdAt: number;
  confirmedAt: number | null;
  dest: { address: string | null; memo: string | null };
};

// Per-criterion AI review verdict (backend GET /api/bounties/:id/review).
export type ReviewCriterion = {
  n: number;
  text: string;
  status: "met" | "unmet" | "pending";
  finding: string | null;
};

export type BountyReview = {
  status: string;
  prTitle: string;
  summary: string | null;
  headSha: string;
  prNumber: number;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  updatedAt: number;
  counts: { met: number; unmet: number; pending: number; total: number };
  criteria: ReviewCriterion[];
  extraCriteria: ReviewCriterion[];
};

export type AppNotification = {
  id: string;
  kind: "review" | "blocker" | "system" | "bounty";
  title: string;
  meta: string;
  link?: string;
  createdAt: number;
  readAt: number | null;
};

// --- API surface ---

export const api = {
  // Session
  me: () => request<{ user: User; subscription: Subscription | null }>("/api/me"),
  signOut: () => request<{ ok: true }>("/api/auth/signout", { method: "POST" }),
  // Immediate, permanent purge of the account and all its data (server also
  // clears the session cookie).
  deleteAccount: () => request<{ ok: true }>("/api/me", { method: "DELETE" }),

  // Discovery (public + session reads)
  publicBounty: (id: string) =>
    request<{ bounty: PublicBounty; explorerBase: string }>(`/api/bounties/${id}/public`),
  bounty: (id: string) =>
    request<{ bounty: { id: string; status: BountyStatus; applications: BountyApplication[] } }>(
      `/api/bounties/${id}`
    ),

  // Apply — the payout wallet is bound to the application here (there is no
  // longer a separate accept step; the sponsor's delegate starts the clock).
  applyToBounty: (id: string, address: string, memo: string, note?: string) =>
    request<{ ok: true }>(`/api/bounties/${id}/apply`, {
      method: "POST",
      body: JSON.stringify({ address, memo, ...(note ? { note } : {}) }),
    }),

  // My bounties + workspace actions
  contributorBounties: () =>
    request<{ bounties: ContributorBounty[]; summary: ContributorSummary; explorerBase: string }>(
      "/api/contributor/bounties"
    ),
  withdrawApplication: (id: string) =>
    request<{ ok: true; bounty?: unknown }>(`/api/bounties/${id}/withdraw-application`, {
      method: "POST",
    }),
  submitWork: (id: string, prUrl: string, links: Array<{ type: string; url: string }>) =>
    request<{ ok: true; bounty: unknown }>(`/api/bounties/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ prUrl, links }),
    }),
  updateLinks: (id: string, links: Array<{ type: string; url: string }>) =>
    request<{ ok: true; bounty: unknown }>(`/api/bounties/${id}/links`, {
      method: "POST",
      body: JSON.stringify({ links }),
    }),
  requestPayout: (id: string) =>
    request<{ ok: true; bounty: unknown }>(`/api/bounties/${id}/request-payout`, {
      method: "POST",
    }),
  requestExtension: (id: string, days: number, reason: string) =>
    request<{ ok: true; bounty: unknown }>(`/api/bounties/${id}/request-extension`, {
      method: "POST",
      body: JSON.stringify({ days, reason }),
    }),
  acceptRejection: (id: string) =>
    request<{ ok: true; bounty: unknown }>(`/api/bounties/${id}/accept-rejection`, {
      method: "POST",
    }),
  bountyReview: (id: string) => request<{ review: BountyReview }>(`/api/bounties/${id}/review`),

  // Wallet
  setPayoutWallet: (address: string, memo: string) =>
    request<{ ok: true; address: string; memo: string; trustline: boolean }>(
      "/api/me/payout-address",
      { method: "POST", body: JSON.stringify({ address, memo }) }
    ),
  removePayoutWallet: () =>
    request<{ ok: true }>("/api/me/payout-address", { method: "DELETE" }),
  contributorTransactions: () =>
    request<{ transactions: PayoutTransaction[]; explorerBase: string }>(
      "/api/contributor/transactions"
    ),

  // Notifications
  notifications: () =>
    request<{ items: AppNotification[]; unreadCount: number }>("/api/notifications"),
  markNotificationsRead: () => request<{ ok: true }>("/api/notifications/read", { method: "POST" }),
};
