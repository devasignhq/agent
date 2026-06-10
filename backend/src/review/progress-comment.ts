// Body builders for the editable PR conversation comment that DevAsign posts when
// a review run starts ("PR Review In Progress") and edits into the full verdict
// once the background review finishes. Pure — no db / network / LLM — so the exact
// copy is unit-testable offline (mirrors criteria-format.ts / decisions.ts).
//
// This single comment is the whole conversation footprint of a review run: the
// formal GitHub review is reduced to a bodyless APPROVE (or an approval dismissal
// on a later failure), so no other comment block ever appears. All copy here is
// emoji-free by product decision.
import type { PRReviewStatus } from "../types.js";

// The "running…" placeholder, posted the moment a review run starts. Mirrors the
// product screenshot: a heading, a divider, the "currently running / will update
// automatically" line, a "What's happening?" list, and a hang-tight note.
export function progressCommentBody(): string {
  return [
    "## PR Review In Progress",
    "",
    "---",
    "",
    "A review of this pull request has been triggered and is currently running. " +
      "This comment will be updated automatically once the analysis is complete.",
    "",
    "**What's happening?**",
    "",
    "- Analysing the diff and changed files",
    "- Evaluating code quality, patterns, and potential issues",
    "- Generating actionable suggestions",
    "",
    "> This usually takes a minute or two. Please hang tight!",
  ].join("\n");
}

// The full verdict the placeholder is edited into when the run finishes. This one
// comment IS the review the developer reads: an outcome headline followed by the
// complete review body (end goal, criteria, suggestions, feedback) built by the
// pipeline's formatReviewBody. `specless` distinguishes a clean pass with no
// acceptance criteria from one where every criterion was met. No emoji anywhere —
// the words carry the verdict (product decision: emoji-free PR comments).
export function verdictCommentBody(args: {
  status: PRReviewStatus;
  specless: boolean;
  // The full review body (formatReviewBody output). The one-line summary already
  // lives at the bottom of it, so we don't repeat it here.
  reviewBody: string;
}): string {
  const { status, specless, reviewBody } = args;
  const headline =
    status === "passed"
      ? specless
        ? "## DevAsign review — no issues found"
        : "## DevAsign review — all acceptance criteria met"
      : status === "changes_requested"
      ? "## DevAsign review — changes requested"
      : "## DevAsign review — complete";

  return [headline, "", reviewBody].join("\n").trim();
}

// Replaces the placeholder when a run throws, so the comment never stays stuck on
// "in progress". The pipeline re-runs on the next push, so we say so.
export function reviewFailedCommentBody(): string {
  return [
    "## DevAsign review failed",
    "",
    "DevAsign hit an error and couldn't complete this review run. " +
      "It will automatically retry the next time you push to this PR.",
  ].join("\n");
}
