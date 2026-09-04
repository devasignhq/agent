// Typed API client for the DevAsign backend.
// In dev the frontend (Vite, :3001) talks to the backend (:8787) directly with
// credentials. localhost:3001 ↔ localhost:8787 is same-site (eTLD+1 = localhost),
// so the SameSite=Lax session cookie set on /api/auth/github/callback flows on
// XHR. Setting VITE_API_BASE to an EMPTY value instead selects relative URLs,
// which routes through the Vite dev proxy (see vite.config.ts).
//
// In prod there is deliberately no fallback origin. A hardcoded one can only
// ever encode a single deployment's API host, so the moment the API moves it
// silently aims every later build at a backend nobody owns — surfacing as a
// broken login rather than as the misconfiguration it is. VITE_API_BASE is
// required instead, and validated at build time in vite.config.ts, because Vite
// INLINES it into the bundle: once built, it cannot be corrected at runtime.

const RAW_API_BASE = (import.meta as any).env?.VITE_API_BASE as string | undefined;

if ((import.meta as any).env?.PROD && !RAW_API_BASE) {
  throw new Error(
    "VITE_API_BASE was not set when this bundle was built, so it has no API " +
      "origin. Set it in the deployment's environment variables and rebuild.",
  );
}

// Trailing slashes are stripped so `${API_BASE}/api/…` can't produce `//api/…`,
// which Express does not route. "" survives the strip and keeps its meaning:
// relative URLs, i.e. the dev proxy.
const API_BASE = (RAW_API_BASE ?? "http://localhost:8787").replace(/\/+$/, "");

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

// A transient failure is one where the request never got a real answer from the
// app: the server was momentarily unreachable (a deploy/restart/cold start on the
// API host drops the listening socket for a few seconds), the browser is offline,
// or an edge proxy returned a bare 502/503/504. These self-heal, so a plain
// read should ride over them rather than surface as an error. A `fetch` REJECTION
// is always network-level (our request() only ever throws ApiError for a real
// HTTP response), so anything that isn't an ApiError is transient by definition;
// on top of that, treat upstream 502/503/504 as transient too.
//
// NOTE: 503 `not_durable` is deliberately NOT lumped in here — it only rides on
// mutations, which never reach the retry path below, and its call sites inspect
// the 503 to keep optimistic state. isTransientApiError is for READ recovery.
// Raised when a `fetch` REJECTS — the request never got an HTTP answer (server
// unreachable during a deploy/restart/cold start, DNS failure, offline). We wrap
// the raw DOMException/TypeError so classification can key off THIS type rather
// than `instanceof Error`, which would also match a genuine programming bug
// (TypeError/ReferenceError from the render/fetch cycle) and silently swallow it.
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function isTransientApiError(err: unknown): boolean {
  if (err instanceof ApiError) {
    // not_durable rides ONLY on mutations and has dedicated optimistic handling
    // at its call sites — it is never a generic swallow-able read blip.
    if (err.status === 503 && err.message === "not_durable") return false;
    return RETRYABLE_STATUS.has(err.status);
  }
  // Only a real network failure is transient — not every stray runtime Error.
  return err instanceof NetworkError;
}

