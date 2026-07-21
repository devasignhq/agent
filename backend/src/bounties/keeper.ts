// Escrow reconciliation keeper. A setInterval loop (started in server.ts after
// the review worker, .unref()'d, guarded by isStellarConfigured) that is the
// DURABLE source of truth across restarts — the in-memory queue isn't. Each tick:
//   1. confirm submitted txns → advance the bounty state machine (+ edit the bot
//      comment); age out a tx that never lands so it's retryable.
//   2. auto-approve extension requests the sponsor left unanswered for 3 days,
//      so a silent sponsor can't hold the escrow indefinitely.
//   3. sweep delivery deadlines → refund the sponsor (admin-signed).
//   4. warn the contributor 24h before their window closes (one-shot, in-app).
// All state advances go through the service's idempotent, guarded transitions, so
// a tick is safe to run repeatedly and concurrently-guarded against itself.
import { flushPending } from "../db.js";
import { isStellarConfigured } from "../config.js";
import { confirmTransaction, type ConfirmResult } from "../stellar/submit.js";
import {
  adoptOnchainEscrow,
  applyTxnOutcome,
  assigneeUser,
  bountiesNearingDeadline,
  defaultChain,
  expiredBounties,
  getBounty,
  patchBounty,
  pendingTxns,
  refundBounty,
  respondToExtension,
  resubmitAdminTxn,
  staleExtensionRequests,
  unfundedPendingBounties,
  type EscrowChain,
} from "./service.js";
import { updateStatusComment } from "./botcomment.js";
import { sponsorAudience } from "./live.js";
import { pushNotification } from "../notifications.js";

const DEFAULT_TICK_MS = 12_000;
// Give up waiting for a tx to be included after this long (timebounds expired /
// dropped) and mark it failed so the operation can be retried.
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
// Rebroadcast an accepted-but-dropped ADMIN tx once it has gone this long without
// landing. Set ABOVE the admin timebounds (ADMIN_TX_TIMEOUT_S = 120s in escrow.ts)
// so the prior envelope is provably dead before we send a fresh one — never two
// live at once. At ~150s this yields ~3 attempts inside PENDING_MAX_AGE_MS.
const RESUBMIT_STALE_MS = 150 * 1000;
// Orphan-recovery pacing: leave the normal funding-submit → confirm path room
// before suspecting a lost record, then re-check each candidate only this often
// — most PENDING_FUNDING bounties are simply not funded yet, and every check is
// a chain simulation.
const ORPHAN_MIN_AGE_MS = 60 * 1000;
const ORPHAN_RECHECK_MS = 5 * 60 * 1000;
// Cap the chain reads per tick so a backlog of aged candidates can't block the
// keeper loop or hammer the RPC node; the throttle stamps rotate coverage to
// the remaining candidates on subsequent ticks.
const ORPHAN_MAX_CHECKS_PER_TICK = 10;

export type KeeperDeps = {
  confirm: (hash: string) => Promise<ConfirmResult>;
  chain: EscrowChain;
  now: () => number;
};

const realDeps: KeeperDeps = {
  confirm: confirmTransaction,
  chain: defaultChain,
  now: () => Date.now(),
};

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startBountyKeeper(opts?: { tickMs?: number }): void {
  if (!isStellarConfigured()) {
    console.log("[bounty-keeper] Stellar not configured — keeper idle");
    return;
  }
  if (timer) return;
  const tick = opts?.tickMs ?? DEFAULT_TICK_MS;
  timer = setInterval(() => void runTick(), tick);
  timer.unref?.();
  console.log(`[bounty-keeper] started (tick ${tick}ms)`);
}

