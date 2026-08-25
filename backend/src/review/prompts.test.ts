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
  contractDeltaSystemPrompt,
  crossRepoSystemPrompt,
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
  [contractDeltaSystemPrompt(), "You are DevAsign's contract-delta extraction step.", "contract-delta extraction"],
  [crossRepoSystemPrompt(), "You are DevAsign's cross-repo impact step.", "cross-repo impact step"],
];

// Every key mockComplete dispatches on, in source order.
const MOCK_KEYS = [
  "bounty criteria evaluation", "criteria synthesis", "Linear issue matching",
  "contract-delta extraction", "cross-repo impact step", "PR review",
  "bug-fix synthesis", "maintainer-feedback goal refinement", "maintainer-dispute re-evaluation",
  "implementation guide synthesis", "file summarisation", "file security audit", "security audit agent",
  "PR security review step", "pre-existing vulnerability re-verification step", "new-commit intent review",
  "deferred-work detection", "holistic repo-review", "defect review step",
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

test("no prompt body contains an EARLIER branch's mock key", () => {
  // Substring dispatch means a stray phrase anywhere in a prompt can hijack it to
  // a branch declared above its own. Checking the whole body, not just line one.
  for (const [prompt, , key] of CASES) {
    // A prompt with no branch of its own (DEVASIGN.md guidance) must not contain
    // ANY key — every one of them would be an earlier branch for it.
    const ownIndex = MOCK_KEYS.indexOf(key);
    const earlierKeys = ownIndex === -1 ? MOCK_KEYS : MOCK_KEYS.slice(0, ownIndex);
    for (const earlier of earlierKeys) {
      assert.ok(
        !prompt.includes(earlier),
        `prompt "${key}" contains earlier mock key "${earlier}" and would dispatch to the wrong branch`
      );
    }
  }
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
