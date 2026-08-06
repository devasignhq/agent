// Domain types mirror the Firestore sketch in devasign.md §3.

export type User = {
  id: string;
  githubId: number | null;
  githubLogin: string;
  email: string;
  avatarUrl?: string;
  plan: "free" | "pro" | "max";
  createdAt: number;
  // Which app minted this account. The SAME GitHub identity yields TWO separate
  // `users` rows (distinct ids): a "maintainer" account for the sponsor dashboard
  // (installs, billing, sponsored bounties) and a "contributor" account for the
  // contributor app (applies to bounties, owns the payout wallet). OAuth keys
  // find-or-create on (githubId, accountKind); the session cookie is chosen per
  // app so each side resolves its own account. Optional so legacy rows load
  // unchanged — a missing value is treated as "maintainer" (see accountKindOf in
  // users.ts and the boot backfill that stamps existing rows by installation).
  accountKind?: "maintainer" | "contributor";
  // Bounty payout wallet. A contributor authenticates with GitHub, then MANUALLY
  // enters the Stellar address (G…) their bounty payouts should go to — so their
  // GitHub identity is linked to the receiving address at all times. Optional so
  // existing rows load unchanged; only set once a user registers a payout wallet.
  // `stellarPayoutTrustline` caches whether that address had a USDC trustline when
  // last checked (a payout to a trustline-less account would trap on-chain).
  stellarPayoutAddress?: string;
  stellarPayoutTrustline?: boolean;
  // Optional memo attached to the payout wallet (e.g. an exchange deposit memo).
  // MEMO_TEXT semantics: ≤ 28 bytes UTF-8 (see stellar/memo.ts). Cleared together
  // with the address when the contributor removes their wallet.
  stellarPayoutMemo?: string;
};

export type Installation = {
  id: string;
  // The original installer / primary owner. Kept for back-compat and to identify
  // who first set the App up (drives the "shared org install" banner). May be ""
  // when the install webhook landed before the installer signed in.
  userId: string;
  // All DevAsign users linked to this installation: the personal owner, or the
  // org owners/admins who adopted it at signup, plus anyone who explicitly linked
  // it. Optional so rows written before this existed still load — read via
  // installMembers() (github/installations.ts), which falls back to [userId].
  userIds?: string[];
  accountId: number;
  accountLogin: string;
  // GitHub account kind behind the install. Drives org-only logic (owner-adoption,
  // the shared-install banner). Optional/backfilled lazily on reconcile/link.
  accountType?: "User" | "Organization";
  installationId: number;
  repoIds: number[];
};