// Only idempotent reads are auto-retried. Retrying a mutation after a network
// failure is unsafe (it may have applied server-side before the socket dropped),
// so POST/PUT/PATCH/DELETE throw on the first failure exactly as before and their
// call sites decide what to do (e.g. the not_durable optimistic path).
const RETRY_SAFE_METHODS = new Set(["GET", "HEAD"]);
const MAX_ATTEMPTS = 3;
// Backoff between read retries. Kept short so a failed one-shot load still
// resolves quickly, but long enough to bridge a brief backend restart. Jitter
// avoids a thundering-herd retry when many tabs blip at the same instant.
function retryDelayMs(attempt: number): number {
  return Math.round(400 * Math.pow(2.5, attempt - 1) * (0.75 + Math.random() * 0.5));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const retryable = RETRY_SAFE_METHODS.has(method);
  let attempt = 0;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        credentials: "include",
        ...init,
        headers: {
          Accept: "application/json",
          "X-Devasign-Tab": tabId,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      });
    } catch (netErr) {
      // An aborted request (component unmounted, user navigated away) must NOT
      // be retried — that just delays the abort and leaks background traffic.
      // Propagate it untouched.
      const isAbort = netErr instanceof Error && netErr.name === "AbortError";
      // Server unreachable / offline. Retry idempotent reads a few times so a
      // few-second backend blip never reaches the caller; otherwise re-throw.
      if (retryable && !isAbort && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      if (isAbort) throw netErr;
      // Wrap so isTransientApiError can tell a real network failure apart from a
      // stray runtime Error.
      throw new NetworkError(netErr instanceof Error ? netErr.message : String(netErr));
    }
    const text = await res.text();
    const body = text ? safeParse(text) : null;
    if (!res.ok) {
      // A bare upstream 5xx on a read is the same class of transient blip — one
      // more chance before it becomes a real error to the caller.
      if (retryable && RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      const message =
        (body && typeof body === "object" && "error" in (body as any) && (body as any).error) ||
        `HTTP ${res.status}`;
      throw new ApiError(res.status, String(message), body);
    }
    return body as T;
  }
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
  // Which app minted this account. In the sponsor dashboard this is always
  // "maintainer" — the same GitHub identity has a separate "contributor" account
  // on the contributor app. Optional here so older payloads type-check.
  accountKind?: "maintainer" | "contributor";
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
  features: { privateRepos: boolean; linear: boolean; securityScans: boolean };
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
  // Repo-index state (backend RepoIndexState) — "none" until first indexed.
  indexState?: "none" | "queued" | "indexing" | "ready" | "stale" | "errored";
  indexedAt?: number;
  githubRepoId?: number;
  // Verifier state (backend RepoVerifyState) + the flake rate attached by
  // GET /api/repositories (last 30 runs; not persisted).
  verify?: {
    detected?: unknown;
    onboarding: { state: "none" | "pr_open" | "pr_closed" | "pr_merged" | "verified"; prNumber?: number; firstSuccessfulRunId?: string | null };
  };
  flakeRate?: { rate: number; flaky: number; total: number };
};

// Per-repo review workflow (mirror of backend/src/types.ts RepoWorkflow).
// `stages` is BASIC (free); `trigger`, `verdict`, `prompts` + `actions` are
// ADVANCED (Pro/Max).
export type StagePromptKey =
  | "criteria" | "review" | "holistic" | "security" | "defects" | "deferrals" | "docs" | "crossRepo";
export type RepoWorkflow = {
  version: 1;
  trigger: { onSynchronize: boolean; skipDrafts: boolean; skipBots: boolean };
  stages: { holistic: boolean; defects: boolean; docs: boolean; deferrals: boolean; crossRepo: boolean };
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
  evidenceCode?: { path: string; startLine: number; language: string | null; code: string } | null;
  suggestedChange?: unknown | null;
  // Verifier fields (mirror of backend/src/types.ts; absent = code, not implied).
  kind?: "code" | "ui" | "unverifiable";
  implied?: boolean;
  source?: { input: string; ref?: string; excerpt?: string };
  revision?: number;
  supersededBy?: string | null;
  notApplicable?: boolean;
};

// ---- verification (backend/src/verify/contract.ts RunView) ----
export type CriterionVerdict = {
  criterionId: string;
  verdict: "pass" | "fail" | "unverifiable";
  reason: string;
  evidenceRefs: Array<{ artifactId?: string; testId?: string; resultId?: string }>;
  flaky?: boolean;
  retired?: boolean;
};

export type RunViewArtifact = {
  id: string;
  kind: "video" | "trace" | "screenshot" | "log" | "test_file" | "poster";
  testId?: string;
  criterionIds: string[];
  bytes: number;
  state: "pending_upload" | "uploaded" | "expired";
  expiresAt: number;
  posterArtifactId?: string | null;
  path: string;
  attempt?: number;
  getUrl: string | null;
  posterUrl: string | null;
  urlExpiresAt: number | null;
};

