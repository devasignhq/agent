// Bounty lifecycle state machine + idempotency. The load-bearing guarantees:
// the two payout triggers can't double-pay, delete+expiry can't double-refund,
// and every transition enforces its precondition. Runs against the in-memory
// store with a fake chain (no network). Run:
//   node --import tsx/esm --test src/bounties/service.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import type { EscrowTransaction } from "../types.js";
import {
  createBounty,
  recordFunding,
  cancelPending,
  cancelBounty,
  applyToBounty,
  approveApplication,
  acceptAndStartClock,
  markInReview,
  releaseByMerge,
  refundBounty,
  deleteBounty,
  getBounty,
  applyTxnOutcome,
  expiredBounties,
  type EscrowChain,
} from "./service.js";

const ADDR = () => Keypair.random().publicKey();

function fakeChain(overrides: Partial<EscrowChain> = {}) {
  const calls = { adminRelease: 0, adminRefund: 0, hasUsdcTrustline: 0, build: 0 };
  const chain: EscrowChain = {
    async buildCreateEscrowXdr() {
      calls.build++;
      return "XDR_CREATE";
    },
    async buildReleaseXdr() {
      calls.build++;
      return "XDR_RELEASE";
    },
    async adminRelease() {
      calls.adminRelease++;
      return { hash: `H_REL_${calls.adminRelease}`, status: "pending" };
    },
    async adminRefund() {
      calls.adminRefund++;
      return { hash: `H_REF_${calls.adminRefund}`, status: "pending" };
    },
    async hasUsdcTrustline() {
      calls.hasUsdcTrustline++;
      return true;
    },
    async getEscrow() {
      return null;
    },
    ...overrides,
  };
  return { chain, calls };
}

function mkBounty(amountUsdc = 100, deliveryDays = 2) {
  return createBounty({
    source: "github",
    installationId: 42,
    repo: "acme/app",
    issueNumber: 7,
    issueUrl: "https://github.com/acme/app/issues/7",
    title: "Fix the thing",
    amountUsdc,
    deliveryDays,
  });
}

function txnByKey(key: string): EscrowTransaction | null {
  return db.find("escrowTransactions", (t) => t.idempotencyKey === key);
}

// Drive a bounty to OPEN (funded + confirmed).
function fundAndConfirm(bountyId: string) {
  const b = getBounty(bountyId)!;
  recordFunding(bountyId, ADDR(), { hash: "H_ESCROW", status: "pending" });
  const txn = txnByKey(`escrow:${b.taskId}`)!;
  applyTxnOutcome(txn.id, { status: "success", ledger: 1 });
}

// Drive a bounty from OPEN to DELEGATED via apply → approve → accept.
async function delegate(bountyId: string, chain: EscrowChain) {
  applyToBounty(bountyId, { githubId: 999, githubLogin: "dev" });
  approveApplication(bountyId, 999);
  return acceptAndStartClock(bountyId, { githubId: 999, githubLogin: "dev" }, ADDR(), chain);
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("users", () => true);
});

test("createBounty starts PENDING_FUNDING with correct derived fields", () => {
  const b = mkBounty(100, 2);
  assert.equal(b.status, "PENDING_FUNDING");
  assert.equal(b.amountStroops, "1000000000"); // 100 * 1e7
  assert.equal(b.amountUsdc, 100);
  assert.equal(b.taskId.length, 25);
  assert.match(b.code, /^BNTY-\d+$/);
  assert.equal(b.deliveryDays, 2);
});

test("cancelPending discards an unfunded bounty", () => {
  const b = mkBounty();
  const r = cancelPending(b.id);
  assert.equal(r.ok, true);
  assert.equal(getBounty(b.id)!.status, "CANCELLED");
  // Can't cancel again (not pending anymore).
  assert.equal(cancelPending(b.id).ok, false);
});

