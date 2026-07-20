// Resolves the repo row and owning DevAsign user behind a bounty. Its own
// module because both service.ts (gating the criteria enqueue) and
// criteria-job.ts (model tiering + analytics) need it, and having the job own
// it would make an import cycle with service.ts.
//
// The FK trap this exists to hide: `Repository.installationId` is a STRING
// pointing at `Installation.id`, while `Bounty.installationId` is GitHub's
// NUMERIC installation id. They cannot be joined directly, so the route in is
// always owner/name — the same way review-lookup.ts resolves a bounty's repo.
import { db } from "../db.js";
import type { Bounty, Repository, User } from "../types.js";

/**
 * sponsorUserId is null on the comment-command path — the DOMINANT path, since
 * most bounties are created by someone typing `bounty $100 3 days` on an issue.
 * The installation fallback is what stops every one of those from being treated
 * as an unlinked user (which would bill the frontier model regardless of plan).
 */
export function resolveBountyOwner(bounty: Bounty): { repo: Repository | null; userId: string | null } {
  if (bounty.source !== "github" || !bounty.repo.includes("/")) {
    return { repo: null, userId: bounty.sponsorUserId ?? null };
  }
  const [owner, name] = bounty.repo.split("/");
  const repo = db.find("repositories", (r) => r.owner === owner && r.name === name) ?? null;
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  return { repo, userId: bounty.sponsorUserId ?? install?.userId ?? null };
}

/**
 * The richest identity available for analytics and gate bucketing: the full
 * User row when we can find it, else a bare user id, else the repo full name.
 *
 * Falling back to the repo rather than skipping matters for gates specifically
 * — unlike track(), a gate cannot "skip" — and per-repo bucketing is arguably
 * the better rollout axis for repo-scoped features anyway.
 */
export function bountyActor(bounty: Bounty): User | string {
  const { userId } = resolveBountyOwner(bounty);
  if (!userId) return bounty.repo;
  return db.find("users", (u) => u.id === userId) ?? userId;
}