export type RunView = {
  run: {
    id: string;
    status: string;
    sha: string;
    attempt: number;
    verdicts: CriterionVerdict[];
    error?: string | null;
    doctor?: { code: string; message: string } | null;
    timings: Record<string, unknown>;
    report?: { checkRunUrl?: string; commentUrl?: string };
    createdAt: number;
  };
  criteria: Criterion[];
  revision: number;
  plan: { id: string; tests: Array<{ id: string; path: string; criterionIds: string[]; level: string; origin: "existing" | "generated"; runner: string }>; unverifiable: Array<{ criterionId: string; reason: string; fixUrl?: string }> } | null;
  results: Array<{ id: string; testId: string; criterionIds: string[]; status: string; attempts: Array<{ n: number; status: string; durationMs: number; error?: string; artifactIds: string[] }>; durationMs: number; error?: string }> | null;
  artifacts: RunViewArtifact[];
  report: { checkRunUrl?: string; commentUrl?: string };
};

export type CriteriaRevision = {
  id: string;
  schemaVersion: 1;
  reviewId: string;
  revision: number;
  causedByCommentId: number | null;
  criteria: Criterion[];
  diff: Array<{ op: "add" | "remove" | "reword" | "not_applicable"; criterionId: string; before?: string; after?: string }>;
  createdAt: number;
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
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
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
  | "error"
  | "holistic"
  | "finding"
  | "verify";

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
  stellar?: "live" | "unconfigured";
};

// --- Bounties (mirror backend/src/types.ts) ---

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
  // "approved" is a legacy substatus (the old two-step handshake); the merged
  // delegate goes pending → accepted. The wallet is bound at apply time.
  status: "pending" | "approved" | "accepted" | "rejected";
  address?: string;
  memo?: string | null;
  trustline?: boolean;
};

// The contributor's timeline-extension request (backend types.ts). While
// status is "pending" the backend holds the deadline-expiry refund.
export type BountyExtension = {
  days: number;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  status: "pending" | "approved" | "declined";
  respondedBy?: string | null;
  respondedAt?: number | null;
};

export type Bounty = {
  id: string;
  seq: number;
  code: string;
  source: "github" | "linear";
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  description: string;
  // The acceptance contract. Editable only while PENDING_FUNDING; frozen once
  // the escrow is committed. Order is load-bearing — the backend seeds review
  // criteria from it positionally.
  acceptance: string[];
  // AI drafting state. Absent on rows written before drafting existed; treat
  // undefined as "ready".
  acceptanceState?: "generating" | "ready" | "errored";
  acceptanceEndGoal?: string | null;
  sponsorAddress?: string | null;
  taskId: string;
  amountUsdc: number;
  amountStroops: string;
  deliveryDays: number;
  status: BountyStatus;
  onchainStatus: "Open" | "Completed" | "Cancelled" | "Disputed" | null;
  applications: BountyApplication[];
  assigneeGithubLogin?: string | null;
  assigneeAddress?: string | null;
  acceptedAt?: number | null;
  deadlineAt?: number | null;
  prNumber?: number | null;
  extension?: BountyExtension | null;
  escrowTxHash?: string | null;
  payoutTxHash?: string | null;
  refundTxHash?: string | null;
  createdAt: number;
  updatedAt: number;
  // Signed Fund/Cancel links, present only on sponsor reads. fundingUrl is
  // minted while PENDING_FUNDING; cancelUrl also while OPEN (cancelling a
  // funded bounty refunds its escrow to the sponsor).
  fundingUrl?: string;
  cancelUrl?: string;
};

export type EscrowTransaction = {
  id: string;
  bountyId?: string | null;
  githubLogin?: string | null;
  kind: "escrow" | "payout" | "refund";
  signer: "sponsor" | "admin";
  status: "pending" | "confirmed" | "failed";
  hash?: string | null;
  amountStroops: string;
  dir: "in" | "out";
  note?: string;
  createdAt: number;
  confirmedAt?: number | null;
  // Payout destination snapshot: the exact wallet this payout was sent to, as
  // recorded when it was signed. The backend has always returned these (the
  // route serialises whole rows); they're declared here because the payout
  // invoice bills to them.
  destAddress?: string | null;
  destMemo?: string | null;
};

export type BountySummary = { total: number; active: number; inEscrow: number; paidOut: number };

// --- Security page (mirror of backend/src/types.ts + security/policy.ts) ---

