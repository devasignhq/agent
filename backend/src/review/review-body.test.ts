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

test("unmet criterion WITH evidence: numbered entry with status + required + reasoning", () => {
  const c = crit({
    evidence:
      "linkInstallationHandler links the installation without comparing account.id to the caller's githubId.",
  });
  const body = formatReviewBody("Gate installation claiming on ownership.", [c], []);
  assert.match(body, /### Acceptance criteria not met/);
  assert.match(body, /#### 1\. C1 — Not met/);
  assert.match(body, /\*\*C1 — Not met\.\*\* Required: Personal claims succeed when account\.id/);
  assert.match(body, /\*\*Reasoning:\*\* linkInstallationHandler links the installation/);
  assert.doesNotMatch(body, EMOJI);
});

test("unmet criterion WITHOUT evidence: still gets a status, requirement, and a fallback reason", () => {
  const body = formatReviewBody("Gate installation claiming on ownership.", [crit()], []);
  assert.match(body, /#### 1\. C1 — Not met/);
  assert.match(body, /\*\*C1 — Not met\.\*\* Required: Personal claims succeed/);
  // reasonOrFallback fills the gap so the item is never bare.
  assert.match(
    body,
    /\*\*Reasoning:\*\* The current diff doesn't yet show this requirement being satisfied\./
  );
  assert.doesNotMatch(body, EMOJI);
});

test("criterion with NO verdict (met:null) renders 'Could not be evaluated', not a false 'Not met'", () => {
  const body = formatReviewBody(
    "Gate installation claiming on ownership.",
    [crit({ met: null, evidence: null })],
    []
  );
  assert.match(body, /#### 1\. C1 — Could not be evaluated/);
  assert.match(body, /\*\*C1 — Could not be evaluated\.\*\* Required: Personal claims succeed/);
  assert.match(
    body,
    /\*\*Reasoning:\*\* The reviewer could not evaluate this requirement against the diff/
  );
  // It must NOT claim positive evidence of failure.
  assert.doesNotMatch(body, /C1 — Not met/);
  assert.doesNotMatch(body, /doesn't yet show this requirement being satisfied/);
  assert.doesNotMatch(body, EMOJI);
});

test("unmet criterion with a full suggestion: file heading, Reasoning, Suggested Change diff, Full Code", () => {
  const c = crit({ evidence: "no ownership comparison is performed." });
  const suggestion = {
    criterionId: "C1",
    title: "Gate the claim on verified ownership",
    rationale: "Compare account.id to the caller's githubId before linking.",
    path: "backend/src/routes/install.ts",
    line: 42,
    suggestedChange:
      '+  if (account.id !== caller.githubId) {\n+    return res.status(403).json({ error: "not_owner" });\n+  }',
    codeExample: "async function linkInstallationHandler(req, res) {\n  // updated\n}",
    language: "typescript",
    fixPrompt: "Fix: gate claim on ownership\n\nExpected behavior:\nReject with 403.",
  };
  const body = formatReviewBody(
    "Gate installation claiming on ownership.",
    [c],
    [suggestion],
    EMPTY_HOLISTIC,
    { prTitle: "Gate installation claiming", repoFullName: "devasign/app" }
  );
  // Screenshot-style heading: numbered, file path + line, one-line title.
  assert.match(
    body,
    /#### 1\. \*\*backend\/src\/routes\/install\.ts\*\* \(Line 42\) — Gate the claim on verified ownership/
  );
  assert.match(body, /\*\*C1 — Not met\.\*\* Required: Personal claims succeed/);
  // Reasoning merges the criterion evidence with the suggestion rationale.
  assert.match(
    body,
    /\*\*Reasoning:\*\* no ownership comparison is performed\. Compare account\.id to the caller's githubId/
  );
  assert.match(body, /\*\*Suggested Change:\*\*/);
  assert.match(body, /```diff\n\+ {2}if \(account\.id !== caller\.githubId\)/);
  assert.match(body, /\*\*Full Code:\*\*/);
  assert.match(body, /```typescript\nasync function linkInstallationHandler/);
  // The suggestion was consumed inline — no residual section, no inline prompt.
  assert.doesNotMatch(body, /### Suggested changes/);
  assert.doesNotMatch(body, /\*\*Prompt for your AI agent:\*\*/);
  // The consolidated dropdown still carries the copyable prompt.
  assert.match(body, /One prompt to fix all of this/);
  assert.match(body, /Fix: gate claim on ownership/);
  assert.doesNotMatch(body, EMOJI);
});

test("orphan suggestion (no matching unmet criterion) renders under 'Suggested changes' without an inline prompt", () => {
  const suggestion = {
    criterionId: "C9",
    title: "Tighten the retry loop",
    rationale: "Only retry on 5xx responses.",
    suggestedChange: "-  if (err) retry();\n+  if (err.status >= 500) retry();",
    fixPrompt: "Fix: scope retry to 5xx",
  };
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [suggestion]);
  assert.match(body, /### Suggested changes/);
  assert.match(body, /#### For C9 — Tighten the retry loop/);
  assert.match(body, /```diff\n- {2}if \(err\) retry\(\);/);
  assert.doesNotMatch(body, /\*\*Prompt for your AI agent:\*\*/);
  assert.doesNotMatch(body, EMOJI);
});

test("suggestedChange containing a triple-backtick run is wrapped in a wider fence", () => {
  const c = crit({ evidence: "docs fence is malformed." });
  const suggestion = {
    criterionId: "C1",
    title: "Fix the docs fence",
    rationale: "Close the code fence.",
    suggestedChange: "+ ```js\n+ const x = 1;\n+ ```",
  };
  const body = formatReviewBody("Some goal.", [c], [suggestion]);
  // codeFence must widen past the inner ``` run so GitHub doesn't close early.
  assert.match(body, /````+diff\n\+ ```js/);
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
  // Pointer-only: the comment carries a count + Security-page link, never the
  // finding detail (that lives on the Security page).
  assert.match(body, /1 pre-existing security finding touches files in this PR/);
  assert.match(body, /not introduced by it/);
  assert.match(body, /\/security\?repo=devasign%2Fapp/);
  assert.doesNotMatch(body, /\[sql-injection\] User input concatenated/);
  // Advisory: it must NOT be filed under the introduced-findings "Repo-wide concerns".
  assert.doesNotMatch(body, /### Repo-wide concerns/);
  // Pre-existing findings no longer ride the consolidated "fix all" prompt —
  // with nothing else to fix, the prompt is omitted entirely.
  assert.doesNotMatch(body, /One prompt to fix all of this/);
  assert.doesNotMatch(body, EMOJI);
});

test("new commits: 'New commits since last review' section renders summary + intent finding", () => {
  const holistic = {
    ...EMPTY_HOLISTIC,
    commitIntentSummary: "The new commit adds retry-on-5xx to the uploader and a config flag.",
    commitIntentFindings: [
      {
        path: "src/upload.ts",
        concern: "Commit says 'retry on 5xx' but the new code retries on any error, including 4xx.",
        severity: "warn" as const,
        fixPrompt: "Fix: scope retry to 5xx\n\nFile: src/upload.ts",
      },
    ],
  };
  const body = formatReviewBody(
    "Some goal.",
    [crit({ met: true, evidence: "ok" })],
    [],
    holistic,
    { prTitle: "Add retry", repoFullName: "devasign/app" }
  );
  assert.match(body, /### New commits since last review/);
  assert.match(body, /adds retry-on-5xx to the uploader/);
  assert.match(body, /retries on any error, including 4xx/);
  assert.doesNotMatch(body, EMOJI);
});

test("new commits: section is omitted when there's no summary and no intent findings", () => {
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [], EMPTY_HOLISTIC);
  assert.doesNotMatch(body, /### New commits since last review/);
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

// ─── Defect findings ────────────────────────────────────────────────────────
// The defect section is the one that can fail an otherwise-passing PR, so these
// pin that it renders its own section (not folded into Repo-wide concerns), that
// the failure scenario survives to the reader, and — the subtle one — that the
// spec-less "no blocking bugs surfaced" copy can't print above a list of bugs.

const defect = (over: Record<string, unknown> = {}) => ({
  path: "backend/src/pay.ts",
  defectClass: "unhandled-error",
  concern: "The catch block swallows the provider error and returns a success response.",
  failureScenario:
    "A 500 from the payment provider is reported to the caller as a completed charge; the order ships unpaid.",
  severity: "blocker" as const,
  fixPrompt: "Fix: rethrow the provider error\n\nFile: backend/src/pay.ts",
  ...over,
});

test("defects: own section with the bug class, the failure scenario, and a blocking count", () => {
  const holistic = { ...EMPTY_HOLISTIC, defects: [defect()] };
  const body = formatReviewBody(
    "Charge the card on checkout.",
    [crit({ met: true, evidence: "ok" })],
    [],
    holistic,
    { prTitle: "Add checkout", repoFullName: "devasign/app" }
  );
  assert.match(body, /### Bugs and correctness issues/);
  assert.match(body, /1 of these blocks the merge/);
  assert.match(body, /\*\*Blocker\*\* — `backend\/src\/pay\.ts` — `unhandled-error`/);
  assert.match(body, /\*\*How it fails:\*\* A 500 from the payment provider/);
  // Its own section — not folded into the introduced-findings block.
  assert.doesNotMatch(body, /### Repo-wide concerns/);
  assert.doesNotMatch(body, EMOJI);
});

test("defects: a warn-only set says nothing blocks the merge", () => {
  const holistic = { ...EMPTY_HOLISTIC, defects: [defect({ severity: "warn" as const })] };
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [], holistic, {
    prTitle: "PR",
    repoFullName: "devasign/app",
  });
  assert.match(body, /None of these block the merge/);
  assert.match(body, /^- Warn — /m);
});

test("defects ride the consolidated one-paste fix prompt", () => {
  const holistic = { ...EMPTY_HOLISTIC, defects: [defect()] };
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [], holistic, {
    prTitle: "Add checkout",
    repoFullName: "devasign/app",
  });
  assert.match(body, /One prompt to fix all of this/);
  assert.match(body, /Fix: rethrow the provider error/);
});

test("spec-less PR with defects: does NOT claim no bugs surfaced", () => {
  const holistic = { ...EMPTY_HOLISTIC, defects: [defect()] };
  const body = formatReviewBody("", [], [], holistic, {
    prTitle: "Add checkout",
    repoFullName: "devasign/app",
  });
  assert.doesNotMatch(body, /No blocking bugs, regressions, or security concerns surfaced/);
  assert.match(body, /### Bugs and correctness issues/);
});

test("defects: section omitted entirely when the pass found nothing", () => {
  const body = formatReviewBody("Some goal.", [crit({ met: true, evidence: "ok" })], [], EMPTY_HOLISTIC);
  assert.doesNotMatch(body, /### Bugs and correctness issues/);
});

// ── Structured evidence/patch rendering (upgraded prompt contract) ───────────

test("unmet criterion with structured suggestedChange renders a before/after diff block", () => {
  const c = crit({
    evidence: "The label is still 'Submit'.",
    suggestedChange: {
      path: "src/handler.ts",
      startLine: 52,
      original: "<button>Submit</button>",
      suggested: "<button>Send for review</button>",
    },
  });
  const body = formatReviewBody("Goal.", [c], []);
  assert.match(body, /\*\*Suggested change\*\* \(`src\/handler\.ts:52`\):/);
  assert.match(body, /```diff/);
  assert.match(body, /^-<button>Submit<\/button>$/m);
  assert.match(body, /^\+<button>Send for review<\/button>$/m);
  assert.doesNotMatch(body, EMOJI);
});

test("criterion evidenceCode renders with its file anchor and language fence", () => {
  const c = crit({
    evidence: "Guard added.",
    evidenceCode: {
      path: "src/handler.ts",
      startLine: 40,
      language: "typescript",
      code: "if (!items?.length) return { items: [] };",
    },
  });
  const body = formatReviewBody("Goal.", [c], []);
  assert.match(body, /\*\*Evidence\*\* \(`src\/handler\.ts:40`\):/);
  assert.match(body, /```typescript/);
  assert.match(body, /if \(!items\?\.length\) return \{ items: \[\] \};/);
});

test("a suggestion patch identical to the criterion's is rendered once, not twice", () => {
  const patch = {
    path: "src/handler.ts",
    startLine: 52,
    original: "<button>Submit</button>",
    suggested: "<button>Send for review</button>",
  };
  const c = crit({ evidence: "e", suggestedChange: patch });
  const body = formatReviewBody("Goal.", [c], [
    { criterionId: "C1", title: "Rename", rationale: "r", severity: "warn", patch },
  ]);
  const occurrences = body.split("**Suggested change**").length - 1;
  assert.equal(occurrences, 1, "identical criterion+suggestion patch must render once");
});

test("legacy criteria without the new fields render exactly as before (no new blocks)", () => {
  const body = formatReviewBody("Goal.", [crit({ evidence: "old row" })], []);
  assert.doesNotMatch(body, /\*\*Suggested change\*\*/);
  assert.doesNotMatch(body, /\*\*Evidence\*\* \(/);
});

test("patch with backtick runs still fences safely", () => {
  const c = crit({
    evidence: "e",
    suggestedChange: {
      path: "README.md",
      startLine: 1,
      original: "``` old fence",
      suggested: "```` new fence",
    },
  });
  const body = formatReviewBody("Goal.", [c], []);
  // The wrapping fence must be longer than the longest inner run (4) — 5+.
  assert.match(body, /`{5,}diff/);
});