// Per-repo review workflow: which optional pipeline stages run, the entry
// trigger policy, and verdict behavior. Surfaced + edited on the frontend
// "Workflow" screen, enforced by the review pipeline (stages/verdict) and the
// PR webhook (trigger). Optional on Repository so existing rows load unchanged;
// effectiveWorkflow() (review/workflow.ts) merges this over defaults that
// reproduce DevAsign's pre-workflow behavior.
//
// Tiering: `stages` (which stages run) is BASIC (free). `trigger`, `verdict`
// (policy + automation) and `prompts` (per-stage agent steering) are ADVANCED
// (Pro/Max).
export type RepoWorkflow = {
  version: 1;
  trigger: {
    onSynchronize: boolean; // re-review when new commits are pushed to a PR
    skipDrafts: boolean;    // ignore draft PRs (still reviews on ready_for_review)
    skipBots: boolean;      // ignore bot-authored PRs (Dependabot/Renovate/etc)
  };
  stages: {
    holistic: boolean;  // whole-repo review against the index
    defects: boolean;   // general correctness/robustness bug hunt on the diff
    docs: boolean;      // DEVASIGN.md conventions + doc-drift check
    deferrals: boolean; // self-admitted deferred/incomplete-work scan
  };
  verdict: {
    blocking: boolean; // false = post advisory COMMENT, never REQUEST_CHANGES
  };
  // Optional maintainer instructions appended to a stage's system prompt, for
  // the stages that make an LLM call. Keyed by stage id; empty/absent = none.
  prompts?: {
    criteria?: string;  // criteria synthesis
    review?: string;    // diff vs. criteria review
    holistic?: string;  // whole-repo review
    security?: string;  // focused security backstop (falls back to `holistic` when absent)
    defects?: string;   // general defect review
    deferrals?: string; // deferred-work scan
    docs?: string;      // DEVASIGN.md guidance
  };
  // Optional "Run GitHub Action" step (ADVANCED): when enabled, dispatch a
  // chosen GitHub Actions workflow after a review. `runWhen` gates dispatch on
  // the verdict. Off by default — needs the App's actions:read/write scopes.
  actions?: {
    enabled: boolean;
    workflow: string;            // workflow file name (e.g. "deploy.yml") or numeric id
    runWhen: "always" | "passed"; // dispatch on every review, or only when it passes
  };
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
  // Per-repo review workflow (optional; defaults applied by effectiveWorkflow).
  workflow?: RepoWorkflow;
  // Per-repo review counts, attached by GET /api/repositories for the rail
  // cards (not persisted). approved = "passed", blocked = "changes_requested".
  reviewStats?: { total: number; approved: number; blocked: number };
  // Repo-index state. Optional so DB rows written before the indexer existed
  // still load — treat undefined as "none" at every branch site.
  indexState?: RepoIndexState;
  indexedAt?: number;
  indexedCommit?: string;
  indexedFileCount?: number;
  indexError?: string | null;
  // Maintainer-attached, repo-scoped guidance materials (videos, doc links,
  // PDFs). Each is distilled to text once on add (see review/guidance.ts) and
  // injected as authoritative guidance into every review on this repo. Optional
  // so rows written before this feature load unchanged; treat undefined as [].
  guidance?: RepoGuidanceItem[];
  // Per-repo security audit policy (triggers/engines/severity gates). Optional;
  // read through effectiveSecurityPolicy() which merges defaults.
  securityPolicy?: RepoSecurityPolicy;
}

// A repo-scoped guidance material attached on the Workflow "Ingest context"
// node. `summary` is the distilled, checkable review guidelines extracted from
// the material once at add-time — we never persist raw PDF bytes (no object
// storage). Mirrors the indexer's "summarize, don't embed" approach.
export type RepoGuidanceItem = {
  id: string;
  kind: "video" | "doc" | "pdf";
  title: string;                 // filename (PDF) or URL host / page title (link)
  url?: string;                  // video & doc links (absent for PDFs)
  status: "indexing" | "ready" | "errored";
  summary?: string;              // distilled guidance text injected into reviews
  error?: string | null;
  addedAt: number;
  indexedAt?: number;
  addedBy?: string;              // githubLogin, for display
};

export type RepoIndexState =
  | "none"      // never indexed (legacy / pre-migration rows)
  | "queued"    // build job sitting on the index queue
  | "indexing"  // worker is actively walking the tree
  | "ready"     // index is up-to-date as of indexedAt
  | "stale"     // PR merged; awaiting incremental refresh
  | "errored";

// A security vulnerability found in a single indexed file by the index-time
// security sub-pass (indexer.ts). Stored on the file's RepoIndexEntry so it
// inherits the sha-keyed cache: an unchanged blob keeps its findings and isn't
// re-scanned. Aggregated read-only by GET /repositories/:id/security and
// surfaced (advisory) in PR reviews when a PR touches or depends on the file.
export type VulnerabilitySeverity = "blocker" | "warn";

export type Vulnerability = {
  id: string;
  class: string;             // taxonomy tag: "sql-injection", "xss", "ssrf", ...
  severity: VulnerabilitySeverity;
  path: string;              // file the vuln lives in (== entry.path)
  symbol?: string;           // function/class the vuln is in, when known
  line?: number;             // 1-based line, when the model localizes it
  concern: string;           // what the vulnerability is and why it's exploitable
  fixPrompt: string;         // copy-pasteable remediation prompt for an AI agent
  detectedSha: string;       // blob sha the finding was detected on
  detectedAt: number;
  model: string;             // model that produced the finding
};

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
  // Vulnerabilities found by the index-time security sub-pass. Only populated
  // for files whose securityFlags are non-empty (the scan gate). Inherits the
  // sha cache: unchanged blobs keep these and skip re-scanning. Absent on rows
  // indexed before the security pass existed (backfilled on next re-index).
  vulnerabilities?: Vulnerability[];
  // Blob sha the security sub-pass last evaluated. Distinct from `sha` so a
  // legacy row (or a flagged file not yet scanned at this sha) is recognized as
  // owing a scan even on a summary cache hit. Absent until first scanned.
  securityScannedSha?: string;
  // Which engine wrote securityScannedSha. The pre-audit-agent indexer stamped
  // securityScannedSha on EVERY file it indexed, scanned or not, so that stamp
  // alone can't be trusted as "the audit agent has seen this blob" — an absent
  // securityEngine means exactly that, and the file is owed one audit.
  securityEngine?: string;
  indexedAt: number;
  model: string;             // model that produced this entry
};

