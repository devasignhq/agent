// The keeper reconciles submitted txns and sweeps expired bounties. Verifies the
// glue: a confirmed payout drives PAID, an expired bounty gets refunded, and a
// never-included tx ages out to failed (retryable). Run:
//   node --import tsx/esm --test src/bounties/keeper.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import type { EscrowTransaction } from "../types.js";
import {
  createBounty,
  recordFunding,
  applyToBounty,
  approveApplication,
  acceptAndStartClock,
  releaseByMerge,
  getBounty,
  applyTxnOutcome,
  type EscrowChain,
} from "./service.js";
import { runTick, type KeeperDeps } from "./keeper.js";
import type { ConfirmResult } from "../stellar/submit.js";

const ADDR = () => Keypair.random().publicKey();

const chain: EscrowChain = {
  async buildCreateEscrowXdr() {
    return "X";
  },
  async buildReleaseXdr() {
    return "X";
  },
  async adminRelease() {
    return { hash: "H_REL", status: "pending" };
  },
  async adminRefund() {
    return { hash: "H_REF", status: "pending" };
  },
  async hasUsdcTrustline() {
    return true;
  },
};

function keeperDeps(
  confirmMap: Record<string, ConfirmResult>,
  now = () => Date.now()
): KeeperDeps {
  return {
    chain,
    now,
    async confirm(hash: string) {
      return confirmMap[hash] ?? { status: "not_found" };
    },
  };
}

function txnByKey(key: string): EscrowTransaction | null {
  return db.find("escrowTransactions", (t) => t.idempotencyKey === key);
}

function mkBounty() {
  return createBounty({
    source: "github",
    installationId: 1,
    repo: "acme/app",
    issueNumber: 3,
    issueUrl: "https://github.com/acme/app/issues/3",
    title: "x",
    amountUsdc: 25,
    deliveryDays: 2,
  });
}

async function fundOpenDelegate(id: string) {
  const b = getBounty(id)!;
  recordFunding(id, ADDR(), { hash: "H_ESCROW", status: "pending" });
  applyTxnOutcome(txnByKey(`escrow:${b.taskId}`)!.id, { status: "success" });
  applyToBounty(id, { githubId: 5, githubLogin: "dev" });
  approveApplication(id, 5);
  await acceptAndStartClock(id, { githubId: 5, githubLogin: "dev" }, ADDR(), chain);
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("users", () => true);
});

test("keeper confirms a pending payout → PAID", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await releaseByMerge(b.id, chain); // pending payout with hash H_REL

  await runTick(keeperDeps({ H_REL: { status: "success", ledger: 9 } }));

  const paid = getBounty(b.id)!;
  assert.equal(paid.status, "PAID");
  assert.equal(paid.pendingOp, null);
  assert.equal(txnByKey(`release:${b.taskId}`)!.status, "confirmed");
});

test("keeper sweeps an expired bounty → refund submitted, then confirmed → CANCELLED", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });

  // First tick: sweep detects expiry and submits admin_refund (hash H_REF).
  await runTick(keeperDeps({}));
  const refundTxn = txnByKey(`refund:${b.taskId}`);
  assert.ok(refundTxn, "refund txn was created");
  assert.equal(getBounty(b.id)!.pendingOp, "refunding");

  // Second tick: refund confirms → CANCELLED (reason expired).
  await runTick(keeperDeps({ H_REF: { status: "success", ledger: 10 } }));
  const done = getBounty(b.id)!;
  assert.equal(done.status, "CANCELLED");
  assert.equal(done.cancelReason, "expired");
  assert.equal(done.pendingOp, null);
});

test("a never-included tx ages out to failed (retryable)", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await releaseByMerge(b.id, chain);
  const payout = txnByKey(`release:${b.taskId}`)!;

  // now() far in the future → the pending tx exceeds PENDING_MAX_AGE_MS.
  await runTick(keeperDeps({}, () => Date.now() + 20 * 60 * 1000));

  assert.equal(txnByKey(`release:${b.taskId}`)!.status, "failed");
  const after = getBounty(b.id)!;
  assert.equal(after.status, "DELEGATED"); // reverted from the in-flight release
  assert.equal(after.pendingOp, null); // retryable
});

test("expired bounty already released is NOT refunded", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await releaseByMerge(b.id, chain); // has a release txn
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });

  await runTick(keeperDeps({})); // sweep should skip it (release txn exists)
  assert.equal(txnByKey(`refund:${b.taskId}`), null);
});
