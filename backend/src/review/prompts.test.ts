// Marker tripwire: the offline LLM mock (llm.ts mockComplete) dispatches by
// substring-matching each stage's system prompt. If a prompt's identity
// sentence drifts, the mock silently falls through to the wrong branch and the
// offline suite tests nothing. This file turns that drift into a red test.
//   node --import tsx/esm --test src/review/prompts.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  criteriaSynthesisSystemPrompt,
  reviewSystemPrompt,
  holisticSystemPrompt,
  securitySystemPrompt,
  defectsSystemPrompt,
  deferredWorkSystemPrompt,
  devasignDocsSystemPrompt,
} from "./prompts.js";

// [prompt text, first-line identity prefix, the mock's substring key]
const CASES: Array<[string, string, string]> = [
  [criteriaSynthesisSystemPrompt(true), "You are DevAsign's criteria synthesis step.", "criteria synthesis"],
  [criteriaSynthesisSystemPrompt(false, "bounty"), "You are DevAsign's criteria synthesis step.", "criteria synthesis"],
  [reviewSystemPrompt(), "You are DevAsign's PR review step.", "PR review"],
  [holisticSystemPrompt(), "You are DevAsign's holistic repo-review step.", "holistic repo-review"],
  [securitySystemPrompt(), "You are DevAsign's PR security review step.", "PR security review step"],
  [defectsSystemPrompt(), "You are DevAsign's defect review step.", "defect review step"],
  [deferredWorkSystemPrompt(), "You are DevAsign's deferred-work detection step.", "deferred-work detection"],
  [devasignDocsSystemPrompt(), "You are DevAsign's DEVASIGN.md guidance step.", "DEVASIGN.md guidance"],
];

test("every stage prompt starts with its identity sentence (mock marker)", () => {
  for (const [prompt, prefix, key] of CASES) {
    assert.ok(prompt.startsWith(prefix), `prompt must start with "${prefix}", got: ${prompt.slice(0, 80)}`);
    assert.ok(prompt.includes(key), `prompt must contain the mock key "${key}"`);
  }
});

test("the security marker cannot be shadowed by the PR-review branch", () => {
  // llm.ts checks "PR review" before... no — it checks in source order; the
  // security branch key must never be a superstring match of an earlier
  // branch's key. "PR security review step" must not contain "PR review".
  assert.ok(!securitySystemPrompt().split("\n")[0].includes("PR review "));
  assert.ok(!"PR security review step".includes("PR review"));
});

test("prompts reference only context sections the pipeline actually emits", () => {
  for (const [prompt] of CASES) {
    for (const forbidden of ["REPO GATES", "## PR state", "RELEVANT CODEBASE CHUNKS", "Similarity:"]) {
      assert.ok(!prompt.includes(forbidden), `prompt must not reference "${forbidden}"`);
    }
  }
});

test("emoji ban is stated in every stage prompt", () => {
  for (const [prompt] of CASES) {
    assert.match(prompt, /Never use emoji/);
  }
});
