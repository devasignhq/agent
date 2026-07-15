// The "DevAsign bot" comments on the GitHub issue. On a `bounty $X $Nd` command
// the bot posts a confirmation with Fund + Cancel links; as the bounty advances
// (funded → delegated → paid/refunded) the same comment is edited in place so the
// issue always shows the current state (and the stale Fund/Cancel links vanish
// once it's funded). GitHub renders markdown links as the "buttons" the product
// owner asked for. All calls are best-effort (the gh helpers swallow + log).
import type { Bounty } from "../types.js";
import { postPRCommentReturningId, updatePRComment } from "../github/app.js";
import { cancelUrl, fundingUrl } from "./links.js";

function ownerName(bounty: Bounty): [string, string] {
  const [owner, name] = bounty.repo.split("/");
  return [owner, name];
}

/** The initial confirmation comment: amount, window, and the Fund / Cancel links. */
export function renderConfirmBody(bounty: Bounty): string {
  const fund = fundingUrl(bounty.id);
  const cancel = cancelUrl(bounty.id);
  return [
    `🤖 **DevAsign Bounty** — your bounty of **$${bounty.amountUsdc} USDC** with a **${bounty.deliveryDays}-day** delivery window is being created. 🎉`,
    ``,
    `Next, fund the escrow from your **Freighter** wallet to activate it:`,
    ``,
    `**[💰 Fund bounty →](${fund})**  ·  [✖ Cancel](${cancel})`,
    ``,
    `<sub>Funds are locked in a Stellar USDC escrow. Delegate a contributor and, once their PR merges within the window, the escrow releases to them automatically; if the window elapses first, it's refunded to your wallet.</sub>`,
  ].join("\n");
}

/** The current-state body the confirmation comment is edited to as the bounty advances. */
export function renderStatusBody(bounty: Bounty): string {
  const amt = `$${bounty.amountUsdc} USDC`;
  const dev = bounty.assigneeGithubLogin ? `@${bounty.assigneeGithubLogin}` : "the contributor";
  switch (bounty.status) {
    case "OPEN":
      return `🤖 **DevAsign Bounty** — ✅ funded. **${amt}** is held in escrow. Contributors can apply; approve one to delegate the work.`;
    case "DELEGATED": {
      const due = bounty.deadlineAt ? ` Delivery due by ${new Date(bounty.deadlineAt).toUTCString()}.` : "";
      return `🤖 **DevAsign Bounty** — 👤 delegated to ${dev}.${due} Merge their PR to release the ${amt}, or it refunds when the window elapses.`;
    }
    case "IN_REVIEW":
      return `🤖 **DevAsign Bounty** — 🔍 in review${bounty.prNumber ? ` (PR #${bounty.prNumber})` : ""} from ${dev}. Merging releases the ${amt} automatically.`;
    case "PAID":
      return `🤖 **DevAsign Bounty** — 💰 paid. **${amt}** released to ${dev}.${bounty.payoutTxHash ? ` (tx \`${bounty.payoutTxHash}\`)` : ""}`;
    case "CANCELLED":
      return bounty.cancelReason === "expired"
        ? `🤖 **DevAsign Bounty** — ⌛ expired. The delivery window elapsed; **${amt}** was refunded to the sponsor.`
        : `🤖 **DevAsign Bounty** — ✖ cancelled. **${amt}** was refunded to the sponsor.`;
    case "DISPUTED":
      return `🤖 **DevAsign Bounty** — ⚠️ disputed; under review by DevAsign.`;
    default:
      return renderConfirmBody(bounty);
  }
}

/** Post the confirmation comment; returns the created comment id (to store as botCommentId). */
export async function postConfirmComment(bounty: Bounty): Promise<number | null> {
  const [owner, name] = ownerName(bounty);
  return postPRCommentReturningId(
    bounty.installationId,
    owner,
    name,
    bounty.issueNumber,
    renderConfirmBody(bounty)
  );
}

/**
 * Edit the confirmation comment to reflect the bounty's current state. Only acts
 * on bounties with a botCommentId — when the confirm comment never made it up
 * (or a Linear bounty has no GitHub issue), there's nothing to edit and we don't
 * spam the issue with a fresh one.
 */
export async function updateStatusComment(bounty: Bounty): Promise<void> {
  if (!bounty.botCommentId) return;
  try {
    const [owner, name] = ownerName(bounty);
    await updatePRComment(
      bounty.installationId,
      owner,
      name,
      bounty.botCommentId,
      renderStatusBody(bounty)
    );
  } catch (err) {
    console.warn(`[bounty] failed to update status comment for ${bounty.code}:`, err);
  }
}
