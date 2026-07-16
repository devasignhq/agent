// Escrow reconciliation keeper. A setInterval loop (started in server.ts after
// the review worker, .unref()'d, guarded by isStellarConfigured) that is the
// DURABLE source of truth across restarts — the in-memory queue isn't. Each tick:
//   1. confirm submitted txns → advance the bounty state machine (+ edit the bot
//      comment); age out a tx that never lands so it's retryable.
//   2. sweep delivery deadlines → refund the sponsor (admin-signed).
// All state advances go through the service's idempotent, guarded transitions, so
// a tick is safe to run repeatedly and concurrently-guarded against itself.
import { flushPending } from "../db.js";
import { isStellarConfigured } from "../config.js";
import { confirmTransaction, type ConfirmResult } from "../stellar/submit.js";
import {
  adoptOnchainEscrow,
  applyTxnOutcome,
  defaultChain,
  expiredBounties,
  getBounty,
  pendingTxns,
  refundBounty,
  unfundedPendingBounties,
  type EscrowChain,
} from "./service.js";
import { updateStatusComment } from "./botcomment.js";

const DEFAULT_TICK_MS = 12_000;
// Give up waiting for a tx to be included after this long (timebounds expired /
// dropped) and mark it failed so the operation can be retried.
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
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
    await sweepDeadlines(deps);
    await flushPending();
  } catch (err) {
    console.warn("[bounty-keeper] tick error:", err);
  } finally {
    running = false;
  }
}

async function confirmPending(deps: KeeperDeps): Promise<void> {
  for (const txn of pendingTxns()) {
    if (!txn.hash) continue;
    let outcome: ConfirmResult;
    try {
      outcome = await deps.confirm(txn.hash);
    } catch (err) {
      console.warn(`[bounty-keeper] confirm ${txn.hash} failed:`, err);
      continue;
    }
    if (outcome.status === "not_found") {
      if (deps.now() - txn.createdAt > PENDING_MAX_AGE_MS) {
        applyTxnOutcome(txn.id, { status: "failed", error: "not_included_timeout" });
        await syncComment(txn.bountyId);
      }
      continue;
    }
    applyTxnOutcome(
      txn.id,
      outcome.status === "success"
        ? { status: "success", ledger: outcome.ledger }
        : { status: "failed", error: outcome.error }
    );
    await syncComment(txn.bountyId);
  }
}

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

async function sweepDeadlines(deps: KeeperDeps): Promise<void> {
  for (const b of expiredBounties(deps.now())) {
    console.log(`[bounty-keeper] ${b.code} delivery window elapsed → refunding sponsor`);
    const r = await refundBounty(b.id, "expired", deps.chain);
    if (!r.ok) console.warn(`[bounty-keeper] refund for ${b.code}: ${r.reason}`);
    // The comment flips to "expired" once the refund tx confirms on a later tick.
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