export function stopBountyKeeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** One reconciliation pass. Injectable deps make it unit-testable without a chain. */
export async function runTick(deps: KeeperDeps = realDeps): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await confirmPending(deps);
    await recoverOrphanedFunding(deps);
    // MUST precede sweepDeadlines: auto-approval is what releases the refund
    // hold, and doing it first means a bounty whose new deadline lands in the
    // future is never even considered for refund this tick — no wasted chain
    // call, no misleading "delivery window elapsed" log line.
    await autoApproveStaleExtensions(deps);
    await sweepDeadlines(deps);
    // Last: purely advisory, and it must read the deadline AFTER any auto-approval
    // moved it. Its predicate (deadlineAt > now) is disjoint from the sweep's
    // (deadlineAt < now), so the two never contend over the same bounty.
    await warnApproachingDeadlines(deps);
    await flushPending();
  } catch (err) {
    console.warn("[bounty-keeper] tick error:", err);
  } finally {
    running = false;
  }
}

async function confirmPending(deps: KeeperDeps): Promise<void> {
  // Prune resubmit stamps for rows that are no longer pending so the map can't
  // grow without bound (mirrors the orphan-check throttle below).
  const pending = pendingTxns();
  const pendingIds = new Set(pending.map((t) => t.id));
  for (const id of [...lastResubmit.keys()]) if (!pendingIds.has(id)) lastResubmit.delete(id);
  for (const txn of pending) {
    if (!txn.hash) {
      // A pending row with no hash can never be confirmed — there is nothing to
      // poll. Don't let it pin its bounty pending forever (a funding row would
      // also lock out orphan recovery, which only considers bounties with no live
      // escrow row). Past the max age, fail it so the op becomes retryable and
      // recoverable, exactly like a tx that was never included.
      if (deps.now() - txn.createdAt > PENDING_MAX_AGE_MS) {
        await applyTxnOutcome(txn.id, { status: "failed", error: "missing_hash_timeout" }, deps.chain);
        await syncComment(txn.bountyId);
      }
      continue;
    }
    let outcome: ConfirmResult;
    try {
      outcome = await deps.confirm(txn.hash);
    } catch (err) {
      console.warn(`[bounty-keeper] confirm ${txn.hash} failed:`, err);
      // Defense-in-depth: confirmTransaction is written not to throw, but a
      // confirm that somehow keeps throwing must not pin the row `pending`
      // forever (that also locks out orphan recovery, which only considers
      // bounties with no live escrow row). Past the max age, fail it so
      // recoverOrphanedFunding can adopt a tx that actually landed on-chain.
      if (deps.now() - txn.createdAt > PENDING_MAX_AGE_MS) {
        await applyTxnOutcome(txn.id, { status: "failed", error: "confirm_error_timeout" }, deps.chain);
        await syncComment(txn.bountyId);
      }
      continue;
    }
    if (outcome.status === "not_found") {
      if (deps.now() - txn.createdAt > PENDING_MAX_AGE_MS) {
        // Age-out is the FINAL backstop — checked first so a genuinely dead tx
        // fails (retryable) rather than being resubmitted forever.
        await applyTxnOutcome(txn.id, { status: "failed", error: "not_included_timeout" }, deps.chain);
        await syncComment(txn.bountyId);
      } else if (
        txn.signer === "admin" &&
        deps.now() - (lastResubmit.get(txn.id) ?? txn.createdAt) > RESUBMIT_STALE_MS
      ) {
        // Accepted-then-dropped admin tx: its envelope's short timebounds have
        // expired so it can never land, but it isn't old enough to fail yet.
        // Rebuild a FRESH envelope and rebroadcast (safe — the prior one is dead;
        // and the contract's double-settle guard no-ops a redundant broadcast)
        // instead of waiting out the full 10-minute age-out just to fail it.
        lastResubmit.set(txn.id, deps.now());
        const r = await resubmitAdminTxn(txn.id, deps.chain);
        if (r.ok) console.log(`[bounty-keeper] resubmitted ${txn.kind} ${txn.id} → ${r.hash}`);
        else console.warn(`[bounty-keeper] resubmit ${txn.kind} ${txn.id}: ${r.reason}`);
        await syncComment(txn.bountyId);
      }
      continue;
    }
    await applyTxnOutcome(
      txn.id,
      outcome.status === "success"
        ? { status: "success", ledger: outcome.ledger }
        : { status: "failed", error: outcome.error },
      deps.chain
    );
    await syncComment(txn.bountyId);
  }
}