// ── Security audit (dedicated agent, backend/src/security/) ─────────────────
// First-class findings produced by the security audit agent that runs on every
// merge to the default branch (and on manual/nightly triggers). Unlike the
// legacy index-embedded Vulnerability rows, these are keyed by a stable
// fingerprint so triage state (issue links, accepted-risk, assignee) survives
// re-scans. The indexer's security sub-pass is superseded by this agent.

export type SecuritySeverity = "critical" | "high" | "medium" | "low";

// Confidence per the audit contract: "confirmed" = the agent verified the
// control is absent; "probable" = strong evidence but unverified assumptions;
// "needs_human" = depends on something outside the repo (WAF, IaC, ops).
export type SecurityConfidence = "confirmed" | "probable" | "needs_human";

export type AttackSurface = "api" | "frontend" | "infra" | "deps" | "secrets";

export type SecurityFindingState =
  | "new"            // fresh from the latest completed scan run
  | "open"           // carried over from an earlier run
  | "issue_created"  // a GitHub issue was filed from the finding
  | "bounty"         // a bounty exists on that issue
  | "fix_ready"      // a PR-review re-verify saw the fix on an open PR head
  | "resolved"       // no longer detected (or its fix merged)
  | "accepted"       // accepted risk — suppressed, kept by fingerprint
  | "false_positive" // suppressed, kept by fingerprint so it can't come back
  | "snoozed";

// Why a human suppressed a finding. "False positive" and "accept risk" are one
// button each in the UI, but a maintainer clicks them for very different
// reasons, and only some of those reasons are a lesson the agent can learn.
// Splitting them at the point of the click is what keeps the precedent corpus
// from degenerating into "the agent was trained to stay quiet".
export type SecurityRulingCode =
  // false-positive family — the agent got it wrong
  | "control_exists"        // the control is applied elsewhere (middleware, wrapper, layer)
  | "not_reachable"         // real sink, but no untrusted input can reach it
  | "misread_code"          // the claim is factually untrue about this code
  | "out_of_scope"          // vendored / generated / sample / fixture code
  | "duplicate"             // already tracked by another finding
  // accepted-risk family — the agent is right, the team is living with it
  | "by_design"             // intentional and reviewed
  | "compensating_control"  // mitigated outside the code (WAF, network, IaC, process)
  | "accepted_cost";        // real, consciously not fixed now

export type SecurityFindingEvent = {
  at: number;
  kind:
    | "detected"
    | "redetected"
    | "state_change"
    | "issue_created"
    | "assigned"
    | "resolved"
    | "reopened";
  detail: string;
  actor?: string; // github login, or "audit-agent" for machine transitions
};

