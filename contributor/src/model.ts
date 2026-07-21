// Pure derivations for the contributor app — no React, no fetch — so the
// state-machine mapping from API rows to screen states unit-tests with
// `node --test` (the house pattern; see notifications-stream.ts).
import type { BountyEvent, BountyReview, ContributorBounty, ReviewCriterion } from "./api.ts";

// ── formatting ───────────────────────────────────────────────────────────────

export const cmoney = (n: number): string => "$" + Math.round(n).toLocaleString("en-US");
export const cmoney2 = (n: number): string =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const shortAddr = (addr: string): string =>
  addr.length <= 14 ? addr : `${addr.slice(0, 6)}…${addr.slice(-6)}`;

export const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const fmtDateYear = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function timeAgo(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

// "3 days left" / "8h left" / "past due" from a deadline timestamp.
export function timeLeft(deadlineAt: number, now: number = Date.now()): string {
  const ms = deadlineAt - now;
  if (ms <= 0) return "past due";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "under 1h left";
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)} days left`;
}

// ── validation (client-side pre-checks; the backend re-validates) ────────────

// Ed25519 public key: "G" + 55 base32 chars (A–Z, 2–7), 56 total.
export const isStellarAddr = (s: string): boolean => /^G[A-Z2-7]{55}$/.test(s.trim());

// MEMO_TEXT: at most 28 BYTES of UTF-8 (not characters). Empty = "no memo" = valid.
export const MEMO_MAX_BYTES = 28;
export const isValidMemo = (s: string): boolean =>
  new TextEncoder().encode(s.trim()).length <= MEMO_MAX_BYTES;

// Canonical GitHub PR URL (mirrors backend bounties/submission.ts).
const PR_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/;
export function parsePrUrl(raw: string): { repo: string; prNumber: number } | null {
  const m = PR_URL_RE.exec(raw.trim());
  if (!m) return null;
  const prNumber = Number(m[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { repo: `${m[1]}/${m[2]}`, prNumber };
}

// ── timeline extension ───────────────────────────────────────────────────────

// Quick-pick chips in the request modal; Custom allows any integer up to the max.
export const EXTENSION_PRESETS = [1, 2, 3] as const;
export const EXTENSION_MAX_DAYS = 7;

export const isValidExtensionDays = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= EXTENSION_MAX_DAYS;

// What the extension CTA should show for this bounty. Only meaningful in the
// "progress" stage (accepted, nothing submitted): once approved, the button is
// gone for good — one extension per bounty, ever.
export type ExtensionState = "can_request" | "pending" | "approved" | "unavailable";

export function extensionState(b: ContributorBounty): ExtensionState {
  if (bountyStage(b) !== "progress") return "unavailable";
  if (b.extension?.status === "pending") return "pending";
  if (b.extension?.status === "approved") return "approved";
  return "can_request"; // absent or declined — may (re)request
}

// ── bounty stage machine ─────────────────────────────────────────────────────
// The screen-level state a bounty is in FOR THIS CONTRIBUTOR — richer than the
// backend status because it folds in their application, the submission, and a
// standing rejection.
export type BountyStage =
  | "applied"    // my application is pending the sponsor's decision
  | "shortlist"  // (reserved) sponsor engaged but not decided — not modeled yet
  | "awarded"    // sponsor approved me; I must accept (wallet) to start the clock
  | "progress"   // accepted, clock running, nothing submitted yet
  | "review"     // PR submitted, awaiting review/approval
  | "ready"      // review complete, ALL criteria met — payout requestable
  | "rejected"   // submitted but the sponsor rejected the work (still reworkable)
  | "paid"       // escrow released to my wallet
  | "closed"     // cancelled/refunded (incl. accepted rejection) or app rejected
  | "lost";      // someone else got it

export function bountyStage(b: ContributorBounty): BountyStage {
  if (b.status === "PAID") return b.isAssignee ? "paid" : "lost";
  if (b.status === "CANCELLED") return "closed";
  if (b.isAssignee) {
    if (b.rejection) return "rejected";
    const allMet =
      !!b.review && b.review.counts.total > 0 && b.review.counts.met === b.review.counts.total;
    if (b.status === "IN_REVIEW") return allMet ? "ready" : "review";
    if (b.status === "DELEGATED") return b.submittedAt ? (allMet ? "ready" : "review") : "progress";
  }
  // Not the assignee: my standing depends on my application.
  const app = b.myApplication;
  if (!app) return "closed";
  if (app.status === "approved") return b.status === "OPEN" ? "awarded" : "lost";
  if (app.status === "pending") return b.status === "OPEN" ? "applied" : "lost";
  if (app.status === "rejected") return "closed";
  // accepted but not assignee — transitional server state; treat as progress.
  return "progress";
}

export const STAGE_LABEL: Record<BountyStage, string> = {
  applied: "under review",
  shortlist: "shortlisted",
  awarded: "awarded",
  progress: "in progress",
  review: "in review",
  ready: "ready for payout",
  rejected: "rejected",
  paid: "paid",
  closed: "closed",
  lost: "not selected",
};

// Pill palette per stage (classes exist in styles.css: ok/warn/bad/info/mute).
export const STAGE_PILL: Record<BountyStage, string> = {
  applied: "info",
  shortlist: "info",
  awarded: "ok",
  progress: "warn",
  review: "info",
  ready: "ok",
  rejected: "bad",
  paid: "ok",
  closed: "mute",
  lost: "mute",
};

// Dashboard groupings.
export type BountyGroups = {
  awarded: ContributorBounty[];
  active: ContributorBounty[];   // progress / review / rejected — the workspace set
  applied: ContributorBounty[];
  completed: ContributorBounty[]; // paid
  closed: ContributorBounty[];
};

export function groupBounties(list: ContributorBounty[]): BountyGroups {
  const g: BountyGroups = { awarded: [], active: [], applied: [], completed: [], closed: [] };
  for (const b of list) {
    const stage = bountyStage(b);
    if (stage === "awarded") g.awarded.push(b);
    else if (stage === "progress" || stage === "review" || stage === "ready" || stage === "rejected") g.active.push(b);
    else if (stage === "applied") g.applied.push(b);
    else if (stage === "paid") g.completed.push(b);
    else g.closed.push(b);
  }
  return g;
}

// First-round acceptance share for the design's "N bounties · X% accepted"
// stat: paid work vs work that ended rejected-and-closed. Null until there's
// at least one finished bounty to measure.
export function acceptanceRate(list: ContributorBounty[]): number | null {
  let paid = 0;
  let rejectedClosed = 0;
  for (const b of list) {
    const stage = bountyStage(b);
    if (stage === "paid") paid++;
    else if (stage === "closed" && b.isAssignee && b.cancelReason === "rejected") rejectedClosed++;
  }
  const total = paid + rejectedClosed;
  return total > 0 ? Math.round((paid / total) * 100) : null;
}

// ── activity timeline ────────────────────────────────────────────────────────
// Map the server-side activity log onto the design's timeline vocabulary
// (icon names from icons.tsx; cls matches the .dsp-tl icon tints). Pure data —
// the components own the JSX. Falls back to a coarse synthesis from the
// bounty's timestamps for legacy rows written before the log existed.
export type TimelineEntry = {
  at: number | null;         // epoch ms; null → render timeLabel as-is
  timeLabel?: string;        // used when at is null ("now", "…")
  icon: string;
  cls?: string;              // "cool" | "warn" | "danger" | undefined
  action: string;
  detail?: string | null;
};

const EVENT_DISPLAY: Record<
  BountyEvent["kind"],
  (e: BountyEvent, b: ContributorBounty) => TimelineEntry | null
> = {
  created: (e, b) => ({
    at: e.at, icon: "flag", action: e.actor ? `Bounty posted by @${e.actor}` : "Bounty posted",
    detail: e.detail,
  }),
  funding_submitted: (e) => ({ at: e.at, icon: "lock", action: "Escrow funding submitted", detail: e.detail }),
  funded: (e, b) => ({
    at: e.at, icon: "lock", cls: "cool", action: "Bounty funded",
    detail: `${cmoney(b.amountUsdc)} USDC escrowed on Stellar. Criteria locked.`,
  }),
  applied: (e) => ({ at: e.at, icon: "send", action: "You applied" }),
  application_approved: (e) => ({
    at: e.at, icon: "trophy", cls: "cool",
    action: e.actor ? `You were picked by @${e.actor}` : "You were picked",
    detail: "Accept the award to start the delivery clock.",
  }),
  application_rejected: (e) => ({
    at: e.at, icon: "x", cls: "danger",
    action: "Your application wasn't selected",
  }),
  application_withdrawn: (e) => ({ at: e.at, icon: "return", action: "You withdrew your application" }),
  accepted: (e) => ({
    at: e.at, icon: "user", action: e.actor ? `Assigned to you (@${e.actor})` : "Assigned to you",
    detail: e.detail,
  }),
  pr_opened: (e) => ({ at: e.at, icon: "git", action: "You opened a pull request", detail: e.detail }),
  submitted: (e) => ({ at: e.at, icon: "git", action: "You submitted the work", detail: e.detail }),
  review_completed: (e) => ({ at: e.at, icon: "spark", cls: "cool", action: "DevAsign review", detail: e.detail }),
  payout_requested: (e) => ({ at: e.at, icon: "coins", cls: "cool", action: "You requested payout", detail: "The sponsor has been notified." }),
  extension_requested: (e) => ({
    at: e.at, icon: "clock", cls: "warn", action: "You requested a timeline extension",
    detail: e.detail,
  }),
  extension_approved: (e) => ({
    at: e.at, icon: "check", cls: "cool",
    action: e.actor ? `@${e.actor} approved your extension` : "Extension approved",
    detail: e.detail,
  }),
  extension_declined: (e) => ({
    at: e.at, icon: "x", cls: "danger",
    action: e.actor ? `@${e.actor} declined your extension request` : "Extension declined",
    detail: "The current deadline stands.",
  }),
  submission_rejected: (e) => ({
    at: e.at, icon: "warn", cls: "danger",
    action: e.actor ? `${e.actor} rejected the submission` : "Submission rejected",
    detail: e.detail,
  }),
  rejection_accepted: (e) => ({ at: e.at, icon: "check", action: "You accepted the verdict", detail: "The escrow returns to the sponsor." }),
  payout_submitted: (e) => ({ at: e.at, icon: "coins", cls: "cool", action: "Escrow release submitted", detail: e.detail }),
  paid: (e, b) => ({
    at: e.at, icon: "coins", cls: "cool", action: "Escrow released",
    detail: e.detail ?? `${cmoney(b.amountUsdc)} USDC paid to your wallet.`,
  }),
  refund_submitted: (e) => ({
    at: e.at, icon: "return", action: "Escrow refund submitted",
    detail: e.detail === "expired" ? "The delivery window elapsed." : e.detail,
  }),
  refunded: (e) => ({ at: e.at, icon: "return", action: "Escrow refunded to the sponsor", detail: e.detail }),
  cancelled: (e) => ({ at: e.at, icon: "x", action: "Bounty cancelled", detail: e.detail }),
};

export function timelineFromEvents(b: ContributorBounty): TimelineEntry[] {
  const events = b.events ?? [];
  if (events.length > 0) {
    const entries = events
      .map((e) => EVENT_DISPLAY[e.kind]?.(e, b) ?? null)
      .filter((x): x is TimelineEntry => x !== null);
    // Live tail — what's happening NOW, mirroring the design's synthetic rows.
    const stage = bountyStage(b);
    if (stage === "applied") entries.push({ at: null, timeLabel: "now", icon: "clock", cls: "warn", action: "Awaiting the maintainer's decision" });
    if (stage === "progress") entries.push({ at: null, timeLabel: "now", icon: "clock", cls: "warn", action: "In progress — no submission yet" });
    if (stage === "ready") entries.push({ at: null, timeLabel: "now", icon: "coins", cls: "cool", action: "All criteria met — ready to request payout" });
    return entries;
  }
  // Legacy rows: coarse synthesis from the timestamps that exist.
  const ev: TimelineEntry[] = [];
  ev.push({
    at: b.fundedAt ?? b.createdAt, icon: "lock", cls: "cool", action: "Bounty funded",
    detail: `${cmoney(b.amountUsdc)} USDC escrowed on Stellar. Criteria locked.`,
  });
  if (b.myApplication) ev.push({ at: b.myApplication.appliedAt, icon: "send", action: "You applied" });
  if (b.awardedAt) ev.push({ at: b.awardedAt, icon: "trophy", cls: "cool", action: "You were picked" });
  if (b.acceptedAt) ev.push({ at: b.acceptedAt, icon: "user", action: "Assigned to you" });
  if (b.submittedAt || b.prNumber) ev.push({ at: b.submittedAt, timeLabel: b.submittedAt ? undefined : "submitted", icon: "git", action: "You submitted the work", detail: b.prNumber ? `PR #${b.prNumber}` : null });
  if (b.rejection) ev.push({ at: b.rejection.at, icon: "warn", cls: "danger", action: `${b.rejection.byLogin} rejected the submission`, detail: b.rejection.reason });
  if (b.payoutRequestedAt) ev.push({ at: b.payoutRequestedAt, icon: "coins", cls: "cool", action: "You requested payout" });
  if (b.paidAt || b.status === "PAID") ev.push({ at: b.paidAt, timeLabel: b.paidAt ? undefined : "paid", icon: "coins", cls: "cool", action: "Escrow released", detail: `${cmoney(b.amountUsdc)} USDC paid to your wallet.` });
  if (b.status === "CANCELLED") ev.push({ at: b.refundedAt, timeLabel: b.refundedAt ? undefined : "closed", icon: "return", action: "Bounty closed", detail: b.cancelReason === "rejected" ? "Verdict accepted — escrow returned to the sponsor." : "Escrow refunded to the sponsor." });
  const stage = bountyStage(b);
  if (stage === "applied") ev.push({ at: null, timeLabel: "now", icon: "clock", cls: "warn", action: "Awaiting the maintainer's decision" });
  if (stage === "progress") ev.push({ at: null, timeLabel: "now", icon: "clock", cls: "warn", action: "In progress — no submission yet" });
  return ev;
}

