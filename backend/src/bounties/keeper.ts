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
  applyTxnOutcome,
  defaultChain,
  expiredBounties,
  getBounty,
  pendingTxns,
  refundBounty,
  type EscrowChain,
} from "./service.js";
import { updateStatusComment } from "./botcomment.js";

const DEFAULT_TICK_MS = 12_000;
// Give up waiting for a tx to be included after this long (timebounds expired /
// dropped) and mark it failed so the operation can be retried.
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

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
