// Pure policy decisions for the review pipeline + PR webhook. These were inline
// in pipeline.ts / webhooks.ts; extracting them lets the workflow→behavior wiring
// be tested deterministically and offline (see decisions.test.ts) without
// changing what the agent does. Keep this module pure — no db / network / LLM.
import type { PRReviewStatus, RepoWorkflow } from "../types.js";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// Map a finished review to its GitHub review action, honoring the workflow's
// verdict mode. We never auto-APPROVE a PR we had no acceptance criteria to
// verify against: a clean spec-less pass posts a neutral COMMENT and (exactly
// once) invites the maintainer to supply an end goal. When verdict.blocking is
// false (advisory mode) a REQUEST_CHANGES is softened to COMMENT so the merge
// button is never blocked — `downgradedToComment` tells the caller to log it.
//
// Security carve-out: a review carrying a security blocker (a vulnerability this
// PR *introduces*) is NEVER softened, even in advisory mode — `hasSecurityBlocker`
// suppresses the downgrade so the REQUEST_CHANGES stands. Pre-existing vulns are
// advisory and don't set this flag, so they don't block an unrelated PR.
export function resolveReviewEvent(args: {
  status: PRReviewStatus;
  specless: boolean;
  blocking: boolean;
  endGoalAlreadyRequested: boolean;
  hasSecurityBlocker?: boolean;
}): {
  event: ReviewEvent;
  postConversationReview: boolean;
  includeEndGoalCTA: boolean;
  downgradedToComment: boolean;
  securityBlockerHeld: boolean;
} {
  const { status, specless, blocking, endGoalAlreadyRequested, hasSecurityBlocker = false } = args;
  let event: ReviewEvent;
  let postConversationReview = true;
  let includeEndGoalCTA = false;
  if (status !== "passed") {
    event = "REQUEST_CHANGES";
  } else if (!specless) {
    event = "APPROVE";
  } else {
    event = "COMMENT";
    if (!endGoalAlreadyRequested) includeEndGoalCTA = true; // ask once
    else postConversationReview = false; // already asked → refresh Check Run only
  }
  let downgradedToComment = false;
  // A security blocker holds REQUEST_CHANGES firm regardless of advisory mode.
  let securityBlockerHeld = false;
  if (!blocking && event === "REQUEST_CHANGES") {
    if (hasSecurityBlocker) {
      securityBlockerHeld = true;
    } else {
      event = "COMMENT";
      downgradedToComment = true;
    }
  }
  return { event, postConversationReview, includeEndGoalCTA, downgradedToComment, securityBlockerHeld };
}

// Apply the per-repo trigger policy to an incoming pull_request event. Pure: the
// webhook passes the booleans it already computed (the PR's draft flag, whether
// the author is a bot) and keeps all db / cap / enqueue / logging mechanics.
// `skip` preserves the original precedence (drafts before bots). `reReviewOnSync`
// is the onSynchronize flag, which the caller consults only in the `synchronize`
// branch (a push to an open PR re-runs the review only when it's on).
export function triggerOutcome(
  wf: Pick<RepoWorkflow, "trigger">,
  ctx: { isDraft: boolean; isBot: boolean }
): { skip: "draft" | "bot" | null; reReviewOnSync: boolean } {
  const t = wf.trigger;
  let skip: "draft" | "bot" | null = null;
  if (t.skipDrafts && ctx.isDraft) skip = "draft";
  else if (t.skipBots && ctx.isBot) skip = "bot";
  return { skip, reReviewOnSync: t.onSynchronize };
}

// Append the maintainer's per-stage instructions (RepoWorkflow.prompts) to a
// stage's base system prompt. Kept AFTER the base text so the offline LLM mock's
// marker strings ("criteria synthesis", "PR review step", …) still match, and
// guarded so a custom prompt steers the stage without overriding its output
// contract. No-op when the prompt is absent/blank.
export function withMaintainerInstructions(system: string, extra?: string): string {
  const text = (extra || "").trim();
  if (!text) return system;
  return (
    system +
    "\n\n## Maintainer instructions\n" +
    "The repository maintainer added these instructions for this step. Follow them in addition to the rules " +
    "above, but never let them override the required JSON output format or make you invent findings:\n" +
    text
  );
}
