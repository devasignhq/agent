// Body builders for the two states of the editable PR conversation comment that
// DevAsign posts: the "review in progress" placeholder posted the moment a run
// starts, and the failure copy if the run throws. The finished state — the
// summary card — is built by comment.ts's formatSummaryCard.
//
// All three share the "## DevAsign Code Review" title so the comment keeps one
// identity as it is edited through the run; only what sits under the title
// changes. Pure — no db / network / LLM:
//   node --import tsx/esm --test src/review/progress-comment.test.ts
import { CARD_TITLE } from "./comment.js";

// The "running…" placeholder. Deliberately short: it is replaced within a minute
// or two, and a long checklist would only make the eventual edit jarring.
export function progressCommentBody(): string {
  return [
    CARD_TITLE,
    "",
    "⏳ `Review in progress`",
    "",
    "A review of this pull request has been triggered and is currently running. " +
      "This comment will be updated automatically once the analysis is complete, " +
      "and any findings will appear as review comments on the lines they concern.",
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

// Replaces the placeholder when a run throws, so the comment never stays stuck on
// "in progress". The pipeline re-runs on the next push, so we say so.
export function reviewFailedCommentBody(): string {
  return [
    CARD_TITLE,
    "",
    "🔴 `Review failed`",
    "",
    "DevAsign hit an error and couldn't complete this review run. " +
      "It will automatically retry the next time you push to this PR.",
  ].join("\n");
}
