// Bounty lifecycle service — the single place that maps the app state machine to
// on-chain escrow operations and writes the escrowTransactions ledger. Every
// mutation is safe to re-run: on-chain ops are keyed by a deterministic
// idempotencyKey and single-flighted with a `pendingOp` guard, so a webhook
// redelivery, a double-click, or a keeper retry can never double-pay or
// double-refund. The contract's own status guards are the final backstop.
//
// Auth is enforced at the route layer (getSessionUser + installation membership);
// these functions assume their caller is already authorized and only enforce
// STATE preconditions.
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config, isStellarConfigured } from "../config.js";
import type {
  Bounty,
  BountyApplication,
  BountyCancelReason,
  BountyEvent,
  BountyExtension,
  EscrowTransaction,
} from "../types.js";
import { taskIdForBounty } from "./taskid.js";
import { assertBountyAmount, stroopsToUsdcNumber, usdcToStroops } from "../stellar/amount.js";
import { assertValidAddress } from "../stellar/scval.js";
import {
  adminRefund,
  adminRelease,
  buildCreateEscrowXdr,
  buildReleaseXdr,
  getEscrow,
  hasUsdcTrustline,
} from "../stellar/escrow.js";
import { parseInvokeContractCall, parseTxSource, sendSignedXdr, type SendResult } from "../stellar/submit.js";
import { pushNotification } from "../notifications.js";
import { enqueueBountyCriteria } from "../queue.js";
import { checkGate, GATES } from "../statsig.js";
import { bountyActor } from "./owner.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The on-chain operations the service depends on. Injectable so the state-machine
// + idempotency tests run without a live chain (they pass a fake).
export type EscrowChain = {
  buildCreateEscrowXdr(
    sponsor: string,
    taskId: string,
    issueUrl: string,
    amountStroops: bigint
  ): Promise<string>;
  buildReleaseXdr(sponsor: string, taskId: string, contributor: string, memo?: string): Promise<string>;
  adminRelease(taskId: string, contributor: string, memo?: string): Promise<SendResult>;
  adminRefund(taskId: string): Promise<SendResult>;
  hasUsdcTrustline(address: string): Promise<boolean>;
  getEscrow(taskId: string): Promise<unknown>;
};

export const defaultChain: EscrowChain = {
  buildCreateEscrowXdr,
  buildReleaseXdr,
  adminRelease,
  adminRefund,
  hasUsdcTrustline,
  getEscrow,
};

// ── small helpers ────────────────────────────────────────────────────────────

export function getBounty(id: string): Bounty | null {
  return db.find("bounties", (b) => b.id === id);
}

/** The DevAsign user row for a bounty's assignee, for notifications. */
export function assigneeUser(b: Bounty) {
  if (b.assigneeGithubId == null) return null;
  return db.find("users", (u) => u.githubId === b.assigneeGithubId);
}

function nextSeq(): number {
  let max = 0;
  for (const b of db.table("bounties")) if (b.seq > max) max = b.seq;
  return max + 1;
}

// Exported: the criteria drafting job (bounties/criteria-job.ts) writes the
// acceptance fields through here so it picks up the updatedAt bump too.
export function patchBounty(id: string, patch: Partial<Bounty>): Bounty | null {
  return db.update("bounties", (b) => b.id === id, { ...patch, updatedAt: Date.now() });
}

function findTxnByKey(key: string): EscrowTransaction | null {
  return db.find("escrowTransactions", (t) => t.idempotencyKey === key);
}

function insertTxn(row: Omit<EscrowTransaction, "id" | "createdAt">): EscrowTransaction {
  return db.insert("escrowTransactions", { id: uuid(), createdAt: Date.now(), ...row });
}

// ── activity log ─────────────────────────────────────────────────────────────
// Every lifecycle moment appends a BountyEvent so the contributor app's
// timeline shows the real history (who did what, when) instead of synthesizing
// it from a handful of timestamps. Append-only; capped as a runaway guard
// (drop-oldest — the recent tail is what the timeline shows anyway).
const EVENT_CAP = 100;

export function recordBountyEvent(
  bountyId: string,
  kind: BountyEvent["kind"],
  opts: {
    actor?: string | null;
    subject?: string | null;
    subjectGithubId?: number | null;
    detail?: string | null;
    at?: number;
  } = {}
): void {
  const b = getBounty(bountyId);
  if (!b) return;
  const event: BountyEvent = {
    at: opts.at ?? Date.now(),
    kind,
    actor: opts.actor ?? null,
    subject: opts.subject ?? null,
    subjectGithubId: opts.subjectGithubId ?? null,
    detail: opts.detail ?? null,
  };
  const events = [...(b.events ?? []), event].slice(-EVENT_CAP);
  patchBounty(bountyId, { events });
}

export type LifecycleResult = { ok: boolean; reason: string; hash?: string; bounty?: Bounty };

/**
 * True once this bounty's money is committed — the acceptance criteria freeze
 * here. Before this point the sponsor may still reword the contract; after it,
 * the list is what every delivered PR gets judged against.
 *
 * Deliberately checks the escrow LEDGER ROW as well as escrowTxHash. A bounty
 * stays PENDING_FUNDING until the keeper confirms, so status alone is far too
 * late; and recordFunding writes the txn row BEFORE it patches the hash, so a
 * partial flush can leave either one alone. recoverOrphanedFunding exists for
 * exactly that failure, and it keys off the row.
 *
 * Mirrors — but deliberately does NOT share — unfundedPendingBounties'
 * predicate below. Adding `|| b.escrowTxHash` there would NARROW orphan
 * recovery (a bounty with a hash but no row would stop being a candidate), and
 * duplicating one db.find is a far better trade than perturbing money-recovery
 * logic.
 *
 * Known gap: an escrow live on-chain with neither hash nor row (a post-restart
 * orphan) stays editable until the keeper adopts it, ~a minute. Closing that
 * would cost a chain read on every edit.
 */
export function acceptanceLocked(b: Bounty): boolean {
  if (b.status !== "PENDING_FUNDING") return true;
  if (b.escrowTxHash) return true;
  return !!db.find(
    "escrowTransactions",
    (t) => t.idempotencyKey === `escrow:${b.taskId}` && t.status !== "failed"
  );
}

// ── creation + funding ───────────────────────────────────────────────────────

