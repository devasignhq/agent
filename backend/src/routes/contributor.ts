// Contributor-scoped REST surface for the contributor (developer) app. Mounted
// under /api in server.ts alongside the bounty routes. Everything here is keyed
// to the CALLER's GitHub identity — a contributor sees only bounties they
// applied to or were assigned, only their own application entry, and only their
// own payout ledger. Sponsor-only material (fund/cancel links, other
// applicants) never enters these payloads.
import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db.js";
import type { Bounty, BountyEvent, EscrowTransaction, User } from "../types.js";
import { config } from "../config.js";
import { getSessionUser } from "../github/oauth.js";
import { stroopsToUsdcNumber } from "../stellar/amount.js";
import { criteriaCounts, findBountyReview, partitionBountyCriteria } from "../bounties/review-lookup.js";

export const contributor = Router();

function requireGithubUser(req: Request, res: Response): User | null {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  if (user.githubId == null) {
    res.status(400).json({ error: "no_github_identity" });
    return null;
  }
  return user;
}

// Is this bounty part of the contributor's world — applied to it, or assigned?
function involvesContributor(b: Bounty, githubId: number): boolean {
  return (
    b.assigneeGithubId === githubId || b.applications.some((a) => a.githubId === githubId)
  );
}

// Which activity-log kinds concern a specific contributor (filtered per
// caller): application outcomes, and the assignee's extension requests — the
// extension reason is assignee-authored and possibly personal, and rival
// applicants stay subscribed to the bounty (involvesContributor above).
const SUBJECT_GATED_EVENT_KINDS = new Set([
  "applied",
  "application_approved",
  "application_rejected",
  "application_withdrawn",
  "extension_requested",
  "extension_approved",
  "extension_declined",
]);

// Which contributor an application event concerns, as a numeric id — the same
// reason payoutCounterpartyId() exists below: a login is a display string, not
// an identity. Events written before subjectGithubId existed carry only a
// login, resolved here through the bounty's own applications, which carry both.
//
// A login matching two applications — one applicant renamed, someone else took
// the freed username, both applied here — resolves to NOBODY rather than to
// both. Withholding costs the legitimate holder some of their own timeline;
// the alternative shows each of them the other's application outcomes, which is
// the exact thing this filter exists to prevent. Fail closed.
function eventSubjectId(e: BountyEvent, b: Bounty): number | null {
  if (e.subjectGithubId != null) return e.subjectGithubId;
  const who = e.subject ?? e.actor;
  if (!who) return null;
  const named = b.applications.filter((a) => a.githubLogin === who);
  return named.length === 1 ? named[0].githubId : null;
}

// The caller's view of the activity log: every lifecycle event, EXCEPT other
// contributors' application events — rival applicants stay invisible, matching
// the applications-array filtering below.
function eventsForContributor(b: Bounty, githubId: number) {
  return (b.events ?? []).filter((e) => {
    if (!SUBJECT_GATED_EVENT_KINDS.has(e.kind)) return true;
    return eventSubjectId(e, b) === githubId;
  });
}

// The moment `kind` last happened, from the caller-visible events.
function eventAt(events: Array<{ at: number; kind: string }>, kind: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i].at;
  return null;
}

// Legacy fallback: the confirm time of the escrow/release/refund ledger row.
function txnConfirmedAt(b: Bounty, prefix: "escrow" | "release" | "refund"): number | null {
  const txn = db.find(
    "escrowTransactions",
    (t) => t.idempotencyKey === `${prefix}:${b.taskId}` && t.status === "confirmed"
  );
  return txn?.confirmedAt ?? null;
}

// The sponsor's display login for "X picked you" copy: the bounty creator's
// user row, else the installation account (org/user) that owns the repo.
function sponsorLoginFor(b: Bounty): string | null {
  if (b.sponsorUserId) {
    const u = db.find("users", (x) => x.id === b.sponsorUserId);
    if (u?.githubLogin) return u.githubLogin;
  }
  const install = db.find("installations", (i) => i.installationId === b.installationId);
  return install?.accountLogin ?? null;
}

