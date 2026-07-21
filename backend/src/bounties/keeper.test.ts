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
  markInReview,
  releaseByMerge,
  refundBounty,
  requestExtension,
  respondToExtension,
  getBounty,
  applyTxnOutcome,
  EXTENSION_AUTO_APPROVE_MS,
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
  async getEscrow() {
    return null;
  },
};

function keeperDeps(
  confirmMap: Record<string, ConfirmResult>,
  now = () => Date.now(),
  chainOverrides: Partial<EscrowChain> = {}
): KeeperDeps {
  return {
    chain: { ...chain, ...chainOverrides },
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
  await acceptAndStartClock(id, { githubId: 5, githubLogin: "dev" }, ADDR(), "", chain);
}

const DEV = { githubId: 5, githubLogin: "dev" };
const DAY = 24 * 60 * 60 * 1000;

// The contributor's DevAsign account — the keeper's bells resolve the assignee
// through it, so without this row a notification has nowhere to land.
function seedDevUser(): string {
  const id = "u_dev";
  db.insert("users", {
    id,
    githubId: DEV.githubId,
    githubLogin: DEV.githubLogin,
    email: "dev@example.com",
    plan: "free",
    createdAt: Date.now(),
  });
  return id;
}

function bells(userId: string, pattern?: RegExp) {
  return db.filter(
    "notifications",
    (n) => n.userId === userId && (!pattern || pattern.test(n.title))
  );
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("users", () => true);
  db.remove("notifications", () => true);
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

test("keeper confirms a pending FUNDING tx → OPEN (the Protocol-23 stuck-PENDING fix)", async () => {
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" });
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING");

  await runTick(keeperDeps({ H_ESCROW: { status: "success", ledger: 3633553 } }));

  const after = getBounty(b.id)!;
  assert.equal(after.status, "OPEN");
  assert.equal(after.onchainStatus, "Open");
  assert.equal(txnByKey(`escrow:${b.taskId}`)!.status, "confirmed");
});

test("a persistently-throwing confirm ages the tx out so orphan recovery can adopt it", async () => {
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" });

  // A confirm that always throws, and now() past the max age: the row must not
  // stay `pending` forever (which would also lock out orphan recovery).
  const throwing: KeeperDeps = {
    chain,
    now: () => Date.now() + 20 * 60 * 1000,
    async confirm() {
      throw new TypeError("Bad union switch: 4");
    },
  };
  await runTick(throwing);
  assert.equal(txnByKey(`escrow:${b.taskId}`)!.status, "failed"); // aged out, retryable
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING");

  // With the row now `failed`, a later tick's orphan recovery adopts the escrow
  // that actually exists on-chain → OPEN. (Spaced past the 5-min orphan recheck
  // throttle that the first tick's recovery pass already consumed.)
  const sponsor = ADDR();
  await runTick(keeperDeps({}, () => Date.now() + 30 * 60 * 1000, {
    async getEscrow() {
      return { creator: sponsor };
    },
  }));
  assert.equal(getBounty(b.id)!.status, "OPEN");
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

// now() past the orphan-recovery min age (a fresh bounty gets a grace window
// before the keeper suspects a lost funding record).
const PAST_MIN_AGE = () => Date.now() + 2 * 60 * 1000;

test("orphaned funding is recovered from on-chain state → OPEN", async () => {
  const b = mkBounty(); // PENDING_FUNDING, no escrow txn row (the lost-record shape)
  const sponsor = ADDR();

  await runTick(keeperDeps({}, PAST_MIN_AGE, { async getEscrow() { return { creator: sponsor }; } }));

  const after = getBounty(b.id)!;
  assert.equal(after.status, "OPEN");
  assert.equal(after.sponsorAddress, sponsor);
  const txn = txnByKey(`escrow:${b.taskId}`)!;
  assert.equal(txn.status, "confirmed");
  assert.equal(txn.hash, null); // the row that held the hash is what was lost
});

test("an aged-out 'failed' funding that actually landed is recovered, hash restored", async () => {
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_LOST", status: "pending" });
  // The keeper aged the tx out (not included in time) — but it later landed.
  applyTxnOutcome(txnByKey(`escrow:${b.taskId}`)!.id, { status: "failed", error: "not_included_timeout" });
  assert.equal(getBounty(b.id)!.escrowTxHash, null); // cleared by the failed verdict

  await runTick(keeperDeps({}, PAST_MIN_AGE, { async getEscrow() { return { creator: ADDR() }; } }));

  const after = getBounty(b.id)!;
  assert.equal(after.status, "OPEN");
  assert.equal(after.escrowTxHash, "H_LOST"); // restored from the repaired row
  const txn = txnByKey(`escrow:${b.taskId}`)!;
  assert.equal(txn.status, "confirmed");
  assert.equal(txn.hash, "H_LOST");
});

test("a genuinely unfunded bounty stays PENDING_FUNDING", async () => {
  const b = mkBounty();

  await runTick(keeperDeps({}, PAST_MIN_AGE)); // default getEscrow → null

  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING");
  assert.equal(txnByKey(`escrow:${b.taskId}`), null);
});

test("per-tick read cap counts actual chain reads, not skipped candidates", async () => {
  // 10 fresh bounties (inside the grace window) iterate FIRST, then 5 aged past
  // it — the skips must neither consume read budget nor break the loop early.
  for (let i = 0; i < 10; i++) mkBounty();
  const due = Array.from({ length: 5 }, () => mkBounty());
  for (const b of due) db.update("bounties", (x) => x.id === b.id, { createdAt: Date.now() - 2 * 60 * 1000 });
  let reads = 0;
  const deps = keeperDeps({}, () => Date.now(), { async getEscrow() { reads++; return null; } });

  await runTick(deps);
  assert.equal(reads, 5); // exactly the due candidates — skips cost nothing

  await runTick(deps);
  assert.equal(reads, 5); // all due candidates now inside the recheck throttle
});

test("more due candidates than the cap → capped now, remainder next tick", async () => {
  const due = Array.from({ length: 12 }, () => mkBounty());
  for (const b of due) db.update("bounties", (x) => x.id === b.id, { createdAt: Date.now() - 2 * 60 * 1000 });
  let reads = 0;
  const deps = keeperDeps({}, () => Date.now(), { async getEscrow() { reads++; return null; } });

  await runTick(deps);
  assert.equal(reads, 10); // ORPHAN_MAX_CHECKS_PER_TICK

  await runTick(deps);
  assert.equal(reads, 12); // the throttled 10 are skipped; the remaining 2 rotate in
});

test("a bounty with a live pending escrow txn is left to the confirm path", async () => {
  const b = mkBounty();
  recordFunding(b.id, ADDR(), { hash: "H_UNCONFIRMED", status: "pending" });
  let escrowReads = 0;

  await runTick(
    keeperDeps({}, PAST_MIN_AGE, {
      async getEscrow() {
        escrowReads++;
        return { creator: ADDR() };
      },
    })
  );

  assert.equal(escrowReads, 0); // not treated as an orphan
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING"); // confirm path still owns it
});

test("expired bounty already released is NOT refunded", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await releaseByMerge(b.id, chain); // has a release txn
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });

  await runTick(keeperDeps({})); // sweep should skip it (release txn exists)
  assert.equal(txnByKey(`refund:${b.taskId}`), null);
});

test("a pending row with no hash ages out to failed (can never be confirmed)", async () => {
  const b = mkBounty();
  // A funding submit that recorded a pending row but never got a hash back — it
  // can never be polled, so it must not pin the bounty PENDING_FUNDING forever.
  recordFunding(b.id, ADDR(), { hash: undefined as unknown as string, status: "pending" });
  assert.equal(txnByKey(`escrow:${b.taskId}`)!.hash, null, "precondition: no hash");

  // now() far in the future → past PENDING_MAX_AGE_MS.
  await runTick(keeperDeps({}, () => Date.now() + 20 * 60 * 1000));

  const after = txnByKey(`escrow:${b.taskId}`)!;
  assert.equal(after.status, "failed");
  assert.equal(after.error, "missing_hash_timeout");
  assert.equal(getBounty(b.id)!.status, "PENDING_FUNDING"); // retryable / orphan-recoverable
});

test("an accepted-but-dropped admin refund is rebuilt + rebroadcast before it ages out", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await refundBounty(b.id, "expired", chain); // admin refund, hash H_REF
  assert.equal(txnByKey(`refund:${b.taskId}`)!.hash, "H_REF");

  // now() past RESUBMIT_STALE_MS (150s) but under PENDING_MAX_AGE_MS (10m), and the
  // confirm still returns not_found → the keeper rebuilds a FRESH envelope.
  let resubmits = 0;
  await runTick(
    keeperDeps({}, () => Date.now() + 3 * 60 * 1000, {
      async adminRefund() {
        resubmits++;
        return { hash: "H_REF2", status: "pending" };
      },
    })
  );

  assert.equal(resubmits, 1, "rebuilt + rebroadcast exactly once");
  const row = txnByKey(`refund:${b.taskId}`)!;
  assert.equal(row.status, "pending", "still pending — not failed, not confirmed");
  assert.equal(row.hash, "H_REF2", "row repointed at the fresh envelope's hash");
  assert.equal(getBounty(b.id)!.refundTxHash, "H_REF2");
});