export type SecurityFinding = {
  id: string;
  // Stable across runs: hash of repoId|path|class|symbol-or-slug. Line numbers
  // and prose wording are deliberately excluded so re-detections match.
  fingerprint: string;
  repoId: string;
  path: string;
  line?: number;             // updated on each re-detection; NOT in fingerprint
  symbol?: string;
  class: string;             // taxonomy tag: "sql-injection", "missing-authz", ...
  cwe?: string;              // "CWE-89" when the model maps one
  surface: AttackSurface;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  title: string;             // one line, specific
  concern: string;           // what it is and why it's exploitable
  evidence?: string;         // quoted file:line evidence the model actually read
  dataflow?: { source: string; sink: string; steps: string[] };
  exploitNarrative?: string[]; // exactly 3 concrete attacker steps
  blastRadius?: string;      // one sentence: what an attacker gets
  invariant?: string;        // the rule that should hold
  remediation?: string;      // copy-pasteable fix prompt (successor of fixPrompt)
  regressionTest?: string;   // a test that fails today, passes after the fix
  state: SecurityFindingState;
  stateReason?: string | null; // note on accepted / false_positive / snoozed
  rulingCode?: SecurityRulingCode | null;   // why a human suppressed it, when they said
  // Set when the audit auto-suppressed this on a maintainer's prior ruling
  // rather than on a click. Drives the "Suppressed by your rulings" ledger and
  // lets a revoke find everything it muted.
  suppressedByPrecedentId?: string | null;
  assigneeLogin?: string | null;
  issueNumber?: number | null;
  issueUrl?: string | null;
  bountyId?: string | null;
  snoozeUntil?: number | null;
  // Origin attribution: the merged PR whose scan first surfaced the finding.
  introducedByPr?: number | null;
  introducedSha?: string | null;
  introducedByAuthor?: string | null;
  firstDetectedAt: number;
  lastSeenAt: number;
  resolvedAt?: number | null;
  detectedSha: string;       // blob sha last detected on
  model: string;
  activity: SecurityFindingEvent[]; // capped at 50, newest last
};

// A maintainer's ruling, promoted to something the auditor carries forward.
// Only the teachable ruling codes ever reach this table, and only with a
// rationale attached — a lesson with no reasoning is not a lesson.
//
// Two channels, deliberately separated (see security/precedent.ts):
//   - repo-scoped rulings ALSO auto-suppress a tight re-match in that repo;
//   - account-scoped rulings only condition the scan prompt, never auto-hide.
// We hard-mute solely in the repo where the maintainer actually looked.
export type SecurityPrecedent = {
  id: string;
  // A ruling belongs to the INSTALLATION, not to whoever happened to type it.
  // Any co-maintainer on an install triages the same findings, and the audit
  // runs under the primary owner — key this on a person and a team member's
  // rulings are invisible to the scan that should honour them, and to the
  // ledger that should let anyone withdraw them.
  installationId: string;
  ownerUserId: string;         // who authored it — provenance, not access control
  repoId: string;              // the repo the ruling was made in
  scope: "repo" | "account";   // "account" is an explicit opt-in promotion
  code: SecurityRulingCode;
  action: "false_positive" | "accepted"; // the state a tight match should apply
  note: string;                // the maintainer's rationale — the actual lesson
  // Match key. Looser than a fingerprint on purpose: no repoId (so an account
  // ruling can travel) and no line numbers or prose (both drift between runs).
  class: string;
  slug: string;
  path: string;
  symbol?: string;
  // Expiry anchors. A ruling is only as true as the code it was made against,
  // so we keep enough to notice when that code moves out from under it.
  originFindingId: string;
  anchorSha: string;           // blob sha the file had when the ruling was made
  anchorEvidence?: string;     // the evidence line the agent had quoted
  engineAtCreation: string;    // SECURITY_ENGINE, for revalidation on a bump
  createdAt: number;
  createdBy: string;           // github login
  // "needs_reconfirm" still informs the prompt but stops auto-suppressing: the
  // ground truth shifted, so the ruling needs a human to look again.
  status: "active" | "needs_reconfirm" | "revoked";
  statusReason?: "code_changed" | "contradicted" | "revoked" | null;
  suppressedCount: number;     // how many findings it has muted — the health metric
  lastAppliedAt?: number | null;
  revokedAt?: number | null;
  revokedBy?: string | null;
};

export type SecurityScanTrigger = "merge" | "manual" | "nightly";
export type SecurityScanStatus = "queued" | "running" | "completed" | "errored";
// Machine-readable reason a run was a no-op — the log line's counterpart.
export type SecurityScanSkipReason =
  | "no_install"       // dev / unattached repo: no token to fetch blobs with
  | "plan_locked"      // owner isn't on Pro/Max
  | "index_not_built"  // repo index empty — nothing to scan, nothing to resolve
  | "repo_not_found";