// The contributor's view of a bounty: their OWN application (not the list), the
// assignee fields (which are theirs when assigned), and no sponsor links. Built
// as an explicit shape (not a spread-minus) so sponsor-only additions to Bounty
// don't leak here by default.
export function contributorBountyView(b: Bounty, githubId: number) {
  const mine = b.applications.find((a) => a.githubId === githubId) ?? null;
  const isAssignee = b.assigneeGithubId === githubId;
  const events = eventsForContributor(b, githubId);
  // Compact AI-review projection so the list screens can render PR titles,
  // the review line, and ready-for-payout pills without N+1 review fetches.
  const reviewRow = findBountyReview(b);
  const review = reviewRow
    ? (() => {
        const { main } = partitionBountyCriteria(reviewRow);
        return {
          prTitle: reviewRow.prTitle,
          summary: reviewRow.verdict ?? null,
          counts: criteriaCounts(main),
        };
      })()
    : null;
  return {
    id: b.id,
    code: b.code,
    source: b.source,
    repo: b.repo,
    issueNumber: b.issueNumber,
    issueUrl: b.issueUrl,
    title: b.title,
    description: b.description,
    acceptance: b.acceptance,
    amountUsdc: b.amountUsdc,
    deliveryDays: b.deliveryDays,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    applicantCount: b.applications.length,
    myApplication: mine,
    isAssignee,
    // Assignment + submission surface (theirs once assigned; harmless otherwise
    // since any signed-in user can already read the bounty row).
    assigneeGithubLogin: b.assigneeGithubLogin ?? null,
    assigneeAddress: isAssignee ? (b.assigneeAddress ?? null) : null,
    assigneeMemo: isAssignee ? (b.assigneeMemo ?? null) : null,
    acceptedAt: b.acceptedAt ?? null,
    deadlineAt: b.deadlineAt ?? null,
    prNumber: b.prNumber ?? null,
    submittedAt: b.submittedAt ?? null,
    // The assignee's submitted work evidence — an unlisted demo, a preview
    // deploy, a design doc. Gated like the wallet fields above, and for a
    // sharper reason than they are: involvesContributor() keeps every REJECTED
    // applicant subscribed to this bounty, so ungated they would each keep
    // receiving whoever won it delivering it. Empty array rather than null when
    // gated — the contributor app calls .length/.map on this unconditionally.
    supportingLinks: isAssignee ? (b.supportingLinks ?? []) : [],
    payoutRequestedAt: b.payoutRequestedAt ?? null,
    rejection: b.rejection ?? null,
    // Gated like supportingLinks: the request (and its reason) is the
    // assignee's business, not the rival applicants'.
    extension: isAssignee ? (b.extension ?? null) : null,
    cancelReason: b.cancelReason ?? null,
    escrowTxHash: b.escrowTxHash ?? null,
    payoutTxHash: b.payoutTxHash ?? null,
    escrowContract: b.contractId || null,
    sponsorLogin: sponsorLoginFor(b),
    // The caller-visible activity log + the derived widget timestamps the
    // design renders ("awarded 6h ago", "paid Apr 12", funded date). Events are
    // the source of truth; ledger confirm times back-fill legacy rows.
    events,
    fundedAt: eventAt(events, "funded") ?? txnConfirmedAt(b, "escrow"),
    awardedAt: mine?.status === "approved" || mine?.status === "accepted" ? eventAt(events, "application_approved") : null,
    paidAt: b.status === "PAID" ? (eventAt(events, "paid") ?? txnConfirmedAt(b, "release")) : null,
    refundedAt: b.status === "CANCELLED" ? (eventAt(events, "refunded") ?? txnConfirmedAt(b, "refund")) : null,
    review,
  };
}

export type ContributorSummary = {
  active: number;
  applied: number;
  completed: number;
  inEscrowUsdc: number;
  lifetimeEarnedUsdc: number;
};

// Pure so it unit-tests without HTTP: dashboard stat tiles + the wallet page's
// "pending in escrow" figure, derived from the contributor's bounty set.
export function contributorSummary(list: Bounty[], githubId: number): ContributorSummary {
  const s: ContributorSummary = { active: 0, applied: 0, completed: 0, inEscrowUsdc: 0, lifetimeEarnedUsdc: 0 };
  for (const b of list) {
    const isAssignee = b.assigneeGithubId === githubId;
    if (isAssignee && (b.status === "DELEGATED" || b.status === "IN_REVIEW")) {
      s.active++;
      s.inEscrowUsdc += b.amountUsdc;
    } else if (isAssignee && b.status === "PAID") {
      s.completed++;
      s.lifetimeEarnedUsdc += b.amountUsdc;
    } else if (b.status === "OPEN") {
      const mine = b.applications.find((a) => a.githubId === githubId);
      if (mine && (mine.status === "pending" || mine.status === "approved")) s.applied++;
    }
  }
  return s;
}