export type CreateBountyInput = {
  source: "github" | "linear";
  installationId: number;
  repo: string; // "owner/name"
  issueNumber: number;
  issueUrl: string;
  externalKey?: string | null;
  title: string;
  description?: string;
  acceptance?: string[];
  amountUsdc: number;
  deliveryDays: number;
  sponsorUserId?: string | null;
  // GitHub login of whoever created the bounty (comment author / app user) —
  // only used for the activity log; the comment path otherwise loses it.
  createdByLogin?: string | null;
};

/** Create a PENDING_FUNDING bounty. No chain call — funding is a separate, sponsor-signed step. */
export function createBounty(input: CreateBountyInput): Bounty {
  const amountStroops = usdcToStroops(input.amountUsdc);
  assertBountyAmount(amountStroops);
  const id = uuid();
  const seq = nextSeq();
  const now = Date.now();
  const bounty: Bounty = {
    id,
    seq,
    code: `BNTY-${seq}`,
    source: input.source,
    installationId: input.installationId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    issueUrl: input.issueUrl,
    externalKey: input.externalKey ?? null,
    title: input.title,
    description: input.description ?? "",
    acceptance: input.acceptance ?? [],
    sponsorUserId: input.sponsorUserId ?? null,
    sponsorAddress: null,
    taskId: taskIdForBounty(id),
    contractId: config.stellar.contractId,
    amountStroops: amountStroops.toString(),
    amountUsdc: stroopsToUsdcNumber(amountStroops),
    deliveryDays: input.deliveryDays,
    status: "PENDING_FUNDING",
    onchainStatus: null,
    applications: [],
    assigneeGithubId: null,
    assigneeGithubLogin: null,
    assigneeAddress: null,
    acceptedAt: null,
    deadlineAt: null,
    prNumber: null,
    botCommentId: null,
    escrowTxHash: null,
    payoutTxHash: null,
    refundTxHash: null,
    cancelReason: null,
    pendingOp: null,
    events: [
      {
        at: now,
        kind: "created",
        actor: input.createdByLogin ?? null,
        detail: `${stroopsToUsdcNumber(amountStroops)} USDC · ${input.deliveryDays}-day delivery`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const created = db.insert("bounties", bounty);

  // Draft the acceptance criteria unless the caller already supplied a list.
  // Enqueued HERE rather than at the three call sites so the "generating" flag
  // and the job can never disagree — this is the only writer of `acceptance`.
  //
  // Gated so the rollout can be stopped without a redeploy. The gate is on
  // GENERATION, which is enough: the review pipeline's bounty-seed path only
  // fires when acceptance is non-empty, so an off gate leaves PR verdicts
  // exactly as they are today with no pipeline change at all. Defaults ON when
  // Statsig is unconfigured, so local dev and the test suite still draft.
  if (!input.acceptance?.length && checkGate(bountyActor(created), GATES.bountyCriteriaDrafting, true)) {
    patchBounty(created.id, { acceptanceState: "generating" });
    enqueueBountyCriteria(created.id);
  }
  return getBounty(created.id) ?? created;
}

/** Build the unsigned `create_escrow` XDR the sponsor signs with Freighter. */
export async function buildFundingTx(
  bountyId: string,
  sponsorAddress: string,
  chain: EscrowChain = defaultChain
): Promise<{ ok: boolean; reason: string; xdr?: string }> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "PENDING_FUNDING") return { ok: false, reason: `already_${b.status.toLowerCase()}` };
  assertValidAddress(sponsorAddress);
  const xdr = await chain.buildCreateEscrowXdr(
    sponsorAddress,
    b.taskId,
    b.issueUrl,
    BigInt(b.amountStroops)
  );
  return { ok: true, reason: "built", xdr };
}

/**
 * Record a sponsor-signed funding submission. Idempotent on `escrow:{taskId}`.
 * Keeps the bounty PENDING_FUNDING and records a pending escrow txn — the keeper
 * flips it to OPEN once the funding tx confirms (so an unconfirmed/failed funding
 * never opens an unfunded bounty to applicants).
 */
export function recordFunding(
  bountyId: string,
  sponsorAddress: string,
  send: SendResult
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const key = `escrow:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  const failed = send.status === "error";
  insertTxn({
    bountyId,
    githubLogin: null,
    kind: "escrow",
    idempotencyKey: key,
    signer: "sponsor",
    sourceAccount: sponsorAddress,
    status: failed ? "failed" : "pending",
    hash: send.hash ?? null,
    ledger: null,
    amountStroops: b.amountStroops,
    dir: "out",
    note: `escrow funded by ${sponsorAddress}`,
    error: send.error ?? null,
    confirmedAt: null,
  });
  if (failed) return { ok: false, reason: "send_error", hash: send.hash };
  patchBounty(bountyId, { sponsorAddress, escrowTxHash: send.hash });
  recordBountyEvent(bountyId, "funding_submitted", { actor: "sponsor" });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "submitted", hash: send.hash, bounty: bounty ?? undefined };
}

/**
 * Broadcast a sponsor's Freighter-signed funding tx and record it. The on-chain
 * creator is taken from the signed envelope's source (not client-asserted).
 * Idempotent on `escrow:{taskId}`.
 */
export async function submitFunding(bountyId: string, signedXdr: string): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const existing = findTxnByKey(`escrow:${b.taskId}`);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  // A signed envelope fetched before a cancel must not fund a cancelled bounty.
  if (b.status !== "PENDING_FUNDING") {
    return { ok: false, reason: `already_${b.status.toLowerCase()}` };
  }
  let source: string;
  try {
    source = parseTxSource(signedXdr);
  } catch {
    return { ok: false, reason: "bad_xdr" };
  }
  const send = await sendSignedXdr(signedXdr);
  return recordFunding(bountyId, source, send);
}

/**
 * Reject a sponsor-release envelope that doesn't do EXACTLY what we're about to
 * record. recordSponsorRelease writes the payout row from the bounty's own fields
 * (task, assignee, sponsor) without ever reading the envelope, so a mismatched
 * XDR would let the backend mark THIS bounty paid off some other transaction's
 * hash — e.g. a sponsor of two bounties submitting bounty A's signed release to
 * bounty B. Confirm the decoded call is release(b.taskId, b.assigneeAddress) on
 * b.contractId, sourced by b.sponsorAddress, before broadcasting. Returns the
 * reason to fail with, or null when it matches.
 */
export function releaseEnvelopeMismatch(
  signedXdr: string,
  b: Bounty
): "bad_xdr" | "xdr_mismatch" | null {
  let call;
  try {
    call = parseInvokeContractCall(signedXdr);
  } catch {
    return "bad_xdr";
  }
  // Nothing to match against → refuse rather than record an unverifiable payout.
  if (!b.sponsorAddress || !b.assigneeAddress) return "xdr_mismatch";
  const matches =
    call.source === b.sponsorAddress &&
    call.contractId === b.contractId &&
    call.functionName === "release" &&
    call.args.length === 2 &&
    call.args[0] === b.taskId &&
    call.args[1] === b.assigneeAddress;
  return matches ? null : "xdr_mismatch";
}

/** Broadcast a sponsor's Freighter-signed `release` (in-app approve) and record it. */
export async function submitSponsorRelease(
  bountyId: string,
  signedXdr: string
): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const existing = findTxnByKey(`release:${b.taskId}`);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  if (b.pendingOp) return { ok: false, reason: "in_flight" };
  // Verify the client-signed envelope matches this bounty before broadcasting —
  // the payout row is recorded from b's fields, not the XDR (see the helper).
  const mismatch = releaseEnvelopeMismatch(signedXdr, b);
  if (mismatch) return { ok: false, reason: mismatch };
  const send = await sendSignedXdr(signedXdr);
  return recordSponsorRelease(bountyId, send);
}

/** Discard an unfunded bounty (the bot "Cancel" link). No funds are on-chain yet. */
export function cancelPending(bountyId: string): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "PENDING_FUNDING") return { ok: false, reason: `not_pending_${b.status.toLowerCase()}` };
  patchBounty(bountyId, { status: "CANCELLED", cancelReason: "deleted" });
  recordBountyEvent(bountyId, "cancelled", { detail: "discarded before funding" });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "cancelled", bounty: bounty ?? undefined };
}

// ── applications + delegation ────────────────────────────────────────────────

/** A contributor applies to work a bounty. Idempotent per github login. */
export function applyToBounty(
  bountyId: string,
  applicant: { githubId: number; githubLogin: string; note?: string }
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "OPEN") return { ok: false, reason: `not_open_${b.status.toLowerCase()}` };
  const apps = [...b.applications];
  const idx = apps.findIndex((a) => a.githubId === applicant.githubId);
  if (idx >= 0 && apps[idx].status !== "rejected") {
    return { ok: true, reason: "already_applied" };
  }
  const app: BountyApplication = {
    githubId: applicant.githubId,
    githubLogin: applicant.githubLogin,
    note: applicant.note,
    appliedAt: Date.now(),
    status: "pending",
  };
  if (idx >= 0) apps[idx] = app;
  else apps.push(app);
  patchBounty(bountyId, { applications: apps });
  recordBountyEvent(bountyId, "applied", {
    actor: applicant.githubLogin,
    subject: applicant.githubLogin,
    subjectGithubId: applicant.githubId,
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "applied", bounty: bounty ?? undefined };
}

/**
 * Sponsor approves an application; the contributor may then accept.
 * `actorLogin` (the approving sponsor) is recorded on the activity log — the
 * route layer knows it and previously discarded it.
 */
export function approveApplication(
  bountyId: string,
  githubId: number,
  actorLogin?: string | null
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "OPEN") return { ok: false, reason: `not_open_${b.status.toLowerCase()}` };
  const apps = b.applications.map((a) =>
    a.githubId === githubId
      ? { ...a, status: "approved" as const }
      : a.status === "approved"
        ? { ...a, status: "pending" as const } // only one approved at a time
        : a
  );
  if (!apps.some((a) => a.githubId === githubId && a.status === "approved")) {
    return { ok: false, reason: "no_such_application" };
  }
  patchBounty(bountyId, { applications: apps });
  const applicant = apps.find((a) => a.githubId === githubId);
  recordBountyEvent(bountyId, "application_approved", {
    actor: actorLogin ?? null,
    subject: applicant?.githubLogin ?? null,
    subjectGithubId: githubId,
    detail: applicant ? `@${applicant.githubLogin} picked` : null,
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "approved", bounty: bounty ?? undefined };
}

export function rejectApplication(
  bountyId: string,
  githubId: number,
  actorLogin?: string | null
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const apps = b.applications.map((a) =>
    a.githubId === githubId ? { ...a, status: "rejected" as const } : a
  );
  patchBounty(bountyId, { applications: apps });
  const applicant = apps.find((a) => a.githubId === githubId);
  recordBountyEvent(bountyId, "application_rejected", {
    actor: actorLogin ?? null,
    subject: applicant?.githubLogin ?? null,
    subjectGithubId: githubId,
    detail: applicant ? `@${applicant.githubLogin}'s application` : null,
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "rejected", bounty: bounty ?? undefined };
}