export type SecurityScanRun = {
  id: string;
  repoId: string;
  trigger: SecurityScanTrigger;
  full: boolean;
  // Merge-trigger metadata (the PR whose merge caused this run).
  prNumber?: number | null;
  prTitle?: string | null;
  mergeSha?: string | null;
  prAuthor?: string | null;
  status: SecurityScanStatus;
  startedAt: number;
  finishedAt?: number | null;
  filesScanned: number;
  cacheHits: number;
  introduced: number;        // findings created by this run
  // Per-severity split of `introduced`, so the dashboard's introduced-vs-
  // resolved chart can stack a run's bar by severity without re-deriving it
  // from findings (whose severity is re-assessed on later runs). Absent on
  // rows written before the chart existed — treat as "unknown split".
  introducedBySeverity?: Partial<Record<SecuritySeverity, number>>;
  resolved: number;          // findings auto-resolved by this run
  stillOpen: number;         // active findings after the run
  // Why this run completed without scanning anything. Set on the no-op early
  // returns so the dashboard chart can render "skipped" distinctly from a run
  // that scanned and legitimately found no change.
  skipped?: SecurityScanSkipReason;
  error?: string | null;
  costUsd?: number;
  log: Array<{ at: number; line: string }>; // terminal log, capped at 300 lines
};

export type SeverityGateAction = "block" | "warn" | "track";

export type RepoSecurityPolicy = {
  version: 1;
  triggers: {
    onMerge: boolean;   // audit on every merge to the default branch
    onPrPush: boolean;  // publish the security check-run on PR reviews
    nightly: boolean;   // daily cache-driven sweep
    advisories: boolean; // reserved: dependency advisory feed
  };
  engines: {
    api: boolean;
    frontend: boolean;
    infra: boolean;
    secrets: boolean;
    deps: boolean;
  };
  gates: Record<SecuritySeverity, SeverityGateAction>;
};

