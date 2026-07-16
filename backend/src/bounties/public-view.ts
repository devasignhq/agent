// The UNAUTHENTICATED view of a bounty, served to the contributor app's public
// discovery page (a developer landing from a GitHub link, not yet signed in).
//
// Strict allowlist, built field by field — never a spread of the row — so a new
// Bounty field can never leak here by default. Deliberately excluded: the
// applications array (other applicants' identities), sponsor identity/wallet,
// assignee identity/wallet, funding/cancel links, botCommentId, and every
// payout/refund hash. The escrow txHash IS included: proving "funded & locked"
// on a block explorer is the page's trust anchor.
import type { Bounty, EscrowTransaction } from "../types.js";

export type PublicBountyView = {
  id: string;
  code: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  description: string;
  acceptance: string[];
  amountUsdc: number;
  status: Bounty["status"];
  deliveryDays: number;
  createdAt: number;
  applicantCount: number;
  escrow: {
    txHash: string | null;
    contractId: string | null;
    fundedAt: number | null;
  };
};

export function publicBountyView(
  b: Bounty,
  escrowTxn?: EscrowTransaction | null
): PublicBountyView {
  return {
    id: b.id,
    code: b.code,
    repo: b.repo,
    issueNumber: b.issueNumber,
    issueUrl: b.issueUrl,
    title: b.title,
    description: b.description,
    acceptance: b.acceptance,
    amountUsdc: b.amountUsdc,
    status: b.status,
    deliveryDays: b.deliveryDays,
    createdAt: b.createdAt,
    applicantCount: b.applications.length,
    escrow: {
      txHash: b.escrowTxHash ?? null,
      contractId: b.contractId || null,
      fundedAt: escrowTxn?.confirmedAt ?? null,
    },
  };
}