test("a dropped admin refund still ages out to failed once past the max age", async () => {
  // Resubmit is a best-effort bridge, NOT a substitute for the final backstop:
  // past PENDING_MAX_AGE_MS the row must still fail (retryable), not resubmit forever.
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  await refundBounty(b.id, "expired", chain);

  let resubmits = 0;
  await runTick(
    keeperDeps({}, () => Date.now() + 20 * 60 * 1000, {
      async adminRefund() {
        resubmits++;
        return { hash: "H_REF2", status: "pending" };
      },
    })
  );

  assert.equal(resubmits, 0, "age-out wins over resubmit past the max age");
  assert.equal(txnByKey(`refund:${b.taskId}`)!.status, "failed");
  assert.equal(getBounty(b.id)!.pendingOp, null); // guard cleared → retryable
});

// ── submission stops the delivery clock ──────────────────────────────────────

test("a submitted bounty is not swept even past its deadline", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  markInReview(b.id, 7); // IN_REVIEW + submittedAt
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });

  await runTick(keeperDeps({}));

  assert.equal(txnByKey(`refund:${b.taskId}`), null, "no refund submitted");
  assert.equal(getBounty(b.id)!.status, "IN_REVIEW", "still awaiting review, escrow intact");
});

// ── stale extension auto-approval ────────────────────────────────────────────

