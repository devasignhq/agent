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
// Two audiences, resolved by different identities because the domain names them
// differently: contributors by githubId (an application carries no userId) and
// sponsors by userId (they are DevAsign accounts, and an org install can have
// several members). Both are resolved in the coalesced flush, never in the
// synchronous listener — the sponsor lookup scans `installations`.
import { db, onRowChange } from "../db.js";
import { installMembers } from "../github/installations.js";
import { hasClients, notifyAudience } from "../notifications-stream.js";
import type { Bounty, EscrowTransaction } from "../types.js";

// Bounty fields that carry no contributor-visible meaning. A write that touches
// ONLY these is bookkeeping, not a state change, and must not wake anyone:
//   updatedAt/version — stamped by every patch, so they can never be the signal
//   botCommentId      — the id of the bot's GitHub comment
//   pendingOp         — the single-flight guard; drives sponsor button state only
//   deadlineWarnedAt  — the keeper's one-shot 24h-warning stamp; no projection
//                       exposes it, and the bell it accompanies pushes its own signal
const INVISIBLE_BOUNTY_FIELDS = new Set([
  "updatedAt",
  "version",
  "botCommentId",
  "pendingOp",
  "deadlineWarnedAt",
]);

// Escrow-transaction fields the contributor's payout ledger actually renders.
// `hash` counts: a keeper rebroadcast rewrites it, which changes the explorer
// link under a contributor who may already have the row open.
const LEDGER_FIELDS = ["status", "hash", "confirmedAt", "amountStroops", "bountyId"] as const;

// True when `next` differs from `prev` in at least one field that isn't in
// `ignored`. An insert (prev === null) is always a change.
export function changedBeyond(prev: unknown, next: unknown, ignored: Set<string>): boolean {
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

// Who on the sponsor side is watching. Mirrors the `isSponsor` access rule
// (routes/bounties.ts) rather than inventing a second one, and returns userIds
// because sponsors are DevAsign accounts rather than bare GitHub identities.
//
// Two traps here. First, `sponsorUserId` is null for every bounty created from a
// GitHub issue comment, so it can't be the only source — the installation is.
// Second, `Bounty.installationId` is GitHub's NUMERIC id, joining
// `Installation.installationId`; `Repository.installationId` is a uuid joining
// `Installation.id`. Copying the repo-side join here would silently resolve the
// wrong installation, or none. Linear bounties carry 0 and fall through.
//
// A sponsor "audience" is legitimately several people: an org install can have
// many members, which is what installMembers() returns (falling back to
// [userId] for rows written before `userIds` existed).
export function sponsorAudience(b: Bounty): string[] {
  const ids = new Set<string>();
  if (b.sponsorUserId) ids.add(b.sponsorUserId);
  if (b.installationId) {
    const install = db.find("installations", (i) => i.installationId === b.installationId);
    if (install) for (const id of installMembers(install)) ids.add(id);
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
    // Both sides in ONE frame per connection: notifyAudience dedupes, so a
    // person who is somehow both (sponsor of one bounty, applicant on it) is
    // written to once. Note the sponsor lookup scans `installations`, which is
    // why all of this lives in the coalesced flush and never in the synchronous
    // listener — db.ts is explicit that listeners run inside the write.
    const githubIds = contributorAudience(b);
    const userIds = sponsorAudience(b);
    if (githubIds.length > 0 || userIds.length > 0) {
      notifyAudience({ githubIds, userIds }, "bounties-changed");
    }
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