/**
 * A contributor withdraws their own PENDING application (the design's
 * "Withdraw application" CTA). Approved/accepted applications can't be
 * withdrawn this way — that's a conversation with the sponsor.
 */
export function withdrawApplication(
  bountyId: string,
  contributor: { githubId: number; githubLogin: string }
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "OPEN") return { ok: false, reason: `not_open_${b.status.toLowerCase()}` };
  const app = b.applications.find((a) => a.githubId === contributor.githubId);
  if (!app) return { ok: false, reason: "no_such_application" };
  if (app.status !== "pending") return { ok: false, reason: `not_pending_${app.status}` };
  patchBounty(bountyId, {
    applications: b.applications.filter((a) => a.githubId !== contributor.githubId),
  });
  recordBountyEvent(bountyId, "application_withdrawn", {
    actor: contributor.githubLogin,
    subject: contributor.githubLogin,
    subjectGithubId: contributor.githubId,
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "withdrawn", bounty: bounty ?? undefined };
}

/**
 * The approved contributor accepts by providing their payout address. THIS is the
 * moment the delivery clock starts (deadlineAt = now + deliveryDays). Verifies the
 * address is well-formed and can receive USDC (trustline). Links the payout
 * address to the contributor's user so githubLogin ↔ wallet is recorded.
 */
