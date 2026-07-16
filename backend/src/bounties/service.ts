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
import type { Bounty, BountyApplication, BountyCancelReason, EscrowTransaction } from "../types.js";
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
import { parseTxSource, sendSignedXdr, type SendResult } from "../stellar/submit.js";

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
  buildReleaseXdr(sponsor: string, taskId: string, contributor: string): Promise<string>;
  adminRelease(taskId: string, contributor: string): Promise<SendResult>;
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

function nextSeq(): number {
  let max = 0;
  for (const b of db.table("bounties")) if (b.seq > max) max = b.seq;
  return max + 1;
}

function patchBounty(id: string, patch: Partial<Bounty>): Bounty | null {
  return db.update("bounties", (b) => b.id === id, { ...patch, updatedAt: Date.now() });
}

function findTxnByKey(key: string): EscrowTransaction | null {
  return db.find("escrowTransactions", (t) => t.idempotencyKey === key);
}

function insertTxn(row: Omit<EscrowTransaction, "id" | "createdAt">): EscrowTransaction {
  return db.insert("escrowTransactions", { id: uuid(), createdAt: Date.now(), ...row });
}

export type LifecycleResult = { ok: boolean; reason: string; hash?: string; bounty?: Bounty };

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
    createdAt: now,
    updatedAt: now,
  };
  return db.insert("bounties", bounty);
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
  const bounty = patchBounty(bountyId, { sponsorAddress, escrowTxHash: send.hash });
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
  const send = await sendSignedXdr(signedXdr);
  return recordSponsorRelease(bountyId, send);
}

/** Discard an unfunded bounty (the bot "Cancel" link). No funds are on-chain yet. */
export function cancelPending(bountyId: string): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "PENDING_FUNDING") return { ok: false, reason: `not_pending_${b.status.toLowerCase()}` };
  const bounty = patchBounty(bountyId, { status: "CANCELLED", cancelReason: "deleted" });
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
  const bounty = patchBounty(bountyId, { applications: apps });
  return { ok: true, reason: "applied", bounty: bounty ?? undefined };
}

/** Sponsor approves an application; the contributor may then accept. */
export function approveApplication(bountyId: string, githubId: number): LifecycleResult {
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
  const bounty = patchBounty(bountyId, { applications: apps });
  return { ok: true, reason: "approved", bounty: bounty ?? undefined };
}

export function rejectApplication(bountyId: string, githubId: number): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  const apps = b.applications.map((a) =>
    a.githubId === githubId ? { ...a, status: "rejected" as const } : a
  );
  const bounty = patchBounty(bountyId, { applications: apps });
  return { ok: true, reason: "rejected", bounty: bounty ?? undefined };
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
  const bounty = patchBounty(bountyId, {
    status: "DELEGATED",
    applications: apps,
    assigneeGithubId: contributor.githubId,
    assigneeGithubLogin: contributor.githubLogin,
    assigneeAddress: payoutAddress,
    acceptedAt: now,
    deadlineAt: now + b.deliveryDays * DAY_MS,
  });
  // Persist the payout wallet on the user (links githubLogin ↔ address always).
  if (contributor.userId) {
    db.update("users", (u) => u.id === contributor.userId, {
      stellarPayoutAddress: payoutAddress,
      stellarPayoutTrustline: true,
    });
  }
  return { ok: true, reason: "delegated", bounty: bounty ?? undefined };
}

/** The contributor opened a PR referencing the bounty issue. */
export function markInReview(bountyId: string, prNumber: number): LifecycleResult {
  const b = getBounty(bountyId);
  if (!b) return { ok: false, reason: "not_found" };
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  }
  const bounty = patchBounty(bountyId, { status: "IN_REVIEW", prNumber });
  return { ok: true, reason: "in_review", bounty: bounty ?? undefined };
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
    send = await chain.adminRelease(b.taskId, b.assigneeAddress);
  } catch (err) {
    releaseGuard(bountyId);
    return { ok: false, reason: "chain_error", hash: undefined };
  }
  insertTxn({
    bountyId,
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
  });
  if (send.status === "error") {
    releaseGuard(bountyId);
    return { ok: false, reason: "send_error", hash: send.hash };
  }
  patchBounty(bountyId, { payoutTxHash: send.hash });
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
  const xdr = await chain.buildReleaseXdr(b.sponsorAddress, b.taskId, b.assigneeAddress);
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
    error: send.error ?? null,
    confirmedAt: null,
  });
  if (failed) return { ok: false, reason: "send_error", hash: send.hash };
  patchBounty(bountyId, { payoutTxHash: send.hash, pendingOp: "releasing" });
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
  // Only refundable states: funded-and-open (delete) or delegated/in-review (expiry).
  const refundable = ["OPEN", "DELEGATED", "IN_REVIEW"];
  if (!refundable.includes(b.status)) return { ok: false, reason: `bad_status_${b.status.toLowerCase()}` };
  const key = `refund:${b.taskId}`;
  const existing = findTxnByKey(key);
  if (existing && existing.status !== "failed") {
    return { ok: true, reason: `already_${existing.status}`, hash: existing.hash ?? undefined };
  }
  if (!acquire(bountyId, "refunding")) return { ok: false, reason: "in_flight" };
  let send: SendResult;
  try {
    send = await chain.adminRefund(b.taskId);
  } catch {
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
  if (b.status === "OPEN") return refundBounty(bountyId, reason, chain);
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
      return refundBounty(bountyId, reason, chain);
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
  const bounty = patchBounty(bountyId, {
    status: "OPEN",
    onchainStatus: "Open",
    ...(creator ? { sponsorAddress: creator } : {}),
    // An aged-out "failed" verdict cleared escrowTxHash on the bounty; the row
    // we just flipped back to confirmed still holds the hash — restore it.
    ...(existing?.hash ? { escrowTxHash: existing.hash } : {}),
  });
  return { ok: true, reason: "recovered", bounty: bounty ?? undefined };
}

/** Bounties whose delivery clock has elapsed and should be refunded to the sponsor. */
export function expiredBounties(now = Date.now()): Bounty[] {
  return db.filter(
    "bounties",
    (b) =>
      (b.status === "DELEGATED" || b.status === "IN_REVIEW") &&
      !b.pendingOp &&
      typeof b.deadlineAt === "number" &&
      b.deadlineAt < now &&
      // never refund a bounty already released on-chain
      !db.find("escrowTransactions", (t) => t.idempotencyKey === `release:${b.taskId}` && t.status !== "failed")
  );
}

/**
 * Apply the confirmed/failed outcome of a submitted tx to its bounty. Called by
 * the keeper after a getTransaction poll. Advances the app state machine:
 *   escrow  confirmed → OPEN (funded)         | failed → back to PENDING_FUNDING
 *   payout  confirmed → PAID                   | failed → clear guard, stay pre-paid
 *   refund  confirmed → CANCELLED              | failed → clear guard, stay pre-refund
 */
export function applyTxnOutcome(
  txnId: string,
  outcome: { status: "success"; ledger?: number } | { status: "failed"; error: string }
): void {
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
      // Only advance from PENDING_FUNDING — a late funding confirm must never
      // resurrect a bounty that was cancelled in the interim.
      if (b.status === "PENDING_FUNDING") {
        patchBounty(b.id, { status: "OPEN", onchainStatus: "Open" });
      }
    } else if (txn.kind === "payout") {
      patchBounty(b.id, { status: "PAID", onchainStatus: "Completed", pendingOp: null });
    } else if (txn.kind === "refund") {
      patchBounty(b.id, { status: "CANCELLED", onchainStatus: "Cancelled", pendingOp: null });
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