// ── review merge ─────────────────────────────────────────────────────────────

// The criteria list a workspace renders: the locked acceptance list, annotated
// with the AI verdicts once a review exists. Before any review, every row is
// "pending" with no finding.
export function mergedCriteria(
  acceptance: string[],
  review: BountyReview | null
): ReviewCriterion[] {
  if (review && review.criteria.length > 0) return review.criteria;
  return acceptance.map((text, i) => ({ n: i + 1, text, status: "pending" as const, finding: null }));
}

// "3 of 5 criteria met" headline; null when nothing is scored yet.
export function reviewHeadline(review: BountyReview | null): string | null {
  if (!review) return null;
  const { met, unmet, pending, total } = review.counts;
  if (total === 0) return null;
  if (pending === total) return "Review queued — no verdicts yet";
  if (met === total) return `All ${total} criteria met`;
  return `${met} of ${total} criteria met${unmet ? ` — ${unmet} outstanding` : ""}`;
}

// All criteria green → the "request payout" CTA lights up.
export function allCriteriaMet(review: BountyReview | null): boolean {
  return !!review && review.counts.total > 0 && review.counts.met === review.counts.total;
}

// ── account deletion ─────────────────────────────────────────────────────────

// Two-factor confirm gate for the destructive delete-account button: the user
// must retype their own GitHub login (case-insensitive) AND the literal phrase.
// A missing/empty login keeps the gate shut even when both fields are blank.
export const DELETE_PHRASE = "delete my account";

export function deleteConfirmOk(
  githubLogin: string | undefined,
  name: string,
  phrase: string
): boolean {
  if (!githubLogin) return false;
  const nameOk = name.trim().toLowerCase() === githubLogin.trim().toLowerCase();
  const phraseOk = phrase.trim().toLowerCase() === DELETE_PHRASE;
  return nameOk && phraseOk;
}