export async function acceptAndStartClock(
  bountyId: string,
  contributor: { githubId: number; githubLogin: string; userId?: string },
  payoutAddress: string,
  payoutMemo: string = "",
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "OPEN") return { ok: false, reason: `not_open_${b.status.toLowerCase()}` };
  const app = b.applications.find((a) => a.githubId === contributor.githubId);
  if (!app || app.status !== "approved") return { ok: false, reason: "not_approved" };
  try {
    assertValidAddress(payoutAddress);
  } catch {
    return { ok: false, reason: "invalid_address" };
  }
  const trustline = await chain.hasUsdcTrustline(payoutAddress);
  if (!trustline) return { ok: false, reason: "no_trustline" };

  const now = Date.now();
  const apps = b.applications.map((a) =>
    a.githubId === contributor.githubId ? { ...a, status: "accepted" as const } : a
  );
  patchBounty(bountyId, {
    status: "DELEGATED",
    applications: apps,
    assigneeGithubId: contributor.githubId,
    assigneeGithubLogin: contributor.githubLogin,
    assigneeAddress: payoutAddress,
    assigneeMemo: payoutMemo || null,
    acceptedAt: now,
    deadlineAt: now + b.deliveryDays * DAY_MS,
  });
  recordBountyEvent(bountyId, "accepted", {
    actor: contributor.githubLogin,
    detail: `${b.deliveryDays}-day delivery clock started`,
    at: now,
  });
  // Persist the payout wallet on the user (links githubLogin ↔ address always).
  if (contributor.userId) {
    db.update("users", (u) => u.id === contributor.userId, {
      stellarPayoutAddress: payoutAddress,
      stellarPayoutMemo: payoutMemo,
      stellarPayoutTrustline: true,
    });
  }
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "delegated", bounty: bounty ?? undefined };
}

/** The contributor opened a PR referencing the bounty issue. */
export function markInReview(bountyId: string, prNumber: number): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  // A webhook-inferred PR link counts as the submission moment too — the
  // contributor app's stage machine and timeline key off submittedAt.
  const isNewLink = b.status !== "IN_REVIEW" || b.prNumber !== prNumber;
  // Skip the write entirely when it would change nothing. GitHub re-delivers
  // `synchronize` on EVERY push to the PR, and patchBounty bumps updatedAt +
  // version unconditionally — so an unguarded patch turns a 20-commit branch
  // into 20 identical row writes. That was merely wasteful before; now that a
  // write drives a live-refresh frame, it would be 20 pushes to every watching
  // client for no semantic change.
  if (isNewLink || !b.submittedAt) {
    patchBounty(bountyId, {
      status: "IN_REVIEW",
      prNumber,
      ...(b.submittedAt ? {} : { submittedAt: Date.now() }),
    });
  }
  if (isNewLink) {
    recordBountyEvent(bountyId, "pr_opened", {
      actor: b.assigneeGithubLogin ?? null,
      detail: `PR #${prNumber}`,
    });
  }
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "in_review", bounty: bounty ?? undefined };
}

// ── timeline extension ───────────────────────────────────────────────────────
// The contributor asks for more delivery time; the sponsor approves or declines.
// Purely an app-DB affair — the contract has no expiry, so no chain call and no
// pendingOp. A pending request HOLDS the keeper's expiry refund (see
// expiredBounties + the refundBounty guard); at most one extension is ever
// approved per bounty.

export const EXTENSION_MAX_DAYS = 7;
export const EXTENSION_REASON_MAX = 500;

export function requestExtension(
  bountyId: string,
  contributor: { githubId: number; githubLogin: string },
  days: number,
  reason: string
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.assigneeGithubId !== contributor.githubId) return { ok: false, reason: "not_assignee" };
  // Pre-submission only. NOTE this is a known gap, not a guarantee: the delivery
  // window is absolute (see expiredBounties), so a contributor whose PR is sitting
  // unreviewed can be refunded out and has no way to buy time. Widening this would
  // combine with the keeper's 24h auto-approval to turn a single day of sponsor
  // silence into a 7-day extension rather than a refund, which is the opposite of
  // the intended behaviour. Revisit when a review SLA exists.
  if (b.status !== "DELEGATED" || b.submittedAt) {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  if (b.pendingOp) return { ok: false, reason: "in_flight" };
  if (!Number.isInteger(days) || days < 1 || days > EXTENSION_MAX_DAYS) {
    return { ok: false, reason: "invalid_days" };
  }
  const trimmed = reason.trim().slice(0, EXTENSION_REASON_MAX);
  if (!trimmed) return { ok: false, reason: "missing_reason" };
  if (b.extension?.status === "pending") return { ok: false, reason: "already_pending" };
  if (b.extension?.status === "approved") return { ok: false, reason: "already_extended" };

  const ext: BountyExtension = {
    days,
    reason: trimmed,
    requestedBy: contributor.githubLogin,
    requestedAt: Date.now(),
    status: "pending",
  };
  patchBounty(bountyId, { extension: ext });
  recordBountyEvent(bountyId, "extension_requested", {
    actor: contributor.githubLogin,
    subject: contributor.githubLogin,
    subjectGithubId: contributor.githubId,
    detail: `${days} day${days === 1 ? "" : "s"} — ${trimmed.slice(0, 140)}`,
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "requested", bounty: bounty ?? undefined };
}

/**
 * Approve or decline a pending extension request. `respondedBy` is the sponsor's
 * githubLogin, or "system" when the keeper auto-approves one the sponsor left
 * unanswered — the deadline math, the event and the at-most-one-approved
 * invariant must stay in ONE place, so the keeper calls through here rather than
 * duplicating them. `opts.at` lets the keeper pass its injected clock.
 */
export function respondToExtension(
  bountyId: string,
  action: "approve" | "decline",
  respondedBy: string,
  opts: { at?: number } = {}
): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const ext = b.extension;
  if (ext?.status !== "pending") return { ok: false, reason: "no_pending_extension" };
  // The contributor may have submitted since requesting — approving then is fine.
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  if (b.pendingOp) return { ok: false, reason: "in_flight" };

  const now = opts.at ?? Date.now();
  if (action === "approve") {
    // Anchor on the OLD deadline, not `now`: the keeper held the refund while
    // the request was pending, so the contributor already consumed any
    // post-expiry time — this grants exactly `days` of total slack no matter
    // how long the sponsor took to respond.
    const newDeadline = (b.deadlineAt ?? now) + ext.days * DAY_MS;
    patchBounty(bountyId, {
      deadlineAt: newDeadline,
      // The clock moved — re-arm the keeper's 24h warning against the NEW deadline.
      deadlineWarnedAt: null,
      extension: { ...ext, status: "approved", respondedBy, respondedAt: now },
    });
    recordBountyEvent(bountyId, "extension_approved", {
      actor: respondedBy,
      subject: b.assigneeGithubLogin ?? ext.requestedBy,
      subjectGithubId: b.assigneeGithubId ?? null,
      detail: `+${ext.days} day${ext.days === 1 ? "" : "s"} — due ${new Date(newDeadline).toISOString().slice(0, 10)}`,
      at: now,
    });
  } else {
    patchBounty(bountyId, {
      extension: { ...ext, status: "declined", respondedBy, respondedAt: now },
    });
    recordBountyEvent(bountyId, "extension_declined", {
      actor: respondedBy,
      subject: b.assigneeGithubLogin ?? ext.requestedBy,
      subjectGithubId: b.assigneeGithubId ?? null,
      at: now,
    });
  }
  const bounty = getBounty(bountyId);
  return { ok: true, reason: action === "approve" ? "approved" : "declined", bounty: bounty ?? undefined };
}