test("happy path: fund → open → delegate → merge-release → paid", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty(100, 2);

  fundAndConfirm(b.id);
  assert.equal(getBounty(b.id)!.status, "OPEN");
  assert.equal(getBounty(b.id)!.onchainStatus, "Open");

  const del = await delegate(b.id, chain);
  assert.equal(del.ok, true);
  const delegated = getBounty(b.id)!;
  assert.equal(delegated.status, "DELEGATED");
  assert.equal(delegated.assigneeGithubLogin, "dev");
  assert.ok(delegated.deadlineAt && delegated.deadlineAt > Date.now());

  markInReview(b.id, 123);
  assert.equal(getBounty(b.id)!.status, "IN_REVIEW");

  const rel = await releaseByMerge(b.id, chain);
  assert.equal(rel.ok, true);
  assert.equal(calls.adminRelease, 1);
  assert.equal(getBounty(b.id)!.pendingOp, "releasing");

  // Confirm the payout tx → PAID.
  const payout = txnByKey(`release:${b.taskId}`)!;
  applyTxnOutcome(payout.id, { status: "success", ledger: 2 });
  const paid = getBounty(b.id)!;
  assert.equal(paid.status, "PAID");
  assert.equal(paid.onchainStatus, "Completed");
  assert.equal(paid.pendingOp, null);
});

test("no double-pay: merge fired twice + already-paid", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty();
  fundAndConfirm(b.id);
  await delegate(b.id, chain);

  const r1 = await releaseByMerge(b.id, chain);
  assert.equal(r1.ok, true);
  // Second call while pending → idempotent, does NOT resubmit.
  const r2 = await releaseByMerge(b.id, chain);
  assert.equal(r2.reason, "already_pending");
  assert.equal(calls.adminRelease, 1);

  // Confirm → PAID, then a late merge is a no-op.
  applyTxnOutcome(txnByKey(`release:${b.taskId}`)!.id, { status: "success" });
  const r3 = await releaseByMerge(b.id, chain);
  assert.equal(r3.reason, "already_paid");
  assert.equal(calls.adminRelease, 1);
});

test("release requires a delegated bounty with a payout address", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty();
  fundAndConfirm(b.id);
  // OPEN, no assignee yet → refuse.
  const r = await releaseByMerge(b.id, chain);
  assert.equal(r.ok, false);
  assert.equal(calls.adminRelease, 0);
});

test("accept refuses without an approved application, bad address, or no trustline", async () => {
  const b = mkBounty();
  fundAndConfirm(b.id);

  // Not approved yet.
  applyToBounty(b.id, { githubId: 1, githubLogin: "dev" });
  let r = await acceptAndStartClock(b.id, { githubId: 1, githubLogin: "dev" }, ADDR(), fakeChain().chain);
  assert.equal(r.reason, "not_approved");

  // Approved but malformed address.
  approveApplication(b.id, 1);
  r = await acceptAndStartClock(b.id, { githubId: 1, githubLogin: "dev" }, "not-an-address", fakeChain().chain);
  assert.equal(r.reason, "invalid_address");

  // Approved, valid address, but no USDC trustline.
  const noTrust = fakeChain({ async hasUsdcTrustline() { return false; } });
  r = await acceptAndStartClock(b.id, { githubId: 1, githubLogin: "dev" }, ADDR(), noTrust.chain);
  assert.equal(r.reason, "no_trustline");
  assert.equal(getBounty(b.id)!.status, "OPEN"); // unchanged
});

test("delete: undelegated refunds once; delegated cannot be deleted", async () => {
  const { chain, calls } = fakeChain();

  // Undelegated (OPEN) → refund submitted once, idempotent on retry.
  const b1 = mkBounty();
  fundAndConfirm(b1.id);
  const d1 = await deleteBounty(b1.id, chain);
  assert.equal(d1.ok, true);
  assert.equal(d1.bounty?.status, "OPEN"); // refund submitted, not yet confirmed
  assert.equal(d1.bounty?.pendingOp, "refunding");
  const d2 = await deleteBounty(b1.id, chain);
  assert.equal(d2.reason, "already_pending");
  assert.equal(calls.adminRefund, 1);

  // Delegated → cannot delete.
  const b2 = mkBounty();
  fundAndConfirm(b2.id);
  await delegate(b2.id, chain);
  const d3 = await deleteBounty(b2.id, chain);
  assert.equal(d3.ok, false);
  assert.equal(d3.reason, "delegated_cannot_delete");
  assert.equal(calls.adminRefund, 1); // unchanged
});

