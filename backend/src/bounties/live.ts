// Turns bounty/escrow row writes into live-refresh signals for the contributor
// app, so a page reflects a change the moment it happens instead of at the next
// reload.
//
// This is the domain half of the db.ts change emitter: db.ts reports "this row
// was written" and knows nothing more; everything about WHICH writes matter and
// WHO cares lives here.
//
// Three properties keep it cheap, in the order they short-circuit:
//   1. Nobody connected  → do nothing at all (hasClients).
//   2. Nothing visible changed → do nothing (the prev/next diff below). Several
//      hot paths rewrite fields no projection exposes.
//   3. A burst collapses → dirty ids are collected and flushed on a microtask,
//      so one logical transition (which patches the row for its state AND again
//      for its activity-event) sends one frame, not two or three.
//
// Audience is contributors only for now: the assignee and the applicants still
// in the running. Sponsors are deliberately NOT signalled yet — the sponsor app
// refreshes on ANY frame it receives, so pushing to it before it can route by
// type would just buy it a pointless /api/notifications refetch. It joins when
// that app gets the same live bus.
import { db, onRowChange } from "../db.js";
import { hasClients, notifyAudience } from "../notifications-stream.js";
import type { Bounty, EscrowTransaction } from "../types.js";

// Bounty fields that carry no contributor-visible meaning. A write that touches
// ONLY these is bookkeeping, not a state change, and must not wake anyone:
//   updatedAt/version — stamped by every patch, so they can never be the signal
//   botCommentId      — the id of the bot's GitHub comment
//   pendingOp         — the single-flight guard; drives sponsor button state only
const INVISIBLE_BOUNTY_FIELDS = new Set(["updatedAt", "version", "botCommentId", "pendingOp"]);

// Escrow-transaction fields the contributor's payout ledger actually renders.
// `hash` counts: a keeper rebroadcast rewrites it, which changes the explorer
// link under a contributor who may already have the row open.
const LEDGER_FIELDS = ["status", "hash", "confirmedAt", "amountStroops", "bountyId"] as const;

// True when `next` differs from `prev` in at least one field that isn't in
// `ignored`. An insert (prev === null) is always a change.
function changedBeyond(prev: unknown, next: unknown, ignored: Set<string>): boolean {
  if (!prev) return true;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignored.has(key)) continue;
    if (!Object.is(a[key], b[key])) return true;
  }
  return false;
}

// True when any of `fields` differs. Used for the ledger, where the interesting
// set is small enough to list positively rather than by exclusion.
function changedAny(prev: unknown, next: unknown, fields: readonly string[]): boolean {
  if (!prev) return true;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return fields.some((f) => !Object.is(a[f], b[f]));
}

// Who on the contributor side is watching this bounty. GitHub ids, because that
// is the only identity a bounty carries for these people — applications have no
// userId — and the stream registry is indexed by it precisely so this needs no
// users-table scan.
export function contributorAudience(b: Bounty): number[] {
  const ids = new Set<number>();
  if (b.assigneeGithubId != null) ids.add(b.assigneeGithubId);
  for (const app of b.applications ?? []) {
    // Only applicants still in the running. A rejected applicant doesn't need
    // to watch the winner's progress; withdrawn rows are deleted outright.
    if (app.status === "rejected") continue;
    if (app.githubId != null) ids.add(app.githubId);
  }
  return [...ids];
}

// ── coalescing ───────────────────────────────────────────────────────────────
// One logical transition writes the bounty row more than once (the state patch,
// then recordBountyEvent's own patch). Collect and flush once per turn.
const dirtyBounties = new Set<string>();
const dirtyLedgerBounties = new Set<string>();
let flushQueued = false;

function queueFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

function flush(): void {
  flushQueued = false;
  const bounties = [...dirtyBounties];
  const ledgers = [...dirtyLedgerBounties];
  dirtyBounties.clear();
  dirtyLedgerBounties.clear();

  for (const id of bounties) {
    // Re-read rather than trusting the row captured at write time: more patches
    // may have landed inside the same turn, and the audience must reflect the
    // final state (an applicant approved mid-burst should get this frame).
    const b = db.find("bounties", (x) => x.id === id);
    if (!b) continue;
    const githubIds = contributorAudience(b);
    if (githubIds.length > 0) notifyAudience({ githubIds }, "bounties-changed");
  }
  for (const id of ledgers) {
    const b = db.find("bounties", (x) => x.id === id);
    // The payout row's counterparty IS the bounty's assignee (githubLogin is
    // copied from assigneeGithubLogin at send time), so resolve through the
    // bounty and keep using the indexed numeric id rather than the login.
    if (b?.assigneeGithubId != null) {
      notifyAudience({ githubIds: [b.assigneeGithubId] }, "wallet-changed");
    }
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────
let unsubscribe: (() => void) | null = null;

/**
 * Start translating row writes into live signals. Idempotent; returns a stop
 * function (tests use it to avoid leaking a subscription between cases).
 */
export function startBountyLiveSignals(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onRowChange(({ collection, row, prev }) => {
    // Cheapest possible exit: with no stream open there is no one to tell, and
    // this runs inline on the keeper's write path.
    if (!hasClients()) return;

    if (collection === "bounties") {
      if (!changedBeyond(prev, row, INVISIBLE_BOUNTY_FIELDS)) return;
      dirtyBounties.add((row as Bounty).id);
      queueFlush();
      return;
    }

    if (collection === "escrowTransactions") {
      const txn = row as EscrowTransaction;
      // Only payouts reach a contributor's ledger — escrow and refund rows are
      // sponsor-facing (see contributorTransactionsHandler).
      if (txn.kind !== "payout" || !txn.bountyId) return;
      if (!changedAny(prev, row, LEDGER_FIELDS)) return;
      dirtyLedgerBounties.add(txn.bountyId);
      queueFlush();
    }
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
    dirtyBounties.clear();
    dirtyLedgerBounties.clear();
  };
  return unsubscribe;
}
