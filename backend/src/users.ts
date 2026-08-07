// Account resolution helpers for the two-account model.
//
// The same GitHub identity owns TWO `users` rows: a "maintainer" account (sponsor
// dashboard — installs, billing, sponsored bounties) and a "contributor" account
// (contributor app — applies to bounties, owns the payout wallet). They share a
// `githubId` but have distinct `id`s, so a bare `db.find("users", u => u.githubId
// === X)` is AMBIGUOUS. Every crossing from githubId-space back to a user row must
// say WHICH account it wants — that's what these helpers are for.
//
// Legacy tolerance: rows written before `accountKind` existed load without it and
// are treated as "maintainer" (existing prod accounts are the sponsor side; the
// boot backfill stamps them explicitly, and preserves that same default unless a
// row shows positive contributor evidence — see backfillAccountKinds).
import { db } from "./db.js";
import type { User } from "./types.js";

export type AccountKind = "maintainer" | "contributor";

// The account kind of a row, defaulting a missing value to "maintainer" so
// un-backfilled legacy rows resolve on the sponsor side.
export function accountKindOf(u: Pick<User, "accountKind">): AccountKind {
  return u.accountKind ?? "maintainer";
}

// The MAINTAINER account for a GitHub id (sponsor dashboard, installs, billing).
// Matches legacy un-stamped rows too. Use for review attribution, install
// linking, and any owner/sponsor-side resolution.
export function maintainerByGithubId(githubId: number): User | null {
  return db.find("users", (u) => u.githubId === githubId && accountKindOf(u) === "maintainer");
}

// The CONTRIBUTOR account for a GitHub id (contributor app, payout wallet).
// Strict: contributor rows are always explicitly stamped. Use for money paths
// (payout-wallet resolution) where landing on the wrong account must fail loudly
// rather than silently substitute another account.
export function contributorByGithubId(githubId: number): User | null {
  return db.find("users", (u) => u.githubId === githubId && u.accountKind === "contributor");
}

// The account to send a CONTRIBUTOR-side notification to: their contributor
// account, falling back to a maintainer account. The fallback matters only during
// the migration window — an assignee/applicant who was mid-bounty before the
// account split may not have signed into the contributor app yet, and we still
// want their payout/deadline/decision bells to reach them. In steady state a
// contributor always has a contributor account, so the fallback never fires. Do
// NOT use for money paths (wallet lookup) — use contributorByGithubId there.
export function contributorNotifyTarget(githubId: number): User | null {
  return contributorByGithubId(githubId) ?? maintainerByGithubId(githubId);
}

// One-time, idempotent boot backfill: stamp any un-stamped `users` row. A row
// that owns/joined an installation is a maintainer account. Everything else needs
// POSITIVE contributor evidence — a registered payout wallet, or bounty activity
// under its githubId — to be stamped "contributor"; with no evidence either way it
// keeps the legacy default this file documents, "maintainer".
//
// Missing installations is NOT contributor evidence: a pre-split sponsor who
// removed the App (or whose row predates install linking) has none. Getting that
// wrong fails SILENTLY on the money path — contributorByGithubId is the strict
// payout-wallet resolver, so a mis-stamped sponsor row becomes the resolution
// target for that githubId's wallet, and maintainerByGithubId stops finding the
// sponsor's own account (their next sign-in mints a new row, orphaning installs
// and billing). The maintainer default fails LOUDLY instead: a real contributor
// gets a contributor row on first contributor-app sign-in, and the wallet path
// returns no_contributor_wallet rather than substituting another account.
//
// Both signals are injected (like installCount) to keep this file free of install
// and bounty shape. Safe to run on every boot — only touches rows missing
// `accountKind`. Returns the number of rows stamped.
export function backfillAccountKinds(
  installCount: (userId: string) => number,
  hasBountyActivity: (githubId: number) => boolean,
): number {
  let stamped = 0;
  for (const u of db.filter("users", (row) => row.accountKind == null)) {
    // Checked here, not left to the caller's predicate, so the "no evidence →
    // maintainer" invariant holds whatever a call site passes in.
    const isContributor =
      installCount(u.id) === 0 &&
      (!!u.stellarPayoutAddress || (u.githubId != null && hasBountyActivity(u.githubId)));
    const kind: AccountKind = isContributor ? "contributor" : "maintainer";
    db.update("users", (row) => row.id === u.id, { accountKind: kind });
    stamped++;
  }
  return stamped;
}