export type SecuritySeverity = "critical" | "high" | "medium" | "low";
export type SecurityConfidence = "confirmed" | "probable" | "needs_human";
export type AttackSurface = "api" | "frontend" | "infra" | "deps" | "secrets";
export type SecurityFindingState =
  | "new"
  | "open"
  | "issue_created"
  | "bounty"
  | "fix_ready"
  | "resolved"
  | "accepted"
  | "false_positive"
  | "snoozed";

export type SecurityFindingEvent = {
  at: number;
  kind: string;
  detail: string;
  actor?: string;
};

export type SecurityFinding = {
  id: string;
  fingerprint: string;
  repoId: string;
  repo: string; // "owner/name", attached by the overview endpoint
  path: string;
  line?: number;
  symbol?: string;
  class: string;
  cwe?: string;
  surface: AttackSurface;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  title: string;
  concern: string;
  evidence?: string;
  dataflow?: { source: string; sink: string; steps: string[] };
  exploitNarrative?: string[];
  blastRadius?: string;
  invariant?: string;
  remediation?: string;
  regressionTest?: string;
  state: SecurityFindingState;
  stateReason?: string | null;
  rulingCode?: SecurityRulingCode | null;
  // Set when the audit muted this on a prior maintainer ruling instead of a
  // click — drives the "Suppressed by your rulings" section.
  suppressedByPrecedentId?: string | null;
  assigneeLogin?: string | null;
  issueNumber?: number | null;
  issueUrl?: string | null;
  bountyId?: string | null;
  snoozeUntil?: number | null;
  introducedByPr?: number | null;
  introducedSha?: string | null;
  introducedByAuthor?: string | null;
  firstDetectedAt: number;
  lastSeenAt: number;
  resolvedAt?: number | null;
  detectedSha: string;
  model: string;
  activity: SecurityFindingEvent[];
  // Live bounty on this finding's issue (joined by the overview endpoint).
  bounty: { id: string; code: string; status: string; amountUsdc: number } | null;
};

export type SecurityScanSummary = {
  id: string;
  repoId: string;
  trigger: "merge" | "manual" | "nightly";
  full: boolean;
  prNumber?: number | null;
  prTitle?: string | null;
  mergeSha?: string | null;
  prAuthor?: string | null;
  status: "queued" | "running" | "completed" | "errored";
  startedAt: number;
  finishedAt?: number | null;
  filesScanned: number;
  cacheHits: number;
  introduced: number;
  // Per-severity split of `introduced` (absent on runs written before the chart).
  introducedBySeverity?: Partial<Record<SecuritySeverity, number>>;
  resolved: number;
  stillOpen: number;
  // Set when the run completed without scanning anything (no install token,
  // plan-gated, index not built) — lets the chart say why a column is flat.
  skipped?: "no_install" | "plan_locked" | "index_not_built" | "repo_not_found";
  error?: string | null;
  costUsd?: number;
};

export type SecurityScanRun = SecurityScanSummary & {
  log: Array<{ at: number; line: string }>;
};

export type SeverityGateAction = "block" | "warn" | "track";
export type RepoSecurityPolicy = {
  version: 1;
  triggers: { onMerge: boolean; onPrPush: boolean; nightly: boolean; advisories: boolean };
  engines: { api: boolean; frontend: boolean; infra: boolean; secrets: boolean; deps: boolean };
  gates: Record<SecuritySeverity, SeverityGateAction>;
};

export type GateRule = {
  id: string;
  label: string;
  pass: boolean;
  required: boolean;
  count: number;
};
export type GateResult = { verdict: "pass" | "fail"; rules: GateRule[]; blockingFindingIds: string[] };

export type SecurityRepoView = {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  indexState: string;
  indexedAt: number | null;
  policy: RepoSecurityPolicy;
  gate: GateResult;
  latestScan: SecurityScanSummary | null;
};

// Result of a bulk re-scan. `skipped` carries the repos that already had a run
// in flight — not an error, just nothing new to queue for them.
export type SecurityScanBatch = {
  ok: true;
  queued: { repoId: string; scanRunId: string }[];
  skipped: { repoId: string; reason: "in_progress" }[];
};

export type SecurityRulingCode =
  | "control_exists"
  | "not_reachable"
  | "misread_code"
  | "out_of_scope"
  | "duplicate"
  | "by_design"
  | "compensating_control"
  | "accepted_cost";

