// Bounty branches invoked by the existing GitHub/Linear webhook receivers. Kept
// thin (mirroring the receiver's "respond fast, work async" discipline): a
// command creates a PENDING_FUNDING bounty + posts the confirm comment; a merged
// PR releases the escrow to the delegated contributor; an opened PR marks the
// bounty in-review.
import { db, flushPending } from "../db.js";
import { isStellarConfigured } from "../config.js";
import { installationPermissions } from "../github/app.js";
import type { Bounty, Integration } from "../types.js";
import { createLinearComment } from "../linear/client.js";
import { looksLikeBountyCommand, parseBountyCommand } from "./parse.js";
import { createBounty, markInReview, releaseByMerge } from "./service.js";
import { postConfirmComment, renderConfirmBody, updateStatusComment } from "./botcomment.js";
import { resolveBountyForPR } from "./prlink.js";

// Same authority gate as review triggers: a repo owner, org member, or collaborator.
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ACTIVE = new Set(["PENDING_FUNDING", "OPEN", "DELEGATED", "IN_REVIEW"]);

/**
 * The confirm comment is the sponsor's GitHub-side handle on the Fund/Cancel
 * links, so a failed post is an operator-visible ERROR, not a shrug. The most
 * common cause is the GitHub App lacking "Issues: write" — commenting on a
 * plain issue is NOT covered by "Pull requests: write", which is all a
 * PR-review App needs elsewhere — so diagnose that case by name. The bounty
 * itself is fine either way: sponsor-facing reads mint the same links, so the
 * app's Bounties page remains a full fallback.
 */
export async function reportConfirmCommentFailure(bounty: Bounty): Promise<void> {
  const perms = await installationPermissions(bounty.installationId).catch(
    () => ({}) as Record<string, string>
  );
  const issues = perms.issues ?? "none";
  const cause =
    issues === "write"
      ? "the POST failed (see the preceding [github] warning for the response)"
      : `the GitHub App's "Issues" permission is "${issues}" — posting comments on issues ` +
        `requires read & write; grant it in the App's settings, then approve the change on the installation`;
  console.error(
    `[bounty] ${bounty.code}: could not post the confirm comment on ` +
      `${bounty.repo}#${bounty.issueNumber}: ${cause}. ` +
      `The sponsor can still fund or cancel this bounty from the app's Bounties page.`
  );
}

/**
 * Post the Fund/Cancel confirm comment for a GitHub bounty and remember its id
 * (so later status transitions edit it in place). Shared by the comment-command
 * webhook and the app's POST /bounties. Best-effort — a failure is reported
 * loudly but never breaks bounty creation.
 */
export async function postAndRecordConfirmComment(bounty: Bounty): Promise<void> {
  try {
    const commentId = await postConfirmComment(bounty);
    if (commentId) {
      db.update("bounties", (b) => b.id === bounty.id, { botCommentId: commentId });
    } else {
      await reportConfirmCommentFailure(bounty);
    }
    await flushPending();
  } catch (err) {
    console.warn(`[bounty] confirm comment failed for ${bounty.code}:`, err);
  }
}

/**
 * Handle a `bounty $X $Nd` comment on a GitHub ISSUE. Returns true if this was a
 * bounty command (so the caller stops before the PR-review path). Creates the
 * bounty synchronously and posts the confirm comment off the request thread.
 */
export function maybeHandleBountyComment(event: any): boolean {
  const body: string = event.comment?.body || "";
  if (event.issue?.pull_request) return false; // PRs are handled by the review path
  if (!looksLikeBountyCommand(body)) return false;
  if (event.sender?.type === "Bot") return false;
  if (!MAINTAINER_ASSOCIATIONS.has(event.comment?.author_association || "NONE")) return false;
  const cmd = parseBountyCommand(body);
  if (!cmd) return false;

  if (!isStellarConfigured()) {
    // A maintainer explicitly asked for a bounty and nothing will visibly
    // happen — make the config gap unmissable in the logs.
    console.error(
      "[bounty] bounty command received but Stellar is not configured — no bounty was created " +
        "and no comment will be posted. Set STELLAR_ESCROW_CONTRACT_ID, STELLAR_USDC_SAC_ID and " +
        "the admin key (see config.stellar) on this deployment to enable bounties."
    );
    return true;
  }
  const repo: string = event.repository?.full_name || "";
  const installationId: number = event.installation?.id;
  const issueNumber: number = event.issue?.number;
  if (!repo || !installationId || !issueNumber) return false;

  // One active bounty per issue (guards against a re-comment double-create;
  // exact redeliveries are already dropped by the receiver's GUID dedupe).
  const existing = db.find(
    "bounties",
    (b) => b.repo === repo && b.issueNumber === issueNumber && ACTIVE.has(b.status)
  );
  if (existing) {
    console.log(`[bounty] ${repo}#${issueNumber} already has ${existing.code}; ignoring`);
    return true;
  }

  const bounty = createBounty({
    source: "github",
    installationId,
    repo,
    issueNumber,
    issueUrl: event.issue?.html_url || "",
    title: event.issue?.title || `Bounty on ${repo}#${issueNumber}`,
    description: typeof event.issue?.body === "string" ? event.issue.body : "",
    amountUsdc: cmd.amountUsdc,
    deliveryDays: cmd.deliveryDays,
  });
  console.log(
    `[bounty] created ${bounty.code} for ${repo}#${issueNumber} ($${cmd.amountUsdc}, ${cmd.deliveryDays}d)`
  );
  void postAndRecordConfirmComment(bounty);
  return true;
}

