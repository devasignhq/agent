// Pure tests for the summary card — the editable conversation comment. No db /
// network / LLM. Run:
//   node --import tsx/esm --test src/review/summary-card.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARD_TITLE, formatChips, formatSummaryCard, summaryLines } from "./comment.js";
import { buildReviewItems, type ReviewItem } from "./items.js";
import { EMPTY_HOLISTIC, type HolisticFinding } from "./verdict-types.js";
import type { PriorVerdict } from "./criteria-format.js";

const finding = (over: Partial<HolisticFinding> = {}): HolisticFinding => ({
  path: "src/a.ts",
  concern: "Missing await on flush().",
  severity: "blocker",
  ...over,
});

const items = (over: Partial<Parameters<typeof buildReviewItems>[0]> = {}): ReviewItem[] =>
  buildReviewItems({
    criteria: [],
    prior: new Map<string, PriorVerdict>(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
    ...over,
  });

const card = (over: Partial<Parameters<typeof formatSummaryCard>[0]> = {}) =>
  formatSummaryCard({
    open: [],
    fixedCount: 0,
    score: 100,
    specless: false,
    criteriaTotal: 0,
    criteriaMet: 0,
    summary: "",
    ...over,
  });

// ─── chips ─────────────────────────────────────────────────────────────────

test("chips render as emoji plus an inline code span, in display order", () => {
  const open = items({
    criteria: [{ id: "1", text: "a", met: false, evidence: null }],
    holistic: {
      ...EMPTY_HOLISTIC,
      defects: [finding({ path: "d.ts" })],
      criticalErrors: [finding({ path: "c.ts", concern: "boom" })],
      securityFindings: [finding({ path: "s.ts", concern: "sec", securitySeverity: "low" })],
      conventionFindings: [finding({ path: "v.ts", concern: "nit", severity: "nit" })],
    },
  });
  assert.equal(
    formatChips(open),
    "📋 `Criteria not met (1)` · 🐞 `Bugs (2)` · 🔒 `Security (1)` · 📝 `Nitpicks (1)`"
  );
});

test("zero-count chips are omitted entirely", () => {
  const open = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } });
  assert.equal(formatChips(open), "🐞 `Bugs (1)`");
});

test("a clean review says so, and met criteria never appear as a chip", () => {
  const open = items({ criteria: [{ id: "1", text: "a", met: true, evidence: null }] });
  assert.equal(formatChips(open), "✅ `No issues found`");
});

test("fixed items get their own chip alongside whatever is still open", () => {
  const open = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } });
  assert.equal(formatChips(open, 2), "🐞 `Bugs (1)` · ✅ `Fixed since last review (2)`");
  assert.equal(formatChips([], 2), "✅ `No issues found` · ✅ `Fixed since last review (2)`");
});

test("the counts reflect the CURRENT open set — fixing 2 of 2 and adding 1 reads Bugs (1)", () => {
  const before = items({
    holistic: { ...EMPTY_HOLISTIC, defects: [finding({ path: "a.ts" }), finding({ path: "b.ts" })] },
  });
  assert.equal(formatChips(before), "🐞 `Bugs (2)`");
  const after = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding({ path: "c.ts" })] } });
  assert.equal(formatChips(after, 2), "🐞 `Bugs (1)` · ✅ `Fixed since last review (2)`");
});

// ─── summary ───────────────────────────────────────────────────────────────

test("the summary leads with criteria arithmetic and never exceeds three lines", () => {
  const lines = summaryLines({
    specless: false,
    criteriaTotal: 14,
    criteriaMet: 12,
    summary: "The handler is close. One path still skips the ownership check. Also worth a second look at the retry loop, which could spin. And a fourth sentence.",
  });
  assert.equal(lines[0], "12 of 14 acceptance criteria met, 2 not met.");
  assert.ok(lines.length <= 3, `expected <= 3 lines, got ${lines.length}`);
});

test("all criteria met reads as a full stop, not '0 not met'", () => {
  const lines = summaryLines({ specless: false, criteriaTotal: 3, criteriaMet: 3, summary: "" });
  assert.deepEqual(lines, ["3 of 3 acceptance criteria met."]);
});

test("a spec-less PR says why there are no criteria instead of inventing them", () => {
  const lines = summaryLines({ specless: true, criteriaTotal: 0, criteriaMet: 0, summary: "" });
  assert.match(lines[0], /no linked issue or spec.*reviewed for correctness only/);
  assert.doesNotMatch(lines[0], /0 of 0/);
});

