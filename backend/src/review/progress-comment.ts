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

// The verdict banner the placeholder is edited into when the run finishes. Concise
// by design: outcome headline (✅/🔴), the one-line summary, and a pointer to the
// formal review (linked when we captured its URL). `specless` distinguishes a clean
// pass with no acceptance criteria from one where every criterion was met.
export function verdictCommentBody(args: {
  status: PRReviewStatus;
  specless: boolean;
  summary: string;
  reviewUrl?: string;
}): string {
  const { status, specless, summary, reviewUrl } = args;
  const headline =
    status === "passed"
      ? specless
        ? "## ✅ DevAsign review — no issues found"
        : "## ✅ DevAsign review — all acceptance criteria met"
      : status === "changes_requested"
      ? "## 🔴 DevAsign review — changes requested"
      : "## ✅ DevAsign review — complete";

  const lines: string[] = [headline, ""];
  if (status === "passed" && specless) {
    lines.push(
      "No blocking bugs, regressions, or security concerns surfaced. This PR has no linked " +
        "issue or spec, so it was reviewed for correctness only — no acceptance criteria were checked.",
      ""
    );
  }
  const trimmed = (summary || "").trim();
  if (trimmed) lines.push(trimmed, "");
  lines.push(
    reviewUrl
      ? `📋 [View the full review](${reviewUrl}) — criteria, suggestions, and inline comments.`
      : "📋 See the full review below for the criteria, suggestions, and inline comments."
  );
  return lines.join("\n").trim();
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
