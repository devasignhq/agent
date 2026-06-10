// Body builders for the editable PR conversation comment that DevAsign posts at
// the start of every review run ("PR Review In Progress") and edits into the
// verdict once the background review finishes. Pure — no db / network / LLM — so
// the exact copy is unit-testable offline (mirrors criteria-format.ts / decisions.ts).
//
// The full verdict (criteria, suggestions, inline comments, Approve/Request-changes
// event) still lives in the formal GitHub PR review; this comment is the concise,
// in-place status banner the developer watches.
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
    "> ⏳ This usually takes a minute or two. Please hang tight!",
  ].join("\n");
}

// The full verdict the placeholder is edited into when the run finishes. This one
// comment IS the review the developer reads: an outcome headline (✅/🔴) followed
// by the complete review body (end goal, criteria, suggestions, feedback) built by
// the pipeline's formatReviewBody. `specless` distinguishes a clean pass with no
// acceptance criteria from one where every criterion was met.
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
        ? "## ✅ DevAsign review — no issues found"
        : "## ✅ DevAsign review — all acceptance criteria met"
      : status === "changes_requested"
      ? "## 🔴 DevAsign review — changes requested"
      : "## ✅ DevAsign review — complete";

  return [headline, "", reviewBody].join("\n").trim();
}

// The body of the formal GitHub PR review, which we keep ONLY for its structural
// roles a plain comment can't fill: the Approve/Request-changes event (the merge
// gate) and inline line-level comments. The full verdict lives in the editable
// conversation comment above (verdictCommentBody), so this body is just a one-line
// pointer — no duplicated criteria/suggestions. A non-empty body is required by
// GitHub for REQUEST_CHANGES/COMMENT and is harmless under APPROVE, so we send the
// same one-liner for every event.
export function minimalReviewBody(): string {
  return "📋 DevAsign's full verdict — acceptance criteria, suggestions, and the consolidated fix prompt — is in the pinned comment above.";
}

// Replaces the placeholder when a run throws, so the comment never stays stuck on
// "in progress". The pipeline re-runs on the next push, so we say so.
export function reviewFailedCommentBody(): string {
  return [
    "## ⚠️ DevAsign review failed",
    "",
    "DevAsign hit an error and couldn't complete this review run. " +
      "It will automatically retry the next time you push to this PR.",
  ].join("\n");
}