// Per-txn timestamp of the last admin-tx rebroadcast (confirmPending). In-memory
// only, like lastOrphanCheck: a restart just means one fresh resubmit per pending
// admin tx, which is exactly when a dropped tx most needs re-broadcasting. Pruned
// against the live pending set at the top of confirmPending.
const lastResubmit = new Map<string, number>();

// Per-bounty timestamp of the last on-chain orphan check. In-memory only: a
// restart just means one fresh check per candidate, which is exactly when a
// lost-record orphan is most likely to need recovering.
const lastOrphanCheck = new Map<string, number>();

/**
 * Recover PENDING_FUNDING bounties whose funding record was lost. The normal
 * path is: funding-submit records a pending escrow txn row → confirmPending
 * flips the bounty OPEN. But that row lives in memory until the store flushes —
 * if the flush was failing (the "not_durable" 503) and the process restarted,
 * the row is gone and the bounty would sit PENDING_FUNDING forever while the
 * sponsor's USDC is already escrowed on-chain. The chain is the durable source
 * of truth, so ask it directly: get_escrow(taskId) for each candidate, and
 * adopt the escrow when it exists.
 */
async function recoverOrphanedFunding(deps: KeeperDeps): Promise<void> {
  const candidates = unfundedPendingBounties();
  // Drop throttle entries for bounties that are no longer candidates so the map
  // can't grow without bound.
  const ids = new Set(candidates.map((b) => b.id));
  for (const id of [...lastOrphanCheck.keys()]) if (!ids.has(id)) lastOrphanCheck.delete(id);
  let checkedThisTick = 0;
  for (const b of candidates) {
    if (checkedThisTick >= ORPHAN_MAX_CHECKS_PER_TICK) break;
    const now = deps.now();
    if (now - b.createdAt < ORPHAN_MIN_AGE_MS) continue;
    if (now - (lastOrphanCheck.get(b.id) ?? 0) < ORPHAN_RECHECK_MS) continue;
    lastOrphanCheck.set(b.id, now);
    checkedThisTick++;
    let escrow: unknown;
    try {
      escrow = await deps.chain.getEscrow(b.taskId);
    } catch (err) {
      console.warn(`[bounty-keeper] get_escrow for ${b.code} failed:`, err);
      continue;
    }
    if (!escrow) continue; // genuinely unfunded — the common case
    const r = adoptOnchainEscrow(b.id, escrow);
    if (r.ok && r.reason === "recovered") {
      console.log(
        `[bounty-keeper] ${b.code}: escrow exists on-chain with no local funding record — recovered → OPEN`
      );
      await syncComment(b.id);
    }
  }
}

/**
 * A pending extension request HOLDS the expiry refund (expiredBounties + the
 * refundBounty guard), so a sponsor who never answers holds it forever. Past
 * EXTENSION_AUTO_APPROVE_MS, silence counts as consent: approve on the
 * contributor's behalf — through respondToExtension, so the deadline math, the
 * activity event and the at-most-one-approved invariant stay in ONE place.
 *
 * Runs BEFORE sweepDeadlines so a bounty whose new deadline lands in the future
 * is never even considered for refund this tick.
 */
