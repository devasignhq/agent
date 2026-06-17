// Offline tests for the commit-message fallback in criteria synthesis: when a PR
// has no linked issue/spec and a thin description, the PR's commit messages are
// surfaced to the synthesis step as the author's statement of intent.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/review/criteria-synthesis.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPrCommitMessages,
  criteriaSynthesisSystemPrompt,
  synthesizeCriteriaCore,
} from "./pipeline.js";

test("formatPrCommitMessages keeps each commit's subject AND body", () => {
  const out = formatPrCommitMessages([
    { sha: "abcdef1234567", message: "Add retry on 5xx\n\nRetries failed uploads up to 3 times." },
    { sha: "0123456789abc", message: "Cap backoff at 30s" },
  ]);
  assert.match(out, /### abcdef1/); // short sha, not the full 40-char one
  assert.ok(!out.includes("abcdef1234567"), "full sha should be truncated to 7 chars");
  assert.match(out, /Add retry on 5xx/);
  assert.match(out, /Retries failed uploads up to 3 times\./, "body must be included, not just subject");
  assert.match(out, /Cap backoff at 30s/);
});

test("formatPrCommitMessages handles an empty message and applies caps", () => {
  const empty = formatPrCommitMessages([{ sha: "deadbeefcafe", message: "" }]);
  assert.match(empty, /### deadbee\n\(no commit message\)/);

  // A single oversized commit body is truncated to the per-commit cap (2000),
  // and the whole block to the total cap (12000).
  const huge = formatPrCommitMessages([{ sha: "1111111", message: "x".repeat(50_000) }]);
  assert.ok(huge.length <= 12_000, "total cap enforced");
  assert.ok(huge.length < 50_000, "per-commit cap enforced");
});

test("criteriaSynthesisSystemPrompt: spec-less branch lets criteria come from commit messages", () => {
  const noSpec = criteriaSynthesisSystemPrompt(false);
  assert.match(noSpec, /commit messages/i);
  assert.match(noSpec, /NO linked issue/, "spec-less guardrail still present");
  // The allowed-sources sentence must name commit messages alongside title/description.
  assert.match(noSpec, /title, description, and commit messages/i);

  const withSpec = criteriaSynthesisSystemPrompt(true);
  assert.ok(!withSpec.includes("NO linked issue"), "spec branch omits the spec-less guardrail");
  // Commits are described as general context in both branches.
  assert.match(withSpec, /Commit messages/);
  // Both keep the offline-mock marker.
  assert.match(noSpec, /criteria synthesis/);
  assert.match(withSpec, /criteria synthesis/);
});

test("synthesizeCriteriaCore threads commits through (mock LLM) without error", async () => {
  const { criteria, endGoal } = await synthesizeCriteriaCore({
    title: "PR Add retry on 5xx",
    sources: [{ kind: "github_pr", ref: "acme/web#7", text: "Add retry on 5xx" }],
    hasAuthoritativeSpec: false,
    commits: formatPrCommitMessages([
      { sha: "abc1234", message: "Add retry on 5xx\n\nRetries failed uploads up to 3 times." },
    ]),
  });
  assert.ok(criteria.length > 0);
  assert.ok(endGoal.length > 0);
});