/**
 * Handle a `bounty $X $Nd` comment on a Linear ISSUE. The workspace connector is
 * the sponsor (bounties scope to them by sponsorUserId, since there's no GitHub
 * installation). Posts the Fund/Cancel confirm comment back to Linear. Payout for
 * a Linear bounty is the sponsor's in-app "Approve payment" (the merge trigger is
 * GitHub-specific). Returns true if this was a bounty command.
 */
export function maybeHandleBountyLinearComment(event: any, integration: Integration): boolean {
  const body: string = event?.data?.body || "";
  if (!looksLikeBountyCommand(body)) return false;
  const cmd = parseBountyCommand(body);
  if (!cmd) return false;
  if (!isStellarConfigured()) {
    console.log("[bounty] Linear command seen but Stellar is not configured — ignoring");
    return true;
  }
  const issueId: string = event?.data?.issueId || event?.data?.issue?.id || "";
  if (!issueId) return false;
  const existing = db.find(
    "bounties",
    (b) => b.source === "linear" && b.externalKey === issueId && ACTIVE.has(b.status)
  );
  if (existing) return true;

  const issueUrl: string =
    event?.data?.issue?.url || event?.url || `https://linear.app/issue/${issueId}`;
  const title: string = event?.data?.issue?.title || `Linear bounty ${issueId}`;
  const bounty = createBounty({
    source: "linear",
    installationId: 0, // no GitHub installation for a Linear bounty
    repo: event?.data?.issue?.identifier || "linear",
    issueNumber: 0,
    issueUrl,
    externalKey: issueId,
    title,
    amountUsdc: cmd.amountUsdc,
    deliveryDays: cmd.deliveryDays,
    sponsorUserId: integration.userId,
  });
  console.log(`[bounty] created ${bounty.code} from Linear issue ${issueId}`);
  const token = integration.tokens.accessToken || integration.tokens.apiKey || "";
  const bearer = Boolean(integration.tokens.accessToken);
  void (async () => {
    try {
      if (token) await createLinearComment(token, issueId, renderConfirmBody(bounty), { bearer });
      await flushPending();
    } catch (err) {
      console.warn(`[bounty] Linear confirm comment failed for ${bounty.code}:`, err);
    }
  })();
  return true;
}

/** A merged PR delivering a delegated bounty → release the escrow (admin-signed). */
export function handleBountyPRMerge(event: any): void {
  if (!isStellarConfigured()) return;
  const repo: string = event.repository?.full_name || "";
  const pr = event.pull_request;
  if (!repo || !pr) return;
  const bounty = resolveBountyForPR(repo, pr.body || "");
  if (!bounty) return;
  if (bounty.status !== "DELEGATED" && bounty.status !== "IN_REVIEW") return;
  // Escrow release moves money, so the merge and the delegate identity are
  // verified strictly: never release when the PR wasn't merged, when no delegate
  // is on record, or when the PR author isn't that delegate. (`merged === true`
  // already implies a write-access maintainer merged it, per GitHub, and the
  // caller gates on it — this exported fn self-guards regardless.)
  if (!pr.merged) {
    console.warn(`[bounty] ${bounty.code}: PR #${pr.number} closed without merging — no release`);
    return;
  }
  if (!bounty.assigneeGithubId) {
    console.warn(`[bounty] ${bounty.code}: no delegated contributor on record — refusing release`);
    return;
  }
  const authorId = pr.user?.id;
  // Coerce both to strings before comparing — GitHub ids arrive as numbers and
  // assigneeGithubId is a number today, but this stays correct if either side is
  // ever persisted/serialized as a string.
  if (!authorId || String(authorId) !== String(bounty.assigneeGithubId)) {
    console.warn(
      `[bounty] ${bounty.code}: PR #${pr.number} author ${authorId ?? "unknown"} ` +
      `is not the delegate ${bounty.assigneeGithubId} — no release`
    );
    return;
  }
  console.log(`[bounty] PR #${pr.number} merged → releasing ${bounty.code}`);
  void (async () => {
    try {
      const r = await releaseByMerge(bounty.id);
      if (!r.ok) console.warn(`[bounty] release for ${bounty.code} not submitted: ${r.reason}`);
      // Status comment flips to "paid" once the keeper confirms the payout tx.
      await flushPending();
    } catch (err) {
      console.warn(`[bounty] release error for ${bounty.code}:`, err);
    }
  })();
}

/** An opened/ready PR referencing a delegated bounty → mark it in review. */
export function handleBountyPROpened(event: any): void {
  const repo: string = event.repository?.full_name || "";
  const pr = event.pull_request;
  if (!repo || !pr) return;
  const bounty = resolveBountyForPR(repo, pr.body || "");
  if (!bounty) return;
  if (bounty.status !== "DELEGATED" && bounty.status !== "IN_REVIEW") return;
  // Only advance to in-review when the PR author is verified to be the delegate
  // — mirrors the strict identity check on the release path: no state change
  // when the delegate is unknown or the author isn't that delegate.
  if (!bounty.assigneeGithubId) return;
  const authorId = pr.user?.id;
  if (!authorId || String(authorId) !== String(bounty.assigneeGithubId)) return;
  const r = markInReview(bounty.id, pr.number);
  if (r.ok && r.bounty) {
    const fresh = r.bounty;
    void (async () => {
      try {
        await updateStatusComment(fresh);
        await flushPending();
      } catch (err) {
        console.warn(`[bounty] status comment failed for ${fresh.code}:`, err);
      }
    })();
  }
}
