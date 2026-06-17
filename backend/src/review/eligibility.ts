// Who-opened-it gate for PR reviews. Today every open PR is reviewed; this
// module scopes *which* PRs we review without being asked, by plan tier:
//
//   Free / Pro : only the account owner's own PRs auto-review.
//   Max        : the owner's own PRs + any team member's (org member's) PRs.
//
// Everything else stays untouched ("don't even check it out") until the account
// owner comments the trigger word on the PR. Pure + synchronous — team standing
// comes straight off GitHub's `author_association` on the PR payload, so there's
// no extra API call or App permission. Shared by the `pull_request` webhook and
// the /reviews/sync dashboard poll so both paths gate identically.
import { db } from "../db.js";
import { planForUser } from "../billing/plans.js";

// `author_association` values that mean the PR author has organizational
// standing on the repo — the Max-tier "team member" test. MEMBER = org member,
// OWNER = repo/org owner. COLLABORATOR is repo-level access (e.g. an outside
// collaborator), NOT org access, so it's intentionally excluded from "team".
const TEAM_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);

// The account owner starts a review on an un-reviewed PR by commenting exactly
// "review" (or "/review"), case-insensitive and trimmed. Exact match avoids
// false triggers from prose like "I'll review this later".
export function isReviewTriggerComment(body: string): boolean {
  const t = (body || "").trim().toLowerCase();
  return t === "review" || t === "/review";
}

// Is `actor` the DevAsign account user who owns this installation? Prefers the
// stable GitHub numeric id (a login can be renamed and reassigned); falls back
// to a case-insensitive login compare when an id isn't available on the event.
export function isAccountOwner(
  ownerUserId: string,
  actorLogin: string,
  actorId?: number | null
): boolean {
  if (!ownerUserId) return false;
  const u = db.find("users", (x) => x.id === ownerUserId);
  if (!u) return false;
  if (actorId != null && u.githubId != null) return u.githubId === actorId;
  // githubLogin is typed non-null, but the jsonb store doesn't enforce that —
  // fail closed (return false) rather than throw on a malformed/legacy row.
  return !!actorLogin && !!u.githubLogin && u.githubLogin.toLowerCase() === actorLogin.toLowerCase();
}

// Should an opened PR be auto-reviewed (no "review" comment required)?
//   - Unlinked install (no ownerUserId yet — onboarding grace): true, preserving
//     today's review-everything behavior. Gating begins once the install is
//     linked, mirroring the private-repo / monthly-cap gates.
//   - Account owner's own PR: true on every tier.
//   - Free / Pro: false for anyone but the owner.
//   - Max: true when the author is a team member (org standing on the repo).
export function shouldAutoReviewOpenedPR(args: {
  ownerUserId: string;
  prAuthorLogin: string;
  prAuthorId?: number | null;
  authorAssociation?: string | null;
}): boolean {
  if (!args.ownerUserId) return true;
  if (isAccountOwner(args.ownerUserId, args.prAuthorLogin, args.prAuthorId)) return true;
  if (planForUser(args.ownerUserId) !== "max") return false;
  return TEAM_ASSOCIATIONS.has(String(args.authorAssociation || "").toUpperCase());
}