// ── payout + refund (guarded, idempotent, single-flight) ─────────────────────

// Set pendingOp iff clear; returns false if another op is already in flight.
function acquire(bountyId: string, op: NonNullable<Bounty["pendingOp"]>): boolean {
  const b = getBounty(bountyId);
  if (!b || b.pendingOp) return false;
  patchBounty(bountyId, { pendingOp: op });
  return true;
}

function releaseGuard(bountyId: string): void {
  patchBounty(bountyId, { pendingOp: null });
}

/**
 * Release the escrow to the assigned contributor (admin-signed). Drives BOTH
 * payout triggers' merge path and is safe under redelivery: returns early if a
 * `release:{taskId}` txn already exists, and single-flights via pendingOp.
 */
export async function releaseByMerge(
  bountyId: string,
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status === "PAID") return { ok: true, reason: "already_paid" };
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  if (!b.assigneeAddress) return { ok: false, reason: "no_payout_address" };
  const key = `release:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  if (!acquire(bountyId, "releasing")) return { ok: false, reason: "in_flight" };
  let send: SendResult;
  try {
    send = await chain.adminRelease(b.taskId, b.assigneeAddress, b.assigneeMemo ?? "");
  } catch (err) {
    // Same blind spot as refundBounty's throw path — see the note there.
    console.warn(`[bounty] admin_release for ${b.code} (task ${b.taskId}) threw:`, err);
    releaseGuard(bountyId);
    return { ok: false, reason: "chain_error", hash: undefined };
  }
  insertTxn({
    bountyId,
    githubId: b.assigneeGithubId ?? null,
    githubLogin: b.assigneeGithubLogin ?? null,
    kind: "payout",
    idempotencyKey: key,
    signer: "admin",
    sourceAccount: null,
    status: send.status === "error" ? "failed" : "pending",
    hash: send.hash ?? null,
    ledger: null,
    amountStroops: b.amountStroops,
    dir: "out",
    note: `release to @${b.assigneeGithubLogin} on merge`,
    error: send.error ?? null,
    confirmedAt: null,
    destAddress: b.assigneeAddress,
    destMemo: b.assigneeMemo ?? null,
  });
  if (send.status === "error") {
    releaseGuard(bountyId);
    return { ok: false, reason: "send_error", hash: send.hash };
  }
  patchBounty(bountyId, { payoutTxHash: send.hash });
  recordBountyEvent(bountyId, "payout_submitted", {
    actor: "system",
    detail: "release on merge",
  });
  return { ok: true, reason: "submitted", hash: send.hash };
}

/** Build the unsigned `release` XDR for the sponsor's in-app "Approve payment". */
export async function buildSponsorReleaseTx(
  bountyId: string,
  chain: EscrowChain = defaultChain
): Promise<{ ok: boolean; reason: string; xdr?: string }> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  if (!b.assigneeAddress) return { ok: false, reason: "no_payout_address" };
  if (!b.sponsorAddress) return { ok: false, reason: "no_sponsor_address" };
  if (b.pendingOp) return { ok: false, reason: "in_flight" };
  const xdr = await chain.buildReleaseXdr(b.sponsorAddress, b.taskId, b.assigneeAddress, b.assigneeMemo ?? "");
  return { ok: true, reason: "built", xdr };
}

/** Record a sponsor-signed release submission (in-app approve). Idempotent on `release:{taskId}`. */
export function recordSponsorRelease(bountyId: string, send: SendResult): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const key = `release:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  const failed = send.status === "error";
  insertTxn({
    bountyId,
    githubId: b.assigneeGithubId ?? null,
    githubLogin: b.assigneeGithubLogin ?? null,
    kind: "payout",
    idempotencyKey: key,
    signer: "sponsor",
    sourceAccount: b.sponsorAddress ?? null,
    status: failed ? "failed" : "pending",
    hash: send.hash ?? null,
    ledger: null,
    amountStroops: b.amountStroops,
    dir: "out",
    note: `release to @${b.assigneeGithubLogin} (sponsor-approved)`,
    destAddress: b.assigneeAddress ?? null,
    destMemo: b.assigneeMemo ?? null,
    error: send.error ?? null,
    confirmedAt: null,
  });
  if (failed) return { ok: false, reason: "send_error", hash: send.hash };
  patchBounty(bountyId, { payoutTxHash: send.hash, pendingOp: "releasing" });
  recordBountyEvent(bountyId, "payout_submitted", {
    actor: "sponsor",
    detail: "in-app approval",
  });
  return { ok: true, reason: "submitted", hash: send.hash };
}

/**
 * Refund the escrow to the sponsor (admin-signed). Used for an undelegated-delete
 * and for deadline expiry. Idempotent on `refund:{taskId}`, single-flighted.
 * NEVER refund once released or once a contributor has been delegated on-chain —
 * callers pass the reason; state guards below enforce it.
 */