async function autoApproveStaleExtensions(deps: KeeperDeps): Promise<void> {
  for (const b of staleExtensionRequests(deps.now())) {
    try {
      const r = respondToExtension(b.id, "approve", "system", { at: deps.now() });
      if (!r.ok) {
        // Benign and self-healing: a release landed mid-tick (pendingOp), or
        // another instance won the race. Retried on the next tick.
        console.warn(`[bounty-keeper] auto-approve extension on ${b.code}: ${r.reason}`);
        continue;
      }
      const nb = r.bounty ?? b;
      const days = nb.extension?.days ?? 0;
      const plural = days === 1 ? "" : "s";
      const due = nb.deadlineAt ? new Date(nb.deadlineAt).toUTCString() : "";
      console.log(`[bounty-keeper] ${b.code}: extension unanswered for 3 days → auto-approved`);
      // Both parties: the contributor because their deadline moved, the sponsor
      // because it moved WITHOUT them and their escrow is committed for longer.
      const dev = assigneeUser(nb);
      if (dev) {
        pushNotification(
          dev.id,
          "bounty",
          `Your extension on ${b.code} was auto-approved`,
          `${b.repo}#${b.issueNumber} — +${days} day${plural} after 3 days without a sponsor response. New deadline ${due}`,
          { link: "/dashboard" }
        );
      }
      for (const sponsorId of sponsorAudience(nb)) {
        pushNotification(
          sponsorId,
          "bounty",
          `Extension on ${b.code} auto-approved after 3 days`,
          `${b.repo}#${b.issueNumber} — @${nb.assigneeGithubLogin ?? "the contributor"} now has until ${due}`,
          { link: "/bounties" }
        );
      }
      await syncComment(b.id);
    } catch (err) {
      console.warn(`[bounty-keeper] auto-approve extension on ${b.code} threw:`, err);
    }
  }
}

async function sweepDeadlines(deps: KeeperDeps): Promise<void> {
  for (const b of expiredBounties(deps.now())) {
    console.log(`[bounty-keeper] ${b.code} delivery window elapsed → refunding sponsor`);
    const r = await refundBounty(b.id, "expired", deps.chain);
    if (!r.ok) console.warn(`[bounty-keeper] refund for ${b.code}: ${r.reason}`);
    // The comment flips to "expired" once the refund tx confirms on a later tick.
  }
}

/**
 * One in-app bell 24h before the delivery window closes, so an expiry refund is
 * never the first the contributor hears of it. The `deadlineWarnedAt` stamp is
 * what makes this one-shot rather than one-per-12s-tick — and unlike the
 * lastResubmit / lastOrphanCheck throttles it lives on the ROW, so a keeper
 * restart doesn't re-fire it.
 *
 * Fires for submitted work too, because the window is absolute — but the ask is
 * different. Someone who hasn't submitted can still act on their own; someone
 * waiting on a review can only chase the sponsor, since requestExtension is
 * pre-submission only.
 */
async function warnApproachingDeadlines(deps: KeeperDeps): Promise<void> {
  const now = deps.now();
  for (const b of bountiesNearingDeadline(now)) {
    try {
      // Stamp FIRST and unconditionally: an unclaimed GitHub identity has no user
      // row to notify, and re-scanning it every 12s until expiry is pure waste.
      // For an advisory bell, idempotency beats delivery.
      patchBounty(b.id, { deadlineWarnedAt: now });
      const dev = assigneeUser(b);
      if (!dev) continue;
      const hours = Math.max(1, Math.round((b.deadlineAt! - now) / (60 * 60 * 1000)));
      const ask = b.submittedAt
        ? "your submission is still awaiting review — nudge the sponsor, or the escrow returns to them when the window closes"
        : "submit your PR or request an extension before the window closes";
      pushNotification(dev.id, "bounty", `${b.code} is due in ${hours}h`, `${b.repo}#${b.issueNumber} — ${ask}`, {
        link: "/dashboard",
      });
    } catch (err) {
      console.warn(`[bounty-keeper] deadline warning for ${b.code} threw:`, err);
    }
  }
}

async function syncComment(bountyId?: string | null): Promise<void> {
  if (!bountyId) return;
  const b = getBounty(bountyId);
  if (!b) return;
  try {
    await updateStatusComment(b);
  } catch {
    // best-effort; a comment hiccup never blocks reconciliation
  }
}
