// Body builders for the PR conversation comment DevAsign posts: the "review in
// progress" placeholder posted the moment a run starts (deleted once the summary
// review lands, or edited into the card if that fails), and the failure copy if
// the run throws. The card itself is comment.ts's formatSummaryCard.
//
// All share the "## DevAsign Code Review" title. Pure — no db / network / LLM:
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
    "DevAsign AI is currently reviewing this pull request. When the analysis is complete " +
      "the results are posted as a single review below: a summary, plus one collapsed note " +
      "per finding on the line it concerns.",
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
