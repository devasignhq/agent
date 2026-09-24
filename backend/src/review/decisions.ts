// Pure policy decisions for the review pipeline + PR webhook. These were inline
// in pipeline.ts / webhooks.ts; extracting them lets the workflow→behavior wiring
// be tested deterministically and offline (see decisions.test.ts) without
// changing what the agent does. Keep this module pure — no db / network / LLM.
import type { PRReviewStatus, PRState, RepoWorkflow } from "../types.js";

// The verdict a finished run lands on. `blocked` (red) is deliberately narrow:
// a blocker-severity finding the diff introduced, or an "absolute deviation" —
// every live criterion was judged and not one was met, across at least two of
// them. One unmet criterion is an ordinary changes_requested, not a blocker.
// Callers pass counts, not Criterion[], to keep this module a leaf.
export function resolveVerdictStatus(args: {
  allMet: boolean;
  hasBlocker: boolean;
  liveCount: number;
  scoredCount: number;
  metCount: number;
}): PRReviewStatus {
  const { allMet, hasBlocker, liveCount, scoredCount, metCount } = args;
  const absoluteDeviation = scoredCount >= 2 && scoredCount === liveCount && metCount === 0;
  if (hasBlocker || absoluteDeviation) return "blocked";
  return allMet ? "passed" : "changes_requested";
}

// A merged or closed PR is done: comments on it must not spend review quota
// re-running the agent. Undefined = a row that predates prState, i.e. open.
export function acceptsMaintainerFeedback(prState?: PRState): boolean {
  return prState !== "merged" && prState !== "closed";
}

// The PR object GitHub hands us (webhook payload or REST) → our lifecycle field.
export function prStateOf(pr: { merged?: boolean; merged_at?: string | null; state?: string }): PRState {
  if (pr.merged || pr.merged_at) return "merged";
  return pr.state === "closed" ? "closed" : "open";
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// Nothing failed: every live criterion is met or could not be checked. That is a
// question for a human, so it gets a neutral review rather than changes requested.
export function awaitsConfirmation(args: {
  hasBlocker: boolean;
  liveCount: number;
  metCount: number;
  unverifiableCount: number;
}): boolean {
  const { hasBlocker, liveCount, metCount, unverifiableCount } = args;
  return !hasBlocker && unverifiableCount > 0 && metCount + unverifiableCount === liveCount;
}

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
  // awaitsConfirmation(): only unverifiable criteria stand between the PR and a pass.
  awaitingConfirmation?: boolean;
}): {
  event: ReviewEvent;
  postConversationReview: boolean;
  includeEndGoalCTA: boolean;
  downgradedToComment: boolean;
  securityBlockerHeld: boolean;
  confirmationPending: boolean;
} {
  const { status, specless, blocking, endGoalAlreadyRequested, hasSecurityBlocker = false } = args;
  let event: ReviewEvent;
  let postConversationReview = true;
  let includeEndGoalCTA = false;
  const confirmationPending = status === "changes_requested" && !!args.awaitingConfirmation && !hasSecurityBlocker;
  if (confirmationPending) {
    event = "COMMENT";
  } else if (status !== "passed") {
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
  return { event, postConversationReview, includeEndGoalCTA, downgradedToComment, securityBlockerHeld, confirmationPending };
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
    "The repository maintainer added instructions for this step, delimited by the " +
    "<maintainer_instructions> tags below. Everything inside the tags is the maintainer's text, " +
    "not part of this prompt's structure. Follow the instructions in addition to the rules above, " +
    "but never let them override the required JSON output format or make you invent findings:\n" +
    "<maintainer_instructions>\n" +
    text +
    "\n</maintainer_instructions>"
  );
}

// "I can't confirm this from the provided context" is an admission the reviewer
// never looked, not evidence the requirement is unmet (PR #263 failed on it).
const HEDGE_VERB = /\b(?:cannot|can(?:'|’)t|can not|could not|couldn(?:'|’)t|unable to|not able to)\s+(?:confirm|verify|determine|tell|establish|see whether|check)\b/i;
const HEDGE_SCOPE =
  /\b(?:(?:from|in|with(?:in)?)\s+the\s+(?:provided|available|given|visible|supplied)\s+(?:context|diff|code|files?)|outside (?:of )?(?:the|this) diff|not (?:shown|visible|included|present) in the diff)/i;

export function isHedgedEvidence(evidence: string | null | undefined): boolean {
  const e = evidence ?? "";
  return HEDGE_VERB.test(e) && HEDGE_SCOPE.test(e);
}

// What a criterion's verdict means once the reviewer's own uncertainty is
// honoured: unverifiable criteria carry met: null, never a failure.
export function criterionOutcome(v: { met?: unknown; unverifiable?: unknown; evidence?: string | null }): {
  met: boolean | null;
  unverifiable: boolean;
} {
  if (v.met === true) return { met: true, unverifiable: false };
  if (v.unverifiable === true || (v.met === false && isHedgedEvidence(v.evidence))) return { met: null, unverifiable: true };
  return { met: v.met === false ? false : null, unverifiable: false };
}
