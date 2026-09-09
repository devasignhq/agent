// The consolidated "fix everything in one paste" prompt behind the card's
// dropdown, and the card's trailing security/tests pointers. Ported from
// review-body.test.ts, which exercised these through the old single verdict
// comment. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/fix-prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConsolidatedFixPrompt,
  cardNotes,
  collectConsolidatedFindings,
} from "./pipeline.js";
import { EMPTY_HOLISTIC, type HolisticFinding, type ReviewSuggestion } from "./verdict-types.js";
import type { Criterion } from "../types.js";

const crit = (over: Partial<Criterion> = {}): Criterion => ({
  id: "C1",
  text: "Personal claims succeed when account.id matches the user's githubId.",
  met: false,
  evidence: null,
  ...over,
});

const prompt = (over: Partial<Parameters<typeof buildConsolidatedFixPrompt>[0]> = {}) =>
  buildConsolidatedFixPrompt({
    prTitle: "Gate installation claiming",
    repoFullName: "acme/widgets",
    endGoal: "Gate installation claiming on ownership.",
    unmetCriteria: [],
    suggestions: [],
    findings: [],
    ...over,
  });

test("an unmet criterion reads Required -> what's wrong now -> how to fix", () => {
  const body = prompt({
    unmetCriteria: [crit({ evidence: "linkInstallationHandler never compares account.id." })],
  });
  assert.match(body, /## Failed acceptance criteria/);
  assert.match(body, /### 1\. Required: Personal claims succeed when account\.id/);
  assert.match(body, /What's wrong now: linkInstallationHandler never compares account\.id\./);
  assert.match(body, /How to fix:/);
});

test("a criterion with no suggested patch still gets an actionable instruction", () => {
  const body = prompt({ unmetCriteria: [crit()] });
  assert.match(body, /No specific patch was suggested for this criterion\./);
  assert.match(body, /verify the criterion passes/);
});

test("a suggestion attaches across a criterionId case mismatch (C1 vs c1)", () => {
  const suggestion: ReviewSuggestion = {
    criterionId: "c1",
    title: "Compare account.id",
    rationale: "Ownership must be checked before linking.",
    fixPrompt: "Fix: compare account.id\n\nFile: src/github/oauth.ts",
  };
  const body = prompt({ unmetCriteria: [crit()], suggestions: [suggestion] });
  assert.match(body, /Fix: compare account\.id/);
  assert.doesNotMatch(body, /No specific patch was suggested/);
});

test("findings are labelled by category and severity", () => {
  const finding: HolisticFinding = {
    path: "src/a.ts",
    concern: "Missing await on flush().",
    severity: "blocker",
    fixPrompt: "Fix: await the flush",
  };
  const body = prompt({ findings: [{ label: "Bug", finding }] });
  assert.match(body, /## Review findings/);
  assert.match(body, /\[Bug · Blocker\]/);
  assert.match(body, /Fix: await the flush/);
});

test("a cross-repo impact reaches the prompt but a parity note never does", () => {
  const impact: HolisticFinding = { path: "src/a.ts", concern: "Breaks the Go SDK.", severity: "warn" };
  const parity: HolisticFinding = { path: "src/a.ts", concern: "The Go SDK lacks this.", severity: "nit" };
  const collected = collectConsolidatedFindings({
    ...EMPTY_HOLISTIC,
    crossRepoImpacts: [impact],
    parityNotes: [parity],
  });
  assert.equal(collected.length, 1);
  assert.match(collected[0].label, /Cross-repo/);
  // Pasted into an agent pointed at THIS checkout, a parity fix belongs in a
  // different repository entirely.
  assert.ok(!collected.some((c) => c.finding.concern.includes("lacks this")));
});

test("pre-existing vulnerabilities stay out of the paste prompt", () => {
  const collected = collectConsolidatedFindings({
    ...EMPTY_HOLISTIC,
    preexistingVulns: [{ path: "old.ts", concern: "latent", severity: "warn" }],
    resolvedPreexisting: [{ path: "old.ts", concern: "was fixed", severity: "warn" }],
  });
  assert.deepEqual(collected, []);
});

// ─── the card's trailing pointers ──────────────────────────────────────────

test("pre-existing security is a pointer, labelled as not introduced by this PR", () => {
  const notes = cardNotes({
    holistic: {
      ...EMPTY_HOLISTIC,
      preexistingVulns: [
        { path: "old.ts", concern: "a", severity: "warn" },
        { path: "old.ts", concern: "b", severity: "warn" },
      ],
    },
    repoFullName: "acme/widgets",
    verification: null,
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /2 pre-existing security findings touch files in this PR \(not introduced by it\)/);
  assert.match(notes[0], /\[Security page\]\(.*\/security\?repo=acme%2Fwidgets\)/);
});

test("resolved pre-existing findings get their own positive pointer", () => {
  const notes = cardNotes({
    holistic: {
      ...EMPTY_HOLISTIC,
      resolvedPreexisting: [{ path: "old.ts", concern: "fixed", severity: "warn" }],
    },
    repoFullName: "acme/widgets",
    verification: null,
  });
  assert.match(notes[0], /this PR fixes 1 previously-flagged security finding/);
});

test("a completed verification adds a pointer to the tests comment, not a section", () => {
  const notes = cardNotes({
    holistic: EMPTY_HOLISTIC,
    repoFullName: "acme/widgets",
    verification: {
      state: "completed",
      runId: "r1",
      reviewId: "rev1",
      runUrl: "https://app/reviews/rev1",
      rows: [],
      counts: { pass: 4, fail: 1, unverifiable: 0, pending: 0 },
      tests: { generated: 2, existing: 1, prAuthored: 0 },
    },
  });
  assert.match(notes[0], /\*\*Tests:\*\* 4 passed, 1 failed, 0 unverifiable/);
  assert.match(notes[0], /"Tests by DevAsign" comment/);
});

test("a clean review adds no trailing pointers at all", () => {
  assert.deepEqual(
    cardNotes({ holistic: EMPTY_HOLISTIC, repoFullName: "acme/widgets", verification: null }),
    []
  );
});