export async function refundBounty(
  bountyId: string,
  reason: BountyCancelReason,
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status === "CANCELLED") return { ok: true, reason: "already_cancelled" };
  if (b.status === "PAID") return { ok: false, reason: "already_paid" };
  // Only refundable states: funded-and-open (delete), or delegated / in-review
  // (expiry, and the "rejected" path — reject-submission deliberately KEEPS the
  // bounty IN_REVIEW, so accept-rejection has to refund from there too).
  const refundable = ["OPEN", "DELEGATED", "IN_REVIEW"];
  if (!refundable.includes(b.status)) return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  // A pending extension request holds the expiry refund until the sponsor
  // responds (belt-and-braces with the expiredBounties predicate — closes the
  // race where a request lands between the sweep's read and this call). Scoped
  // to "expired" so sponsor cancel/delete paths are unaffected.
  if (reason === "expired" && b.extension?.status === "pending") {
    return { ok: false, reason: "extension_pending" };
  }
  const key = `refund:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  if (!acquire(bountyId, "refunding")) return { ok: false, reason: "in_flight" };
  let send: SendResult;
  try {
    send = await chain.adminRefund(b.taskId);
  } catch (err) {
    // Log it: a build/simulate throw is almost always DETERMINISTIC (missing
    // admin account, contract revert, corrupt taskId), so the keeper retries it
    // every tick forever. Without the message the log reads `chain_error` on
    // loop with nothing to act on.
    console.warn(`[bounty] admin_refund for ${b.code} (task ${b.taskId}) threw:`, err);
    releaseGuard(bountyId);
    return { ok: false, reason: "chain_error" };
  }
  insertTxn({
    bountyId,
    githubLogin: null,
    kind: "refund",
    idempotencyKey: key,
    signer: "admin",
    sourceAccount: null,
    status: send.status === "error" ? "failed" : "pending",
    hash: send.hash ?? null,
    ledger: null,
    amountStroops: b.amountStroops,
    dir: "in",
    note: `refund to sponsor (${reason})`,
    error: send.error ?? null,
    confirmedAt: null,
  });
  if (send.status === "error") {
    releaseGuard(bountyId);
    return { ok: false, reason: "send_error", hash: send.hash };
  }
  patchBounty(bountyId, { refundTxHash: send.hash, cancelReason: reason });
  recordBountyEvent(bountyId, "refund_submitted", { actor: "system", detail: reason });
  return { ok: true, reason: "submitted", hash: send.hash };
}

/**
 * Cancel a bounty (the sponsor's Cancel link, or a delete). Refunds the on-chain
 * escrow when one exists. Safe against the two windows where a bounty is
 * PENDING_FUNDING locally while USDC already sits in escrow: a funding tx still
 * confirming (reject, retriable after the keeper's next tick) and an orphaned
 * escrow whose funding record was lost (adopt it, then refund).
 */
export async function cancelBounty(
  bountyId: string,
  reason: BountyCancelReason = "deleted",
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status === "CANCELLED") return { ok: true, reason: "already_cancelled", bounty: b };
  if (b.status === "PAID") return { ok: false, reason: "already_paid" };
  if (b.status === "OPEN") {
    const r = await refundBounty(bountyId, reason, chain);
    return { ...r, bounty: getBounty(bountyId) ?? undefined };
  }
  if (b.status !== "PENDING_FUNDING") return { ok: false, reason: "delegated_cannot_delete" };
  // Never mark CANCELLED while a funding tx is in flight — the keeper confirms
  // it within a tick, after which a retried cancel takes the refund path.
  const escrowRow = findTxnByKey(`escrow:${b.taskId}`);
  if (escrowRow && escrowRow.status === "pending") {
    return { ok: false, reason: "funding_in_flight" };
  }
  // The funding record can be lost while the escrow exists on-chain (the orphan
  // case the keeper also recovers) — ask the chain before discarding. A failed
  // probe aborts: cancelling blind could strand escrowed USDC forever, since
  // orphan recovery only considers PENDING_FUNDING bounties. An injected chain
  // (tests) can always answer; the default chain only when Stellar is configured
  // (when it isn't, nothing can be escrowed on-chain to begin with).
  if (chain !== defaultChain || isStellarConfigured()) {
    let escrow: unknown;
    try {
      escrow = await chain.getEscrow(b.taskId);
    } catch {
      return { ok: false, reason: "chain_error" };
    }
    if (escrow) {
      const adopted = adoptOnchainEscrow(bountyId, escrow);
      if (!adopted.ok) return adopted;
      const r = await refundBounty(bountyId, reason, chain);
      return { ...r, bounty: getBounty(bountyId) ?? undefined };
    }
  }
  return cancelPending(bountyId);
}

/** Sponsor deletes an UNDELEGATED bounty → refund. Delegated bounties can't be deleted. */
export async function deleteBounty(
  bountyId: string,
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  return cancelBounty(bountyId, "deleted", chain);
}

// ── reconciliation (driven by the keeper) ────────────────────────────────────

export function pendingTxns(): EscrowTransaction[] {
  return db.filter("escrowTransactions", (t) => t.status === "pending");
}

/**
 * PENDING_FUNDING bounties with no live (pending/confirmed) escrow txn row.
 * Most are simply not funded yet — but one whose funding-submit broadcast the
 * create_escrow tx and then lost the recorded row before it became durable
 * (flush failing + restart) looks identical locally while USDC already sits in
 * escrow on-chain. The keeper checks these against the chain and adopts the
 * escrow when it exists; a `failed` row does NOT exclude a bounty, because an
 * aged-out "not included" verdict can be wrong about a tx that later landed.
 */
export function unfundedPendingBounties(): Bounty[] {
  return db.filter(
    "bounties",
    (b) =>
      b.status === "PENDING_FUNDING" &&
      !db.find(
        "escrowTransactions",
        (t) => t.idempotencyKey === `escrow:${b.taskId}` && t.status !== "failed"
      )
  );
}

// Best-effort creator address from a get_escrow record (scValToNative shape).
function escrowCreator(escrow: unknown): string | null {
  const c = (escrow as { creator?: unknown } | null)?.creator;
  if (typeof c !== "string") return null;
  try {
    assertValidAddress(c);
    return c;
  } catch {
    return null;
  }
}

/**
 * Adopt an escrow that exists on-chain for a bounty still PENDING_FUNDING with
 * no local record of the funding tx (the record was lost before it became
 * durable). Repairs/creates the confirmed escrow txn row and opens the bounty.
 * The tx hash is unknown — the row that held it is what was lost — so the row
 * carries a recovery note instead.
 */
export function adoptOnchainEscrow(bountyId: string, escrow: unknown): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "PENDING_FUNDING") return { ok: true, reason: `already_${b.status.toLowerCase()}` };
  const key = `escrow:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    // A live row exists — the normal confirm path owns this bounty.
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  const creator = escrowCreator(escrow);
  const note = "escrow recovered from on-chain state (local funding record was lost)";
  if (existing) {
    db.update("escrowTransactions", (t) => t.id === existing.id, {
      status: "confirmed",
      error: null,
      note,
      confirmedAt: Date.now(),
    });
  } else {
    insertTxn({
      bountyId,
      githubLogin: null,
      kind: "escrow",
      idempotencyKey: key,
      signer: "sponsor",
      sourceAccount: creator ?? b.sponsorAddress,
      status: "confirmed",
      hash: null,
      ledger: null,
      amountStroops: b.amountStroops,
      dir: "out",
      note,
      error: null,
      confirmedAt: Date.now(),
    });
  }
  patchBounty(bountyId, {
    status: "OPEN",
    onchainStatus: "Open",
    ...(creator ? { sponsorAddress: creator } : {}),
    // An aged-out "failed" verdict cleared escrowTxHash on the bounty; the row
    // we just flipped back to confirmed still holds the hash — restore it.
    ...(existing?.hash ? { escrowTxHash: existing.hash } : {}),
  });
  recordBountyEvent(bountyId, "funded", {
    actor: "system",
    detail: "recovered from on-chain state",
  });
  const bounty = getBounty(bountyId);
  return { ok: true, reason: "recovered", bounty: bounty ?? undefined };
}