test("a 3-day-silent extension auto-approves and the deadline moves", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  // Due in 2 days. By the time the sponsor's silence runs out (3 days from now)
  // the bounty is a day past due — only the pending hold has kept it alive, and
  // only the auto-approval saves it from the sweep in this very tick.
  const oldDeadline = Date.now() + 2 * DAY;
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: oldDeadline });
  requestExtension(b.id, DEV, 3, "sick");

  const at = Date.now() + EXTENSION_AUTO_APPROVE_MS + 1000;
  await runTick(keeperDeps({}, () => at));

  const after = getBounty(b.id)!;
  assert.equal(after.extension!.status, "approved");
  assert.equal(after.extension!.respondedBy, "system");
  assert.equal(after.deadlineAt, oldDeadline + 3 * DAY, "old-deadline anchored");
  const ev = after.events!.at(-1)!;
  assert.equal(ev.kind, "extension_approved");
  assert.equal(ev.actor, "system");
  // The ordering assertion: auto-approve ran BEFORE the sweep in the same tick,
  // so the now-future deadline was never a refund candidate.
  assert.equal(txnByKey(`refund:${b.taskId}`), null, "no refund — approval beat the sweep");
});

test("after a long outage, auto-approval releases the hold and the sweep refunds same-tick", async () => {
  // The documented edge case: if even the EXTENDED deadline is already past
  // (keeper down for days), approval is still correct — anchoring on the old
  // deadline means the contributor already consumed that time — and the refund
  // then proceeds immediately rather than the escrow staying frozen forever.
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  const oldDeadline = Date.now() - 1000;
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: oldDeadline });
  requestExtension(b.id, DEV, 1, "sick");

  await runTick(keeperDeps({}, () => Date.now() + 30 * DAY));

  const after = getBounty(b.id)!;
  assert.equal(after.extension!.status, "approved", "the request still resolves");
  assert.equal(after.deadlineAt, oldDeadline + 1 * DAY, "old-deadline anchored, still in the past");
  assert.ok(txnByKey(`refund:${b.taskId}`), "hold released → the sweep refunds, no permanent freeze");
});

