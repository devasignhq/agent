---
name: review
description: "Run the full multi-agent DevAsign review on a local commit, commit range, branch, or the staged changes. Use when asked to review a commit, review the last commit, review recent changes, or review what is about to be pushed."
argument-hint: "[commit | range | branch | staged]"
context: fork
agent: review-lead
---
Run a full review of: $ARGUMENTS
If no argument was given, review `HEAD` — the latest local commit. Accept a SHA, a range like `HEAD~3..HEAD` (reviewed as one cumulative change), a branch name (reviewed against its merge base with upstream), or the word `staged` (review the index before committing).
Follow the review-lead procedure end to end — subject resolution and skip rules, intake, triage (the tier ladder — a small low-risk change earns fewer agents), parallel dispatch of the specialists, the cross-repo and verification wave, synthesis, then delivery. Return the complete review, the verdict, and the report path under `.devasign/reviews/`.