/**
 * Bounties whose delivery clock has elapsed and should be refunded to the sponsor.
 *
 * The delivery window is ABSOLUTE: submission does not stop the clock. If the work
 * has not been accepted and paid by the deadline, the escrow goes back to the
 * sponsor whether or not a PR was opened — hence DELEGATED *and* IN_REVIEW.
 *
 * Known gap, accepted deliberately: a sponsor who sits on a review runs the window
 * out and gets refunded while keeping the work, and the contributor cannot buy time
 * (requestExtension is pre-submission only). The alternative — exempting IN_REVIEW —
 * was tried and is worse: a silent sponsor then freezes the escrow forever with no
 * escape hatch at all. Fixing this properly needs a review SLA — some bound on how
 * long a sponsor may sit on a submission — which does not exist yet. Until it does,
 * expiry wins.
 *
 * The remaining clauses are what keep a legitimately-settling bounty safe: an op in
 * flight, a pending extension request, or an existing on-chain release.
 */
export function expiredBounties(now = Date.now()): Bounty[] {
  return db.filter(
    "bounties",
    (b) =>
      (b.status === "DELEGATED" || b.status === "IN_REVIEW") &&
      !b.pendingOp &&
      // A pending extension request holds the refund until the sponsor responds.
      b.extension?.status !== "pending" &&
      typeof b.deadlineAt === "number" &&
      b.deadlineAt < now &&
      // never refund a bounty already released on-chain
      !db.find("escrowTransactions", (t) => t.idempotencyKey === `release:${b.taskId}` && t.status !== "failed")
  );
}

// Silence past this counts as consent. A pending request HOLDS the expiry refund
// (expiredBounties + the refundBounty guard), so a sponsor who simply never
// answers would freeze the contributor's deadline — and their own escrow — forever.
// Every user-facing string that quotes this window derives its number from here.
export const EXTENSION_AUTO_APPROVE_MS = DAY_MS;

/** The auto-approve window in whole hours, for copy that has to name it. */
export const EXTENSION_AUTO_APPROVE_HOURS = Math.round(EXTENSION_AUTO_APPROVE_MS / (60 * 60 * 1000));

/** Pending extension requests the sponsor has left unanswered past the auto-approve window. */
export function staleExtensionRequests(now = Date.now()): Bounty[] {
  return db.filter(
    "bounties",
    (b) =>
      b.extension?.status === "pending" &&
      // The same statuses respondToExtension accepts — a contributor may have
      // submitted since requesting, and that request must still resolve so the
      // sponsor's pending card stops showing forever.
      (b.status === "DELEGATED" || b.status === "IN_REVIEW") &&
      !b.pendingOp &&
      typeof b.extension.requestedAt === "number" &&
      now - b.extension.requestedAt >= EXTENSION_AUTO_APPROVE_MS
  );
}

export const DEADLINE_WARNING_MS = DAY_MS; // one-shot bell 24h before the window closes

/**
 * Assigned bounties in the final 24h of the delivery window that haven't been
 * warned yet. Mirrors expiredBounties on status deliberately — anything the sweep
 * can refund should get a heads-up first, INCLUDING submitted work: a contributor
 * whose PR is waiting on the sponsor is the one with the most to lose and the
 * least recourse, so silence there is the worst outcome. The caller varies the
 * wording on submittedAt, since "submit your PR" is nonsense to someone who has.
 *
 * A pending extension is skipped — the refund really is held then, so a warning
 * would be false, and an approval re-arms the stamp so they still get a fresh one
 * against the new deadline.
 */
export function bountiesNearingDeadline(now = Date.now()): Bounty[] {
  return db.filter(
    "bounties",
    (b) =>
      (b.status === "DELEGATED" || b.status === "IN_REVIEW") &&
      !b.pendingOp &&
      b.extension?.status !== "pending" &&
      b.deadlineWarnedAt == null && // == null: undefined on rows written before the field existed
      b.assigneeGithubId != null &&
      typeof b.deadlineAt === "number" &&
      b.deadlineAt > now && // already-expired belongs to the sweep, not here
      b.deadlineAt - now <= DEADLINE_WARNING_MS
  );
}

/**
 * Apply the confirmed/failed outcome of a submitted tx to its bounty. Called by
 * the keeper after a getTransaction poll. Advances the app state machine:
 *   escrow  confirmed → OPEN (funded)         | failed → back to PENDING_FUNDING
 *   payout  confirmed → PAID                   | failed → clear guard, stay pre-paid
 *   refund  confirmed → CANCELLED              | failed → clear guard, stay pre-refund
 * An escrow confirm on an already-CANCELLED bounty (cancel raced the funding
 * broadcast) reopens it and auto-submits a refund so the funds can't strand.
 */