// A maintainer ruling the audit agent carries into later scans.
export type SecurityPrecedent = {
  id: string;
  repoId: string;
  scope: "repo" | "account";
  code: SecurityRulingCode;
  action: "false_positive" | "accepted";
  note: string;
  class: string;
  path: string;
  symbol?: string;
  createdAt: number;
  createdBy: string;
  status: "active" | "needs_reconfirm" | "revoked";
  statusReason?: "code_changed" | "contradicted" | "revoked" | null;
  suppressedCount: number;
  lastAppliedAt?: number | null;
};

export type SecurityOverview = {
  repos: SecurityRepoView[];
  scans: SecurityScanSummary[];
  findings: SecurityFinding[];
  // Security audits are Pro/Max. Reads stay open on Free (and on a lapsed paid
  // sub) so existing findings remain visible; every mutation is refused.
  locked: boolean;
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

  // security (the dedicated Security page; findings come from the audit agent)
  securityOverview: () => request<SecurityOverview>("/api/security/overview"),
  securityScanLog: (repoId: string, scanId: string) =>
    request<{ scan: SecurityScanRun }>(`/api/repositories/${repoId}/security/scans/${scanId}`),
  // Re-scan for the Rescan picker. `repoIds: null` means every repo the app is
  // installed for. One request whatever the count, so a large install can't be
  // cut off half-way by the rate limiter the way a per-repo loop was.
  // (POST /api/repositories/:id/security/scan still exists server-side for a
  // single repo; nothing in the app needs it now that the picker sends a list.)
  startSecurityScans: (repoIds: string[] | null, full = true) =>
    request<SecurityScanBatch>("/api/security/scan", {
      method: "POST",
      body: JSON.stringify({ repoIds, full }),
    }),
  // One-click GitHub issue from a finding. Idempotent server-side.
  createFindingIssue: (repoId: string, findingId: string) =>
    request<{ ok: true; issueNumber: number; issueUrl: string }>(
      `/api/repositories/${repoId}/security/findings/${findingId}/issue`,
      { method: "POST", body: "{}" }
    ),
  patchFinding: (
    repoId: string,
    findingId: string,
    body: {
      action: "false_positive" | "accept" | "reopen";
      reason?: string;
      // Which kind of "false positive" this is. A teachable code plus a written
      // reason is what promotes the ruling into the agent's corpus.
      code?: SecurityRulingCode;
      scope?: "repo" | "account";
    }
  ) =>
    request<{ ok: true; finding: SecurityFinding; precedent: SecurityPrecedent | null }>(
      `/api/repositories/${repoId}/security/findings/${findingId}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  securityPrecedents: () =>
    request<{ precedents: SecurityPrecedent[]; locked: boolean }>("/api/security/precedents"),
  revokePrecedent: (id: string) =>
    request<{ ok: true; restored: number }>(`/api/security/precedents/${id}/revoke`, {
      method: "POST",
      body: "{}",
    }),
  setPrecedentScope: (id: string, scope: "repo" | "account") =>
    request<{ ok: true; precedent: SecurityPrecedent }>(`/api/security/precedents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ scope }),
    }),
  securityPolicy: (repoId: string) =>
    request<{ policy: RepoSecurityPolicy }>(`/api/repositories/${repoId}/security/policy`),
  setSecurityPolicy: (repoId: string, policy: RepoSecurityPolicy) =>
    request<{ ok: true; policy: RepoSecurityPolicy }>(
      `/api/repositories/${repoId}/security/policy`,
      { method: "PUT", body: JSON.stringify({ policy }) }
    ),

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
  // Verification: the latest (or a specific) verify run with signed evidence URLs.
  verifyRun: (reviewId: string, runId?: string) =>
    request<{ latest: RunView | null; runs: Array<{ id: string; sha: string; attempt: number; status: string; createdAt: number; verdicts: number }>; flakeRate: { rate: number; flaky: number; total: number } }>(
      `/api/reviews/${reviewId}/verify${runId ? `?run=${encodeURIComponent(runId)}` : ""}`
    ),
  criteriaRevisions: (reviewId: string) =>
    request<{ revisions: CriteriaRevision[]; repo: { owner: string; name: string }; prNumber: number }>(`/api/reviews/${reviewId}/criteria-revisions`),

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

  // bounties. Funding + in-app "Approve payment" are two-step: fetch an UNSIGNED
  // transaction (xdr), sign it with the sponsor's Freighter wallet client-side,
  // then post the signed envelope back to the matching *-submit endpoint.
  bounties: () =>
    request<{ bounties: Bounty[]; summary: BountySummary; explorerBase?: string }>("/api/bounties"),
  bounty: (id: string) => request<{ bounty: Bounty; explorerBase?: string }>(`/api/bounties/${id}`),
  bountyTransactions: () =>
    request<{ transactions: EscrowTransaction[]; explorerBase?: string }>("/api/bounties/transactions"),
  createBounty: (input: {
    repo: string;
    issueNumber: number;
    issueUrl: string;
    title: string;
    amountUsdc: number;
    deliveryDays: number;
    description?: string;
    acceptance?: string[];
  }) =>
    request<{ bounty: Bounty; fundingUrl: string }>("/api/bounties", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  // Funding (token from the Fund link). Returns the unsigned create_escrow xdr
  // plus the network passphrase it was built for (so Freighter signs against the
  // same network the backend submits to).
  bountyFundingTx: (id: string, token: string, address: string) =>
    request<{ xdr: string; networkPassphrase: string }>(
      `/api/bounties/${id}/funding-tx?token=${encodeURIComponent(token)}&address=${encodeURIComponent(address)}`
    ),
  submitBountyFunding: (id: string, token: string, signedXdr: string) =>
    request<{ ok: true; hash?: string; status: string }>(`/api/bounties/${id}/funding-submit`, {
      method: "POST",
      body: JSON.stringify({ token, signedXdr }),
    }),
  // Edit the acceptance list before funding. Session + sponsor only — NOT
  // token-scoped like the funding calls above, because that token rides in a
  // public GitHub comment and rewriting the contract must not be possible for
  // anyone who can read the issue. 409 `already_funded` once the escrow lands.
  setBountyAcceptance: (id: string, acceptance: string[]) =>
    request<{ bounty: Bounty }>(`/api/bounties/${id}/acceptance`, {
      method: "PATCH",
      body: JSON.stringify({ acceptance }),
    }),
  // Cancel (token from the Cancel link). outcome "cancelled" = plain discard
  // (nothing escrowed); "submitted" = refund tx broadcast (hash present);
  // "already_*" = idempotent replay.
  cancelBounty: (id: string, token: string) =>
    request<{ ok: true; outcome: string; hash?: string; bounty?: Bounty }>(`/api/bounties/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  // Applications + delegation. `approveApplication` now delegates outright
  // (accepts one application, rejects the rest, starts the delivery clock) —
  // contributors apply (and bind their wallet) in the separate contributor app.
  approveApplication: (id: string, githubId: number) =>
    request<{ ok: true; bounty: Bounty }>(`/api/bounties/${id}/applications/${githubId}/approve`, {
      method: "POST",
      body: "{}",
    }),
  rejectApplication: (id: string, githubId: number) =>
    request<{ ok: true; bounty: Bounty }>(`/api/bounties/${id}/applications/${githubId}/reject`, {
      method: "POST",
      body: "{}",
    }),
  // Timeline extension: approve moves the deadline; decline releases the
  // refund hold (the keeper refunds on its next tick if past due).
  approveExtension: (id: string) =>
    request<{ ok: true; bounty: Bounty }>(`/api/bounties/${id}/extension/approve`, {
      method: "POST",
      body: "{}",
    }),
  declineExtension: (id: string) =>
    request<{ ok: true; bounty: Bounty }>(`/api/bounties/${id}/extension/decline`, {
      method: "POST",
      body: "{}",
    }),
  // In-app "Approve payment" (sponsor Freighter-signs the release).
  bountyApproveTx: (id: string) =>
    request<{ xdr: string }>(`/api/bounties/${id}/approve-tx`, { method: "POST", body: "{}" }),
  submitBountyApprove: (id: string, signedXdr: string) =>
    request<{ ok: true; hash?: string; status: string }>(`/api/bounties/${id}/approve-submit`, {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    }),
  deleteBounty: (id: string) => request<{ ok: true }>(`/api/bounties/${id}`, { method: "DELETE" }),
};