test("cancelBounty: unfunded → plain cancel, no refund submitted", async () => {
  const { chain, calls } = fakeChain(); // getEscrow → null
  const b = mkBounty();
  const r = await cancelBounty(b.id, "deleted", chain);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "cancelled");
  assert.equal(getBounty(b.id)!.status, "CANCELLED");
  assert.equal(calls.adminRefund, 0);
  assert.equal(txnByKey(`refund:${b.taskId}`), null);
  // Replaying the cancel link is an idempotent success.
  const again = await cancelBounty(b.id, "deleted", chain);
  assert.equal(again.ok, true);
  assert.equal(again.reason, "already_cancelled");
});

test("cancelBounty: funded (OPEN) → refund submitted once, idempotent on replay", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty();
  fundAndConfirm(b.id);
  const r = await cancelBounty(b.id, "deleted", chain);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "submitted");
  assert.equal(calls.adminRefund, 1);
  const row = txnByKey(`refund:${b.taskId}`)!;
  assert.equal(row.status, "pending");
  assert.equal(getBounty(b.id)!.pendingOp, "refunding");

  const replay = await cancelBounty(b.id, "deleted", chain);
  assert.equal(replay.reason, "already_pending");
  assert.equal(calls.adminRefund, 1);

  // Keeper confirms the refund → CANCELLED.
  applyTxnOutcome(row.id, { status: "success", ledger: 3 });
  const after = getBounty(b.id)!;
  assert.equal(after.status, "CANCELLED");
  assert.equal(after.onchainStatus, "Cancelled");
  assert.equal(after.pendingOp, null);
});

test("cancelBounty: funding in flight → retriable refusal, then refund after confirm", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" }); // not confirmed yet

  const r = await cancelBounty(b.id, "deleted", chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "funding_in_flight");
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING"); // NOT cancelled — funds are in flight
  assert.equal(calls.adminRefund, 0);

  // Keeper confirms the funding → OPEN; the retried cancel now refunds.
  applyTxnOutcome(txnByKey(`escrow:${b.taskId}`)!.id, { status: "success" });
  const retry = await cancelBounty(b.id, "deleted", chain);
  assert.equal(retry.reason, "submitted");
  assert.equal(calls.adminRefund, 1);
});

test("cancelBounty: orphaned on-chain escrow is adopted and refunded, not discarded", async () => {
  const creator = ADDR();
  const { chain, calls } = fakeChain({ async getEscrow() { return { creator }; } });
  const b = mkBounty();
  // PENDING_FUNDING, no txn row — but the escrow exists on-chain (lost record).
  const r = await cancelBounty(b.id, "deleted", chain);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "submitted");
  assert.equal(calls.adminRefund, 1);
  const escrowRow = txnByKey(`escrow:${b.taskId}`)!;
  assert.equal(escrowRow.status, "confirmed"); // adopted
  assert.equal(txnByKey(`refund:${b.taskId}`)!.status, "pending");
});

test("cancelBounty: chain probe failure aborts — never cancel blind", async () => {
  const { chain, calls } = fakeChain({ async getEscrow() { throw new Error("rpc down"); } });
  const b = mkBounty();
  const r = await cancelBounty(b.id, "deleted", chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "chain_error");
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING"); // unchanged, retriable
  assert.equal(calls.adminRefund, 0);
});

