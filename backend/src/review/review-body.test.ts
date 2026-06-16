// Pure-body tests for formatReviewBody — the "changes requested" rendering of
// unmet acceptance criteria and the consolidated "one prompt to fix all" block.
// No db / network / LLM (mirrors progress-comment.test.ts / criteria-format.test.ts). Run:
//   node --import tsx/esm --test src/review/review-body.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewBody, EMPTY_HOLISTIC } from "./pipeline.js";
import type { Criterion } from "../types.js";

// PR comments are emoji-free by product decision.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const crit = (over: Partial<Criterion> = {}): Criterion => ({
  id: "C1",
  text: "Personal claims succeed when account.id matches the user's githubId.",
  met: false,
  evidence: null,
  ...over,
});

test("unmet criterion WITH evidence: status + required + why", () => {
  const c = crit({
    evidence:
      "linkInstallationHandler links the installation without comparing account.id to the caller's githubId.",
  });
  const body = formatReviewBody("Gate installation claiming on ownership.", [c], [], "");
  assert.match(body, /## Acceptance criteria not met/);
  assert.match(body, /\*\*C1 — Not met\*\*/);
  assert.match(body, /- Required: Personal claims succeed when account\.id/);
  assert.match(body, /- Why it's not met: linkInstallationHandler links the installation/);
  assert.doesNotMatch(body, EMOJI);
});

test("unmet criterion WITHOUT evidence: still gets a status, requirement, and a fallback reason", () => {
  const body = formatReviewBody("Gate installation claiming on ownership.", [crit()], [], "");
  assert.match(body, /\*\*C1 — Not met\*\*/);
  assert.match(body, /- Required: Personal claims succeed/);
  // reasonOrFallback fills the gap so the item is never bare.
  assert.match(
    body,
    /- Why it's not met: The current diff doesn't yet show this requirement being satisfied\./
  );
  assert.doesNotMatch(body, EMOJI);
});

test("regressed criterion: rendered under 'Previously met — now broken' with Required + What broke", () => {
  const c = crit({ evidence: "the ownership check was removed in this commit." });
  const prior = new Map([["C1", { met: true, evidence: "added the check" }]]);
  const body = formatReviewBody(
    "Gate installation claiming on ownership.",
    [c],
    [],
    "",
    EMPTY_HOLISTIC,
    undefined,
    prior
  );
  assert.match(body, /## Previously met — now broken/);
  assert.match(body, /\*\*C1 — Regressed\*\*/);
  assert.match(body, /- What broke: the ownership check was removed/);
  assert.doesNotMatch(body, EMOJI);
});

test("consolidated fix prompt: Required → What's wrong now → How to fix, no-suggestion fallback", () => {
  const c = crit({ evidence: "no ownership comparison is performed." });
  const body = formatReviewBody(
    "Gate installation claiming on ownership.",
    [c],
    [],
    "",
    EMPTY_HOLISTIC,
    { prTitle: "Gate installation claiming", repoFullName: "devasign/app" }
  );
  assert.match(body, /One prompt to fix all of this/);
  assert.match(body, /### 1\. Required: Personal claims succeed.*\(C1\)/);
  assert.match(body, /What's wrong now: no ownership comparison is performed\./);
  assert.match(body, /How to fix:/);
  // With no suggestion attached, the fallback points back at the Required behavior.
  assert.match(body, /Implement the change so the Required behavior above holds/);
  assert.doesNotMatch(body, EMOJI);
});