// Block-explorer base for the configured network, sent once per response
// envelope so the frontend builds tx links without hardcoding the network.
// Exported for the public discovery read in routes/bounties.ts.
export function explorerBase(): string {
  const net = config.stellar.network === "public" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}`;
}

export function contributorBountiesHandler(req: Request, res: Response) {
  const user = requireGithubUser(req, res);
  if (!user) return;
  const githubId = user.githubId!;
  const mine = db
    .filter("bounties", (b) => involvesContributor(b, githubId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({
    bounties: mine.map((b) => contributorBountyView(b, githubId)),
    summary: contributorSummary(mine, githubId),
    explorerBase: explorerBase(),
  });
}
contributor.get("/contributor/bounties", contributorBountiesHandler);

// Who a payout row belongs to, as a stable numeric GitHub id — never a login.
// `githubLogin` on the row is a snapshot frozen at send time while the user's
// login is rewritten on every sign-in after a rename (see oauth.ts), so matching
// the two loses a renamed contributor's entire history; worse, GitHub recycles
// abandoned logins, so whoever claims a departed contributor's name would be
// served their payouts — amounts, hashes, and destination wallet.
//
// Rows written before `githubId` existed resolve through the bounty, exactly as
// bounties/live.ts does when picking the audience for this same ledger (keep the
// two in sync). Unresolvable rows belong to NOBODY: every payout carries a
// bountyId, bounties are never deleted, and the assignee's numeric id is written
// in the same patch as the payout address every payout path requires — so this
// returning null means the data is malformed, not old. Fail closed and say so.
const UNRESOLVED_WARN_MS = 60 * 60 * 1000;
const lastUnresolvedWarn = new Map<string, number>();

// Throttled because the caller runs this inside a db.filter on every ledger
// fetch: unthrottled, a single malformed row would log once per contributor per
// request forever. A WINDOW rather than a warn-once-ever set, though — the
// condition is supposed to be unreachable, so if it ever starts happening the
// recurrence is the signal that something is actively wrong. Reporting it a
// single time and then going quiet reads exactly like it healed itself.
function warnUnresolvable(t: EscrowTransaction): void {
  const now = Date.now();
  const last = lastUnresolvedWarn.get(t.id);
  if (last != null && now - last < UNRESOLVED_WARN_MS) return;
  // Rows that stopped being unresolvable (repaired, or deleted) stop refreshing
  // their stamp, so aging them out bounds the map — mirrors the keeper's
  // throttle prune. Runs only when we are about to warn, which should be never.
  for (const [id, at] of lastUnresolvedWarn) {
    if (now - at >= UNRESOLVED_WARN_MS) lastUnresolvedWarn.delete(id);
  }
  lastUnresolvedWarn.set(t.id, now);
  console.warn(
    `[ledger] payout txn ${t.id} (bounty ${t.bountyId ?? "none"}) has no resolvable ` +
      `counterparty id — withheld from every ledger`
  );
}

export function payoutCounterpartyId(
  t: EscrowTransaction,
  bountyById: Map<string, Bounty>
): number | null {
  if (t.githubId != null) return t.githubId;
  const b = t.bountyId ? bountyById.get(t.bountyId) : undefined;
  if (b?.assigneeGithubId != null) return b.assigneeGithubId;
  warnUnresolvable(t);
  return null;
}

// The contributor's payout ledger: every escrow release addressed to them, with
// the dest wallet snapshotted at send time (falling back to the bounty's
// assignee snapshot for rows written before destAddress existed).
export function contributorTransactionsHandler(req: Request, res: Response) {
  const user = requireGithubUser(req, res);
  if (!user) return;
  const githubId = user.githubId!;
  const bountyById = new Map(db.table("bounties").map((b) => [b.id, b]));
  const rows = db
    .filter(
      "escrowTransactions",
      (t) => t.kind === "payout" && payoutCounterpartyId(t, bountyById) === githubId
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const transactions = rows.map((t: EscrowTransaction) => {
    const b = t.bountyId ? bountyById.get(t.bountyId) : undefined;
    return {
      id: t.id,
      bountyId: t.bountyId ?? null,
      code: b?.code ?? null,
      title: b?.title ?? null,
      repo: b?.repo ?? null,
      issueNumber: b?.issueNumber ?? null,
      amountUsdc: stroopsToUsdcNumber(BigInt(t.amountStroops)),
      status: t.status,
      hash: t.hash ?? null,
      createdAt: t.createdAt,
      confirmedAt: t.confirmedAt ?? null,
      dest: {
        address: t.destAddress ?? b?.assigneeAddress ?? null,
        memo: t.destMemo ?? b?.assigneeMemo ?? null,
      },
    };
  });
  res.json({ transactions, explorerBase: explorerBase() });
}
contributor.get("/contributor/transactions", contributorTransactionsHandler);
