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
  testFileSystemPrompt,
  testPlannerSystemPrompt,
  verificationJudgmentSystemPrompt,
  verificationFeedbackSystemPrompt,
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
  [testFileSystemPrompt(), "You are DevAsign's test file authoring step.", "test file authoring"],
  [testPlannerSystemPrompt(), "You are DevAsign's test planning step.", "test planning"],
  [verificationJudgmentSystemPrompt(), "You are DevAsign's verification judgment step.", "verification judgment"],
  [verificationFeedbackSystemPrompt(), "You are DevAsign's verification feedback step.", "verification feedback"],
];

// Every key mockComplete dispatches on, in source order.
const MOCK_KEYS = [
  "bounty criteria evaluation", "criteria synthesis", "test file authoring", "test planning", "verification judgment", "verification feedback", "Linear issue matching",
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

test("the verifier's planner and test author both know CI checks out the PR head one commit deep", () => {
  assert.match(testPlannerSystemPrompt(), /change's own footprint[\s\S]*one commit deep[\s\S]*never on git history/);
  assert.match(testFileSystemPrompt(), /one commit deep, so never read git history/);
});

test("the test author is told to write ES-module syntax for the runners that load files as ES modules", () => {
  assert.match(testFileSystemPrompt(), /node:test, the bundled runner or vitest, write ES-module syntax only[\s\S]*never `require\(\)`/);
});

// devasignhq/agent#249: the PR body's own "appNeverStarted() is the single predicate … so the
// note, the verdict reason and the repo flag can never disagree" became a criterion verbatim,
// and the verifier read its undefined "agree" as string equality across five surfaces.
test("criteria synthesis refuses a mechanism the PR described about itself, and an undefined 'agree'", () => {
  for (const prompt of [criteriaSynthesisSystemPrompt(true), criteriaSynthesisSystemPrompt(false), criteriaSynthesisSystemPrompt(false, "bounty")]) {
    assert.match(prompt, /is the author narrating their own refactor, not a requirement anyone asked for/);
    assert.match(prompt, /The PR's own description never counts as that prescription/);
    assert.match(prompt, /states exactly what must be equal between them/);
    assert.match(prompt, /driven by a single shared predicate so they always agree/, "the anti-pattern list carries the shape itself");
    assert.match(prompt, /the PR's own description prescribes nothing/);
    assert.match(prompt, /no broad criterion restates what narrower ones already pin/);
  }
});

test("emoji ban is stated in every stage prompt", () => {
  for (const [prompt] of CASES) {
    assert.match(prompt, /Never use emoji/);
  }
});