export async function applyTxnOutcome(
  txnId: string,
  outcome: { status: "success"; ledger?: number } | { status: "failed"; error: string },
  chain: EscrowChain = defaultChain
): Promise<void> {
  const txn = db.find("escrowTransactions", (t) => t.id === txnId);
  if (!txn || txn.status !== "pending") return;
  const b = txn.bountyId ? getBounty(txn.bountyId) : null;
  if (outcome.status === "success") {
    db.update("escrowTransactions", (t) => t.id === txnId, {
      status: "confirmed",
      ledger: outcome.ledger ?? null,
      confirmedAt: Date.now(),
    });
    if (!b) return;
    if (txn.kind === "escrow") {
      if (b.status === "PENDING_FUNDING") {
        patchBounty(b.id, { status: "OPEN", onchainStatus: "Open" });
        recordBountyEvent(b.id, "funded", { actor: "system", detail: "escrow confirmed on-chain" });
      } else if (b.status === "CANCELLED") {
        // The bounty was cancelled while this funding tx was in flight (the
        // sub-second submitFunding race): the escrow IS funded on-chain, so
        // reconcile to OPEN and honor the cancel by refunding immediately —
        // leaving it CANCELLED would strand the sponsor's USDC, since orphan
        // recovery only considers PENDING_FUNDING bounties.
        patchBounty(b.id, { status: "OPEN", onchainStatus: "Open" });
        const refund = await refundBounty(b.id, "deleted", chain);
        if (!refund.ok) {
          // Stays OPEN — truthful (it is funded), and the sponsor's Cancel
          // button works on OPEN, so a failed auto-refund is retriable.
          console.warn(`[bounty] auto-refund after late funding confirm on ${b.code}: ${refund.reason}`);
        }
      }
    } else if (txn.kind === "payout") {
      patchBounty(b.id, { status: "PAID", onchainStatus: "Completed", pendingOp: null });
      recordBountyEvent(b.id, "paid", {
        actor: "system",
        detail: `${b.amountUsdc} USDC released to @${b.assigneeGithubLogin ?? "contributor"}`,
      });
      // Tell the contributor the money moved — the contributor app's wallet page.
      if (b.assigneeGithubId != null) {
        const dev = assigneeUser(b);
        if (dev) {
          pushNotification(
            dev.id,
            "bounty",
            `${b.code} paid out — ${b.amountUsdc} USDC`,
            `${b.repo}#${b.issueNumber} — sent to your registered wallet`,
            { link: "/wallet" }
          );
        }
      }
    } else if (txn.kind === "refund") {
      patchBounty(b.id, { status: "CANCELLED", onchainStatus: "Cancelled", pendingOp: null });
      recordBountyEvent(b.id, "refunded", {
        actor: "system",
        detail: b.cancelReason ?? null,
      });
      // A contributor who had this bounty assigned just lost it — to the delivery
      // deadline elapsing, or to the sponsor cancelling. Both arrive here, and
      // both were previously silent: their dashboard simply stopped showing the
      // work with no explanation. Word it from the reason so it isn't a mystery.
      if (b.assigneeGithubId != null) {
        const dev = assigneeUser(b);
        if (dev) {
          const expired = b.cancelReason === "expired";
          // Say so explicitly when they DID deliver: "the delivery window closed"
          // alone reads as though they never submitted, which is a bad thing to
          // tell someone who shipped and lost the bounty to review latency.
          const title = expired
            ? b.submittedAt
              ? `${b.code} expired — the window closed while your work was in review`
              : `${b.code} expired — the delivery window closed`
            : `${b.code} was cancelled`;
          pushNotification(dev.id, "bounty", title, `${b.repo}#${b.issueNumber} — ${b.title}`, {
            link: "/dashboard",
          });
        }
      }
    }
    return;
  }
  // failed
  db.update("escrowTransactions", (t) => t.id === txnId, {
    status: "failed",
    error: outcome.error,
    confirmedAt: Date.now(),
  });
  if (!b) return;
  if (txn.kind === "escrow") {
    patchBounty(b.id, { escrowTxHash: null }); // stays PENDING_FUNDING; sponsor can retry
  } else if (txn.kind === "payout") {
    patchBounty(b.id, { payoutTxHash: null, pendingOp: null }); // stays pre-paid; retryable
  } else if (txn.kind === "refund") {
    patchBounty(b.id, { refundTxHash: null, pendingOp: null }); // stays pre-refund; retryable
  }
}

/**
 * Re-broadcast a still-pending ADMIN-signed tx the network appears to have dropped
 * (the keeper saw not_found past the tx's timebounds). Admin txns rebuild from the
 * bounty with no user signature, so we build+sign+send a FRESH envelope — new
 * sequence, fresh timebounds, new hash — and repoint the existing row at the new
 * hash. NEVER inserts a row (stays idempotent on the same idempotencyKey), and the
 * contract's own double-settle guard makes a redundant broadcast a chain no-op, so
 * this can never double-refund / double-pay. Sponsor-signed txns are excluded —
 * their signing key lives in the sponsor's Freighter wallet and can't be rebuilt
 * server-side, so they keep aging out to `failed` for user retry / orphan recovery.
 */
export async function resubmitAdminTxn(
  txnId: string,
  chain: EscrowChain = defaultChain
): Promise<LifecycleResult> {
  const txn = db.find("escrowTransactions", (t) => t.id === txnId);
  if (!txn || txn.status !== "pending" || txn.signer !== "admin") {
    return { ok: false, reason: "not_resubmittable" };
  }
  const b = txn.bountyId ? getBounty(txn.bountyId) : null;
  if (!b) return { ok: false, reason: "not_found" };
  let send: SendResult;
  try {
    if (txn.kind === "refund") {
      send = await chain.adminRefund(b.taskId);
    } else if (txn.kind === "payout" && b.assigneeAddress) {
      send = await chain.adminRelease(b.taskId, b.assigneeAddress);
    } else {
      return { ok: false, reason: "not_resubmittable" };
    }
  } catch {
    // Rebuild/simulate failed (RPC down, or the escrow already settled → contract
    // revert). Leave the row pending; the keeper's age-out is the final backstop.
    return { ok: false, reason: "chain_error" };
  }
  if (send.status === "error") return { ok: false, reason: "send_error", hash: send.hash };
  db.update("escrowTransactions", (t) => t.id === txnId, { hash: send.hash, error: null });
  patchBounty(b.id, txn.kind === "refund" ? { refundTxHash: send.hash } : { payoutTxHash: send.hash });
  return { ok: true, reason: "resubmitted", hash: send.hash };
}