test("a late escrow confirm on a cancelled bounty auto-refunds instead of stranding funds", async () => {
  const { chain, calls } = fakeChain();
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" });
  // Cancel lands in the sub-second window between broadcast and recordFunding.
  db.update("bounties", (x) => x.id === b.id, { status: "CANCELLED", cancelReason: "deleted" });
  await applyTxnOutcome(txnByKey(`escrow:${b.taskId}`)!.id, { status: "success" }, chain);

  // The escrow IS funded on-chain: reconciled to OPEN and a refund submitted.
  assert.equal(txnByKey(`escrow:${b.taskId}`)!.status, "confirmed");
  assert.equal(calls.adminRefund, 1);
  const mid = getBounty(b.id)!;
  assert.equal(mid.status, "OPEN");
  assert.equal(mid.pendingOp, "refunding");
  const refund = txnByKey(`refund:${b.taskId}`)!;
  assert.equal(refund.status, "pending");

  // Refund confirms → CANCELLED for good.
  await applyTxnOutcome(refund.id, { status: "success" }, chain);
  assert.equal(getBounty(b.id)!.status, "CANCELLED");
  assert.equal(getBounty(b.id)!.pendingOp, null);
});

test("a late escrow confirm on a cancelled bounty stays OPEN (retriable) if the auto-refund fails", async () => {
  const { chain, calls } = fakeChain({ async adminRefund() { throw new Error("rpc down"); } });
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" });
  db.update("bounties", (x) => x.id === b.id, { status: "CANCELLED", cancelReason: "deleted" });
  await applyTxnOutcome(txnByKey(`escrow:${b.taskId}`)!.id, { status: "success" }, chain);

  const after = getBounty(b.id)!;
  assert.equal(after.status, "OPEN"); // truthful — funded, cancel/refund retriable
  assert.equal(after.pendingOp, null); // guard released, not stuck
  assert.equal(calls.adminRefund, 0); // the throwing override never reached the counter

  // The sponsor's retried cancel now takes the normal refund path.
  const { chain: healthy, calls: healthyCalls } = fakeChain();
  const retry = await cancelBounty(b.id, "deleted", healthy);
  assert.equal(retry.reason, "submitted");
  assert.equal(healthyCalls.adminRefund, 1);
});

test("refund + release can't both fire (single-flight) and refund can't follow payout", async () => {
  const { chain } = fakeChain();
  const b = mkBounty();
  fundAndConfirm(b.id);
  await delegate(b.id, chain);

  // Start a release (sets pendingOp) then attempt a refund → blocked.
  await releaseByMerge(b.id, chain);
  const refundWhileReleasing = await refundBounty(b.id, "expired", chain);
  assert.equal(refundWhileReleasing.reason, "in_flight");

  // Confirm payout → PAID, refund now refused outright.
  applyTxnOutcome(txnByKey(`release:${b.taskId}`)!.id, { status: "success" });
  const refundAfterPaid = await refundBounty(b.id, "expired", chain);
  assert.equal(refundAfterPaid.reason, "already_paid");
});

test("failed payout clears the guard and stays pre-paid (retryable)", async () => {
  const { chain } = fakeChain();
  const b = mkBounty();
  fundAndConfirm(b.id);
  await delegate(b.id, chain);
  await releaseByMerge(b.id, chain);
  const payout = txnByKey(`release:${b.taskId}`)!;

  applyTxnOutcome(payout.id, { status: "failed", error: "trapped" });
  const after = getBounty(b.id)!;
  assert.equal(after.status, "DELEGATED"); // not PAID (released from DELEGATED here)
  assert.equal(after.pendingOp, null); // guard cleared → retryable
  assert.equal(after.payoutTxHash, null);
});

test("expiredBounties returns overdue delegated bounties, excludes released ones", async () => {
  const { chain } = fakeChain();

  const overdue = mkBounty(100, 2);
  fundAndConfirm(overdue.id);
  await delegate(overdue.id, chain);
  db.update("bounties", (x) => x.id === overdue.id, { deadlineAt: Date.now() - 1000 });

  const released = mkBounty(100, 2);
  fundAndConfirm(released.id);
  await delegate(released.id, chain);
  db.update("bounties", (x) => x.id === released.id, { deadlineAt: Date.now() - 1000 });
  await releaseByMerge(released.id, chain); // now has a release txn

  const due = expiredBounties();
  const ids = due.map((b) => b.id);
  assert.ok(ids.includes(overdue.id));
  assert.ok(!ids.includes(released.id));
});
