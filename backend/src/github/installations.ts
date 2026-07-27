// Installation ↔ user membership helpers.
//
// An installation can be shared by several DevAsign users: the personal owner, or
// the org owners/admins who adopt it at signup (see github/oauth.ts), plus anyone
// who explicitly links it. `userIds` holds the full set; `userId` is the original
// installer (kept for back-compat and the "shared org install" banner). Every
// owner-scoped route resolves access through here so a second org owner sees the
// org's repos/reviews without clobbering the first owner's claim.
import { db } from "../db.js";
import type { Installation } from "../types.js";
import { maintainerByGithubId } from "../users.js";

// The DevAsign users linked to an installation. Falls back to [userId] for rows
// written before `userIds` existed (and drops "" placeholders from unlinked rows).
export function installMembers(install: Installation): string[] {
  if (install.userIds && install.userIds.length > 0) return install.userIds;
  return install.userId ? [install.userId] : [];
}

// Is `userId` linked to this installation? Tolerates the legacy single-`userId`
// shape so access checks keep working during/after the migration.
export function userInInstall(install: Installation, userId: string): boolean {
  if (!userId) return false;
  return install.userId === userId || installMembers(install).includes(userId);
}

// Every installation the user can access (replaces the old
// `db.filter("installations", i => i.userId === user.id)` ownership check).
export function installationsForUser(userId: string): Installation[] {
  return db.filter("installations", (i) => userInInstall(i, userId));
}

// Add a DevAsign user to an installation's membership set (idempotent). Also sets
// the primary `userId` when the row had none (e.g. webhook landed before signin).
// Returns the fresh row, or null if the install row no longer exists.
export function addInstallMember(installId: string, userId: string): Installation | null {
  if (!userId) return null;
  const install = db.find("installations", (i) => i.id === installId);
  if (!install) return null;
  const members = new Set(installMembers(install));
  members.add(userId);
  return db.update("installations", (i) => i.id === installId, {
    userIds: [...members],
    ...(install.userId ? {} : { userId }),
  });
}

// Resolve a GitHub actor (PR author or commenter) to the DevAsign user whose
// monthly quota a review should count against: the user with that GitHub id, but
// only when they're a member of this installation. Returns null otherwise — an
// external contributor, or a member who never adopted the install, so there's no
// subscription to charge. Callers skip auto-review when this is null.
export function attributedUserFor(
  install: Installation | null | undefined,
  githubActorId: number | null | undefined
): string | null {
  if (!install || typeof githubActorId !== "number") return null;
  // Billing/quota attribution is a maintainer concern: only the maintainer account
  // owns a subscription and can be an install member. The same githubId may also
  // have a contributor account, so resolve the maintainer side explicitly.
  const actor = maintainerByGithubId(githubActorId);
  if (!actor) return null;
  return userInInstall(install, actor.id) ? actor.id : null;
}
