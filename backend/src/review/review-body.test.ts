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
  const body = formatReviewBody("Gate installation claiming on ownership.", [c], []);
  assert.match(body, /### Acceptance criteria not met/);
  assert.match(body, /\*\*C1 — Not met\*\*/);
  assert.match(body, /- Required: Personal claims succeed when account\.id/);
  assert.match(body, /- Why it's not met: linkInstallationHandler links the installation/);
  assert.doesNotMatch(body, EMOJI);
});

test("unmet criterion WITHOUT evidence: still gets a status, requirement, and a fallback reason", () => {
  const body = formatReviewBody("Gate installation claiming on ownership.", [crit()], []);
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
    EMPTY_HOLISTIC,
    undefined,
    prior
  );
  assert.match(body, /### Previously met — now broken/);
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

test("consolidated fix prompt: suggestion attaches across criterionId case mismatch (C1 vs c1)", () => {
  // Synthesis ids are often uppercase ("C1") while the review LLM echoes the
  // suggestion's criterionId lowercase ("c1"). The match must be case-insensitive
  // so the specific patch lands instead of the generic "no specific patch" line.
  const c = crit({ id: "C1", evidence: "no ownership comparison is performed." });
  const suggestion = {
    criterionId: "c1",
    title: "Gate the claim on verified ownership",
    rationale: "Compare account.id to the caller's githubId before linking.",
    fixPrompt: "Fix: gate claim on ownership\n\nExpected behavior:\nReject with 403 unless account.id === caller.githubId.",
  };
  const body = formatReviewBody(
    "Gate installation claiming on ownership.",
    [c],
    [suggestion],
    EMPTY_HOLISTIC,
    { prTitle: "Gate installation claiming", repoFullName: "devasign/app" }
  );
  // The suggestion's fixPrompt is embedded under the criterion...
  assert.match(body, /Fix: gate claim on ownership/);
  assert.match(body, /Expected behavior:/);
  // ...and the generic fallback is NOT used.
  assert.doesNotMatch(body, /No specific patch was suggested for this criterion/);
  assert.doesNotMatch(body, EMOJI);
});

test("suggestion codeExample: opening fence carries the language token so GitHub colors it", () => {
  // GitHub applies syntax coloring only when the opening fence is tagged with a
  // language; the closing fence stays bare.
  const suggestion = {
    criterionId: "C1",
    title: "Use a typed guard",
    rationale: "Add a null check.",
    codeExample: "const x = 1;",
    language: "typescript",
  };
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [suggestion]);
  assert.match(body, /```typescript\nconst x = 1;\n```/);
  assert.doesNotMatch(body, EMOJI);
});

test("suggestion codeExample: a malformed language token is dropped to a bare fence", () => {
  // fenceLang rejects anything with whitespace/junk so it can't corrupt the
  // fence info string — we fall back to the prior bare-fence behavior.
  const suggestion = {
    criterionId: "C1",
    title: "Use a typed guard",
    rationale: "Add a null check.",
    codeExample: "const x = 1;",
    language: "ts; rm -rf",
  };
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [suggestion]);
  assert.match(body, /```\nconst x = 1;\n```/);
  assert.doesNotMatch(body, /rm -rf/);
  assert.doesNotMatch(body, EMOJI);
});

test("pre-existing vulnerabilities: advisory section, labelled 'not introduced by this PR', not under Repo-wide concerns", () => {
  const holistic = {
    ...EMPTY_HOLISTIC,
    preexistingVulns: [
      {
        path: "backend/src/db.ts",
        concern:
          "[sql-injection] User input concatenated into a raw query (runQuery:12) — pre-existing in this file, not introduced by this PR.",
        severity: "warn" as const,
        fixPrompt: "Fix: parameterize the query\n\nFile: backend/src/db.ts",
      },
    ],
  };
  const body = formatReviewBody(
    "Some goal.",
    [crit({ met: true, evidence: "ok" })],
    [],
    holistic,
    { prTitle: "Touch db.ts", repoFullName: "devasign/app" }
  );
  assert.match(body, /### Pre-existing security issues/);
  assert.match(body, /not introduced by this PR/);
  assert.match(body, /\[sql-injection\] User input concatenated/);
  // Advisory: it must NOT be filed under the introduced-findings "Repo-wide concerns".
  assert.doesNotMatch(body, /### Repo-wide concerns/);
  // It still rides the consolidated "fix all" prompt (findings.length > 0 even with no unmet criteria).
  assert.match(body, /One prompt to fix all of this/);
  assert.doesNotMatch(body, EMOJI);
});

test("clean pass: no trailing prose recap or stray '---' divider after the met-criteria block", () => {
  // All criteria met, no holistic findings — the body should end at the collapsed
  // "Show met criteria" block. The old verdict-summary recap (a final `---` + prose
  // paragraph) is gone; the headline and criteria sections carry the verdict.
  const met = crit({ met: true, evidence: "the ownership check is present." });
  const body = formatReviewBody("Gate installation claiming on ownership.", [met], []);
  assert.match(body, /### All 1 acceptance criteria met/);
  assert.match(body, /<details><summary>Show met criteria<\/summary>/);
  assert.doesNotMatch(body, /---/);
  assert.match(body.trimEnd(), /<\/details>$/);
  assert.doesNotMatch(body, EMOJI);
});
