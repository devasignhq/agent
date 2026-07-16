// Signed links for the bounty flows that a sponsor reaches from a GitHub comment
// or the app. Each link carries an HS256 JWT (signed with SESSION_SECRET, the
// same machinery as the session cookie) scoping the action to one bounty and one
// purpose. Tokens are stateless — "single use" is enforced by the bounty's status
// guards (you can't fund a funded bounty or cancel a non-pending one), not by the
// token — so a replayed link is harmless.
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type LinkPurpose = "fund" | "cancel" | "approve";

// Funding/cancel links ride in a GitHub comment and should stay valid long enough
// for a sponsor to act (default 3 days); callers can override.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 3;

export function mintBountyLinkToken(
  bountyId: string,
  purpose: LinkPurpose,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  return jwt.sign({ b: bountyId, p: purpose }, config.sessionSecret, {
    algorithm: "HS256",
    expiresIn: ttlSeconds,
  });
}

/** The bounty id a token authorizes for `purpose`, or null if invalid/expired/mismatched. */
export function verifyBountyLinkToken(token: string, purpose: LinkPurpose): string | null {
  try {
    const claims = jwt.verify(token, config.sessionSecret, { algorithms: ["HS256"] }) as {
      b?: string;
      p?: string;
    };
    if (claims.p !== purpose || typeof claims.b !== "string" || !claims.b) return null;
    return claims.b;
  } catch {
    return null;
  }
}

function webBase(): string {
  return config.webOrigin.replace(/\/+$/, "");
}

/** Frontend page where the sponsor connects Freighter and signs `create_escrow`. */
export function fundingUrl(bountyId: string): string {
  const token = mintBountyLinkToken(bountyId, "fund");
  return `${webBase()}/bounties/${bountyId}/fund?token=${encodeURIComponent(token)}`;
}

/** Frontend page that confirms + cancels an unfunded bounty (bot "Cancel" link). */
export function cancelUrl(bountyId: string): string {
  const token = mintBountyLinkToken(bountyId, "cancel");
  return `${webBase()}/bounties/${bountyId}/cancel?token=${encodeURIComponent(token)}`;
}

/**
 * Frontend page where a contributor applies for a funded bounty (the bot
 * comment's CTA). Deliberately TOKENLESS: the link sits in a public GitHub
 * comment for an unbounded audience, and a minted token's TTL would rot it.
 * Applying is guarded by session auth + GitHub identity + the service's
 * OPEN-status check instead, and the comment is edited away from the OPEN
 * state once the bounty is delegated, so the link self-retires.
 */
export function applyUrl(bountyId: string): string {
  return `${webBase()}/bounties/${bountyId}/apply`;
}