test("a runaway summary is clamped rather than pasted whole", () => {
  const lines = summaryLines({
    specless: false,
    criteriaTotal: 1,
    criteriaMet: 1,
    summary: "x".repeat(2000),
  });
  assert.ok(lines[1].length <= 300, `expected <= 300 chars, got ${lines[1].length}`);
});

// ─── the card ──────────────────────────────────────────────────────────────

test("the card leads with the title, then chips, then the scored header", () => {
  const body = card({ open: items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } }), score: 63 });
  const lines = body.split("\n").filter(Boolean);
  assert.equal(lines[0], CARD_TITLE);
  assert.equal(lines[1], "🐞 `Bugs (1)`");
  assert.equal(lines[2], "### 🟡 Merge score: 63/100");
});

test("the score icon tracks the band", () => {
  assert.match(card({ score: 92 }), /### ✅ Merge score: 92\/100/);
  assert.match(card({ score: 63 }), /### 🟡 Merge score: 63\/100/);
  assert.match(card({ score: 20 }), /### 🔴 Merge score: 20\/100/);
});

test("the fix-all prompt is a collapsed block, fenced past its own inner diff fence", () => {
  const body = card({ fixPrompt: "Fix everything.\n\n```diff\n-a\n+b\n```" });
  assert.match(body, /<summary>Prompt to fix all issues<\/summary>/);
  assert.match(body, /^````$/m);
  assert.match(body, /```diff\n-a\n\+b\n```/);
});

test("with nothing to fix there is no prompt block at all", () => {
  const body = card();
  assert.doesNotMatch(body, /Prompt to fix all issues/);
  assert.doesNotMatch(body, /<details>/);
});

test("items that never reached a thread are still listed on the card", () => {
  const unanchored = items({ holistic: { ...EMPTY_HOLISTIC, crossRepoImpacts: [finding({ path: undefined, concern: "breaks the Go SDK", severity: "warn" })] } });
  const overflow = items({ holistic: { ...EMPTY_HOLISTIC, conventionFindings: [finding({ path: "v.ts", concern: "prefer const", severity: "nit" })] } });
  const met = items({ criteria: [{ id: "9", text: "logging stays quiet", met: true, evidence: null }] });
  const body = card({ unanchored, overflow, metWithoutThread: met });
  assert.match(body, /<summary>Other findings — not anchored to the diff \(1\)<\/summary>/);
  assert.match(body, /- \*\*Cross-repo\*\* — breaks the Go SDK/);
  assert.match(body, /<summary>Not shown inline \(1\)<\/summary>/);
  assert.match(body, /- \*\*Convention\*\* — `v\.ts` — prefer const/);
  assert.match(body, /<summary>Met criteria \(1\)<\/summary>/);
  assert.match(body, /- \*\*Acceptance criterion\*\* — logging stays quiet/);
});

test("trailing notes and the end-goal CTA land after the body", () => {
  const body = card({
    notes: ["**Security:** 2 pre-existing findings touch files in this PR.", ""],
    cta: "## Want a deeper, goal-based review?",
  });
  assert.match(body, /\*\*Security:\*\* 2 pre-existing findings/);
  assert.match(body, /## Want a deeper, goal-based review\?/);
  assert.ok(body.trimEnd() === body, "no trailing whitespace");
});

test("the card never emits a run of blank lines or a stray trailing separator", () => {
  const body = card({
    open: items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } }),
    summary: "Looks close.",
    notes: ["", ""],
  });
  assert.doesNotMatch(body, /\n{3,}/);
  assert.doesNotMatch(body, /---\s*$/);
});

test("a met criterion with no thread is listed once, under Met criteria only", () => {
  // The thread phase failing (or being turned off) hands every item back to the
  // card, met criteria included — they must not also read as unresolved findings.
  const all = items({
    criteria: [
      { id: "1", text: "logging stays quiet", met: true, evidence: null },
      { id: "2", text: "claims are gated", met: false, evidence: null },
    ],
  });
  const body = card({
    open: all,
    unanchored: all,
    metWithoutThread: all.filter((i) => i.state === "met"),
  });
  assert.equal(body.match(/logging stays quiet/g)!.length, 1, "listed exactly once");
  assert.match(body, /<summary>Met criteria \(1\)<\/summary>/);
  assert.match(body, /<summary>Other findings — not anchored to the diff \(1\)<\/summary>/);
  assert.match(body, /- \*\*Acceptance criterion\*\* — claims are gated/);
});