test("a fresh extension request is left alone and still holds the refund", async () => {
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });
  requestExtension(b.id, DEV, 3, "sick");

  await runTick(keeperDeps({}));

  assert.equal(getBounty(b.id)!.extension!.status, "pending", "not yet stale");
  assert.equal(txnByKey(`refund:${b.taskId}`), null, "the hold still holds");
});

test("auto-approval notifies both the contributor and the sponsor", async () => {
  const devId = seedDevUser();
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  db.update("bounties", (x) => x.id === b.id, {
    deadlineAt: Date.now() + 2 * DAY, // +2d extension clears the tick's clock → no refund noise
    sponsorUserId: "u_sponsor",
  });
  requestExtension(b.id, DEV, 2, "sick");

  await runTick(keeperDeps({}, () => Date.now() + EXTENSION_AUTO_APPROVE_MS + 1000));

  assert.equal(bells(devId, /auto-approved/i).length, 1, "contributor told their deadline moved");
  assert.equal(bells("u_sponsor", /auto-approved/i).length, 1, "sponsor told it moved without them");
});

// ── 24h deadline warning ─────────────────────────────────────────────────────

test("the 24h warning fires once and only once", async () => {
  const devId = seedDevUser();
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() + 12 * 60 * 60 * 1000 });

  await runTick(keeperDeps({}));
  assert.equal(bells(devId, /due in/i).length, 1, "warned on the first tick");
  assert.ok(getBounty(b.id)!.deadlineWarnedAt, "stamped");

  await runTick(keeperDeps({}));
  assert.equal(bells(devId, /due in/i).length, 1, "the stamp makes it one-shot, not one-per-tick");
});

test("a warned bounty is warned again after its extension is approved", async () => {
  const devId = seedDevUser();
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() + 12 * 60 * 60 * 1000 });

  await runTick(keeperDeps({}));
  assert.equal(bells(devId, /due in/i).length, 1);

  // +1 day lands the new deadline ~36h out; advance the clock so it is inside
  // the 24h window again. The approve re-armed deadlineWarnedAt.
  requestExtension(b.id, DEV, 1, "one more day");
  respondToExtension(b.id, "approve", "sponsor");
  assert.equal(getBounty(b.id)!.deadlineWarnedAt, null, "re-armed");

  await runTick(keeperDeps({}, () => Date.now() + 24 * 60 * 60 * 1000));
  assert.equal(bells(devId, /due in/i).length, 2, "fresh warning against the new deadline");
});

test("an expired-but-submitted bounty is touched by neither the sweep nor the warning", async () => {
  const devId = seedDevUser();
  const b = mkBounty();
  await fundOpenDelegate(b.id);
  markInReview(b.id, 7);
  db.update("bounties", (x) => x.id === b.id, { deadlineAt: Date.now() - 1000 });

  await runTick(keeperDeps({}));

  assert.equal(txnByKey(`refund:${b.taskId}`), null);
  assert.equal(bells(devId).length, 0, "no misleading 'due in' bell for work already delivered");
});
