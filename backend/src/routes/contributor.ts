// Contributor-scoped REST surface for the contributor (developer) app. Mounted
// under /api in server.ts alongside the bounty routes. Everything here is keyed
// to the CALLER's GitHub identity — a contributor sees only bounties they
// applied to or were assigned, only their own application entry, and only their
// own payout ledger. Sponsor-only material (fund/cancel links, other
// applicants) never enters these payloads.
import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db.js";
import type { Bounty, EscrowTransaction, User } from "../types.js";
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

// Which activity-log kinds concern a specific applicant (filtered per caller).
const APPLICATION_EVENT_KINDS = new Set([
  "applied",
  "application_approved",
  "application_rejected",
  "application_withdrawn",
]);

// The caller's view of the activity log: every lifecycle event, EXCEPT other
// contributors' application events — rival applicants stay invisible, matching
// the applications-array filtering below.
function eventsForContributor(b: Bounty, myLogin: string | null) {
  return (b.events ?? []).filter((e) => {
    if (!APPLICATION_EVENT_KINDS.has(e.kind)) return true;
    const who = e.subject ?? e.actor;
    return !!myLogin && who === myLogin;
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
  const myLogin = mine?.githubLogin ?? (isAssignee ? (b.assigneeGithubLogin ?? null) : null);
  const events = eventsForContributor(b, myLogin);
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
    supportingLinks: b.supportingLinks ?? [],
    payoutRequestedAt: b.payoutRequestedAt ?? null,
    rejection: b.rejection ?? null,
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

// The contributor's payout ledger: every escrow release addressed to them, with
// the dest wallet snapshotted at send time (falling back to the bounty's
// assignee snapshot for rows written before destAddress existed).
export function contributorTransactionsHandler(req: Request, res: Response) {
  const user = requireGithubUser(req, res);
  if (!user) return;
  const rows = db
    .filter(
      "escrowTransactions",
      (t) => t.kind === "payout" && !!t.githubLogin && t.githubLogin === user.githubLogin
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const bountyById = new Map(db.table("bounties").map((b) => [b.id, b]));
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