// Snapshot of security findings the review pipeline attributed to a PR's head,
// persisted on the PRReview row so the merge-gate view can list PR-introduced
// findings without re-parsing review logs.
export type PRSecurityFinding = {
  path?: string;
  concern: string;
  severity: SecuritySeverity;
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

// A concrete code replacement attached to a finding or an unmet criterion.
// `original` is the verbatim current text starting at `startLine` (new-file
// coordinates); `suggested` is the drop-in replacement. Rendered as a
// before/after diff in the GitHub comment. Additive to stored jsonb — rows
// written before this existed simply lack the field.
export type SuggestedChange = {
  path: string;
  startLine: number;
  original: string;
  suggested: string;
};

// The decisive code excerpt backing a criterion verdict. `startLine` is the
// 1-based line in the NEW version of `path`; `language` is a lowercase
// syntax-highlighting id ("typescript", "python", …) or null when unknown.
export type EvidenceCode = {
  path: string;
  startLine: number;
  language: string | null;
  code: string;
};

export type Criterion = {
  id: string;
  text: string;
  met: boolean | null;
  evidence: string | null;
  // Optional structured evidence/fix (additive — absent on legacy rows).
  // evidenceCode backs any verdict tied to specific code; suggestedChange is
  // attached to UNMET criteria and cleared whenever a dispute flips `met`.
  evidenceCode?: EvidenceCode | null;
  suggestedChange?: SuggestedChange | null;
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
  // GitHub issue-comment id for the "review in progress" → verdict comment, and
  // the head SHA it was posted for. One comment per commit: a rerun on the SAME
  // sha edits this comment back through in-progress → verdict, while a new sha
  // (push) gets a fresh comment. Optional so rows written before this existed
  // still load.
  progressCommentId?: number | null;
  progressCommentSha?: string | null;
  // Id of our latest bodyless APPROVE review on this PR. We never submit
  // REQUEST_CHANGES (its required body would render as an extra conversation
  // comment), so when a later commit fails we explicitly dismiss this approval
  // instead. Cleared after dismissal.
  approveReviewId?: number | null;
  // Criterion ids that were met by an earlier commit but came back not-met after
  // a code change in this PR — genuine regressions. Drives the "previously met,
  // now broken" callout in the GitHub comment and the in-app timeline. Empty/
  // absent on a clean run.
  regressedCriteriaIds?: string[];
  // Head SHA the last COMPLETED review evaluated. Stamped at the end of a
  // successful run; on the next push it's the base for the incremental delta
  // (compare(lastReviewedSha...headSha)) that the new-commit intent review
  // reads. Absent on a first review / legacy rows, in which case the new-commit
  // stage is skipped and the run proceeds cumulatively as before.
  lastReviewedSha?: string | null;
  // The single DevAsign user this review's monthly quota counts against — the PR
  // author for auto-reviews, or the member who commented to trigger it. Resolved
  // via attributedUserFor() (github/installations.ts). Optional/null on rows
  // written before per-user attribution, and when no member could be attributed.
  attributedUserId?: string | null;
  // The bounty this PR delivers, when the review's criteria were seeded from a
  // bounty's locked acceptance list (see review/pipeline.ts stage b). Lets the
  // contributor-facing verdict endpoint pick the right review row and lets the
  // pipeline notify the bounty assignee when verdicts land. Absent on ordinary
  // (non-bounty) reviews and rows written before bounties existed.
  bountyId?: string | null;
  // Security findings this review attributed to the PR head (introduced by the
  // diff, not pre-existing). Stamped when the verdict lands; read by the merge
  // gate's "no open PR introduces a block-gated finding" rule. Absent on rows
  // written before the Security page existed.
  securityFindings?: PRSecurityFinding[];
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
export type NotificationKind = "review" | "blocker" | "system" | "bounty";

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

// ── Bounties (Soroban USDC escrow) ──────────────────────────────────────────
// A bounty attached to a GitHub issue (or Linear ticket). Funds live in the
// on-chain escrow contract, NOT with DevAsign — `sponsorAddress` (the funder's
// Freighter wallet) is the on-chain `creator`. The app status is the source of
// truth for the workflow; `onchainStatus` mirrors the contract's TaskStatus.
export type BountySource = "github" | "linear";

export type BountyStatus =
  | "PENDING_FUNDING" // created from a comment; awaiting the sponsor's Freighter funding signature
  | "OPEN" // funded + HELD in escrow; awaiting applications
  | "DELEGATED" // an approved contributor accepted (gave a payout address); delivery clock running
  | "IN_REVIEW" // the contributor opened a PR referencing the issue
  | "PAID" // escrow released to the contributor
  | "CANCELLED"; // refunded to the sponsor (deleted while undelegated, or deadline expired)

// Mirrors the contract's on-chain TaskStatus (Open → Completed | Disputed;
// Open → Cancelled). Null until the escrow is funded on-chain.
// "Disputed" is kept for fidelity with the contract enum — the contract really
// can hold an escrow there via dispute_task — but the app never models disputes
// and no code path writes it: adoptOnchainEscrow reads only `creator` and
// hardcodes "Open", and every other write is a literal from a tx confirmation.
export type OnchainStatus = "Open" | "Completed" | "Cancelled" | "Disputed";

export type BountyCancelReason = "deleted" | "expired" | "rejected";

// A supporting link the contributor attached to their submission (demo video,
// design doc, screen recording, …) — free-form type label + URL, sanitized by
// bounties/submission.ts before it's stored.
export type SupportingLink = { type: string; url: string; addedAt: number };

// A sponsor's rejection of the submitted work. The bounty STAYS IN_REVIEW —
// rejection is a flag on the review stage, not a status: the contributor can
// rework and resubmit, or accept the verdict (→ refund).
export type SubmissionRejection = { reason: string; byLogin: string; at: number };

// The contributor's request for more delivery time. A single subdocument, not a
// list: the invariants are "at most one pending at a time" and "at most one
// approved ever", so one field makes both checks trivial (including inside the
// keeper's expiredBounties predicate, which must stay cheap). A declined request
// is overwritten by the next one — the history lives in the events log. While
// status is "pending" the deadline sweeper HOLDS the expiry refund.
export type BountyExtension = {
  days: number; // integer, 1..EXTENSION_MAX_DAYS
  reason: string; // required; trimmed and capped at EXTENSION_REASON_MAX
  requestedBy: string; // assignee githubLogin at request time
  requestedAt: number;
  status: "pending" | "approved" | "declined";
  respondedBy?: string | null; // sponsor githubLogin
  respondedAt?: number | null;
};

// One entry in a bounty's append-only activity log — every lifecycle moment
// the contributor app's timeline renders. Written by recordBountyEvent()
// (bounties/service.ts) at each transition; absent entirely on legacy rows
// (the frontend synthesizes a coarse timeline from timestamps as a fallback).
export type BountyEventKind =
  | "created"
  | "criteria_drafted"
  | "criteria_edited"
  | "funding_submitted"
  | "funded"
  | "applied"
  | "application_approved"
  | "application_rejected"
  | "application_withdrawn"
  | "accepted"
  | "pr_opened"
  | "submitted"
  | "review_completed"
  | "payout_requested"
  | "extension_requested"
  | "extension_approved"
  | "extension_declined"
  | "submission_rejected"
  | "rejection_accepted"
  | "payout_submitted"
  | "paid"
  | "refund_submitted"
  | "refunded"
  | "cancelled";

export type BountyEvent = {
  at: number;
  kind: BountyEventKind;
  // Who did it: a githubLogin, "system" for keeper/admin actions, or null when
  // the actor is unknown (legacy paths, token-scoped links).
  actor?: string | null;
  // Who the event is ABOUT when that differs from the actor — e.g. the
  // applicant's login on application_approved (actor = the sponsor). Drives
  // the contributor view's privacy filter: application events are only shown
  // to the contributor they concern.
  //
  // `subjectGithubId` is what that filter actually keys on; `subject` is the
  // display string. A login is not an identity — re-applying after a GitHub
  // rename rewrites the application row and orphans a contributor's own older
  // events, and a recycled login makes two applicants indistinguishable. Absent
  // on events written before this field existed; see eventsForContributor for
  // how those resolve.
  subjectGithubId?: number | null;
  subject?: string | null;
  // Short human-readable context (rejection reason, "3 of 5 criteria met", …).
  detail?: string | null;
};

// A contributor's application to work a bounty. The contributor binds their
// payout wallet at apply time; the sponsor's single "delegate" click then
// accepts one application (status "accepted"), which delegates the bounty and
// starts the delivery clock. ("approved" is a legacy substatus from the old
// two-step handshake — retained so old rows load, never written by new code.)
export type BountyApplication = {
  githubId: number;
  githubLogin: string;
  note?: string;
  appliedAt: number;
  status: "pending" | "approved" | "accepted" | "rejected";
  // Payout wallet bound to this application at apply time (snapshotted onto the
  // bounty as assigneeAddress when the sponsor delegates). Absent on legacy rows
  // written before wallet-at-apply — delegateToApplicant falls back to the
  // applicant's account wallet for those.
  address?: string; // payout G…
  memo?: string | null; // payout memo (MEMO_TEXT ≤28 bytes), normalized
  trustline?: boolean; // cached USDC-trustline result at apply time (advisory)
};

export type Bounty = {
  id: string;
  seq: number; // monotonic display index
  code: string; // "BNTY-<seq>"
  source: BountySource;
  installationId: number; // GitHub installation numeric id (for gh() comment posts)
  repo: string; // "owner/name"
  issueNumber: number;
  issueUrl: string;
  externalKey?: string | null; // Linear issue id, when source === "linear"
  title: string;
  description: string;
  // The acceptance contract. ORDER IS LOAD-BEARING: the review pipeline seeds
  // criteria from this list with positional `bounty-1..N` ids, and
  // partitionBountyCriteria sorts on them — so reordering after funding would
  // silently reshuffle verdicts against a paid contract. Frozen at funding
  // (see acceptanceLocked in bounties/service.ts).
  acceptance: string[];
  // AI-drafted acceptance criteria (both optional; rows written before the
  // drafting job existed load unchanged and read as "ready").
  // Generation state for the fund page: without it `acceptance: []` is
  // ambiguous between "not drafted yet", "drafted nothing" and "drafting
  // failed" — three different screens.
  acceptanceState?: "generating" | "ready" | "errored";
  acceptanceEndGoal?: string | null; // one-sentence "what success looks like"
  sponsorUserId?: string | null; // the DevAsign user who triggered it (may be unset for a pure-comment sponsor)
  sponsorAddress?: string | null; // Freighter G… = on-chain creator; set when funding lands
  taskId: string; // EXACTLY 25 chars; the on-chain escrow key (deterministic from id)
  contractId: string; // escrow contract id the escrow was created on
  amountStroops: string; // i128 amount in USDC stroops (7 decimals), as a string
  amountUsdc: number; // whole/decimal USDC, for display
  deliveryDays: number; // delivery window length (starts at acceptance)
  status: BountyStatus;
  onchainStatus: OnchainStatus | null;
  applications: BountyApplication[];
  assigneeGithubId?: number | null;
  assigneeGithubLogin?: string | null;
  assigneeAddress?: string | null; // the accepted contributor's payout G…, snapshotted at acceptance
  assigneeMemo?: string | null; // the payout memo snapshotted alongside assigneeAddress (may be unset on old rows)
  acceptedAt?: number | null;
  deadlineAt?: number | null; // acceptedAt + deliveryDays; the keeper refunds past this
  // One-shot stamp for the keeper's 24h-out warning bell, so a 12s tick can't
  // re-notify. CLEARED whenever deadlineAt moves (respondToExtension approve) so
  // an extended bounty gets a fresh warning against its new deadline. Absent on
  // every row written before this existed — read it with `== null`.
  deadlineWarnedAt?: number | null;
  prNumber?: number | null; // the delivering PR
  // Contributor-app submission surface (all optional; old rows load unchanged):
  // when the contributor explicitly submitted via the app (vs. webhook-inferred),
  // any supporting links they attached, when they requested payout, and the
  // sponsor's standing rejection of the submitted work (null/absent = none).
  submittedAt?: number | null;
  supportingLinks?: SupportingLink[];
  payoutRequestedAt?: number | null;
  rejection?: SubmissionRejection | null;
  // The (single) timeline-extension request; see BountyExtension. Absent on
  // rows written before the feature existed.
  extension?: BountyExtension | null;
  // Append-only activity log (see BountyEvent). Capped at EVENT_CAP entries in
  // recordBountyEvent; absent on rows written before the log existed.
  events?: BountyEvent[];
  botCommentId?: number | null; // the DevAsign confirm/status comment on the issue (so we can edit it)
  escrowTxHash?: string | null;
  payoutTxHash?: string | null;
  refundTxHash?: string | null;
  cancelReason?: BountyCancelReason | null;
  // Single-flight guard: set while an on-chain release/refund is in flight so the
  // two payout triggers (PR-merge + in-app approve) and the deadline sweeper can't
  // fire concurrently. Cleared once the tx confirms or fails.
  pendingOp?: "releasing" | "refunding" | null;
  createdAt: number;
  updatedAt: number;
};

export type EscrowTxnKind = "escrow" | "payout" | "refund";
export type EscrowTxnStatus = "pending" | "confirmed" | "failed";

// One row per on-chain escrow operation. Doubles as the frontend transaction
// ledger AND the idempotency + reconciliation ledger: `idempotencyKey` is
// deterministic (e.g. "escrow:{taskId}", "release:{taskId}", "refund:{taskId}")
// so a retried webhook/keeper tick reuses the same row instead of double-paying.
export type EscrowTransaction = {
  id: string;
  bountyId?: string | null;
  // The counterparty (contributor) when relevant. `githubId` is the identity —
  // it is stable across a GitHub rename, and GitHub recycles abandoned logins,
  // so matching a ledger row to a person by login both loses history and can
  // serve one person's payouts to whoever claims their old name. Stamped from
  // Bounty.assigneeGithubId at send time. `githubLogin` is DISPLAY/AUDIT ONLY —
  // it records what they were called when the money moved. Never join on it.
  githubId?: number | null;
  githubLogin?: string | null;
  kind: EscrowTxnKind;
  idempotencyKey: string;
  signer: "sponsor" | "admin"; // who authorized it (client Freighter vs. backend admin key)
  sourceAccount?: string | null;
  status: EscrowTxnStatus;
  hash?: string | null;
  ledger?: number | null;
  amountStroops: string;
  dir: "in" | "out"; // sponsor-centric: escrow/payout = out, refund = in
  note?: string;
  error?: string | null;
  createdAt: number;
  confirmedAt?: number | null;
  // Payout destination snapshot: the exact wallet (address + memo) this payout
  // was sent to, frozen at send time — the contributor's wallet ledger stays
  // truthful even after they change or remove their registered wallet. Only set
  // on kind:"payout" rows written after this field existed.
  destAddress?: string | null;
  destMemo?: string | null;
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
  bounties: Bounty[];
  escrowTransactions: EscrowTransaction[];
  securityFindings: SecurityFinding[];
  securityScans: SecurityScanRun[];
  securityPrecedents: SecurityPrecedent[];
};
