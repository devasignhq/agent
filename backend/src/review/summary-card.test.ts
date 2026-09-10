// Pure tests for the summary card — the editable conversation comment. No db /
// network / LLM. Run:
//   node --import tsx/esm --test src/review/summary-card.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_HEAD_END,
  CARD_HEAD_START,
  CARD_TITLE,
  MAX_CARD_ITEM_BLOCKS,
  formatCardHeader,
  formatChips,
  formatSummaryCard,
  spliceCardHeader,
  summaryLines,
  type CardVerification,
} from "./comment.js";
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

test("a clean review says so, without an icon, and met criteria never appear as a chip", () => {
  const open = items({ criteria: [{ id: "1", text: "a", met: true, evidence: null }] });
  assert.equal(formatChips(open), "`No issues found`");
});

test("failing tests get a chip, and a clean review with failing tests is not 'no issues'", () => {
  assert.equal(formatChips([], 0, 2), "❌ `Tests failing (2)`");
  const open = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } });
  assert.equal(formatChips(open, 1, 1), "🐞 `Bugs (1)` · ❌ `Tests failing (1)` · ✅ `Fixed since last review (1)`");
});

test("fixed items get their own chip alongside whatever is still open", () => {
  const open = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } });
  assert.equal(formatChips(open, 2), "🐞 `Bugs (1)` · ✅ `Fixed since last review (2)`");
  assert.equal(formatChips([], 2), "`No issues found` · ✅ `Fixed since last review (2)`");
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
  const lines = body.split("\n").filter((l) => l && !l.startsWith("<!--"));
  assert.equal(lines[0], CARD_TITLE);
  assert.equal(lines[1], "🐞 `Bugs (1)`");
  assert.equal(lines[2], "### 🟡 Merge score: 63/100");
  assert.equal(body.split(CARD_HEAD_START).length, 2, "the head region is marked exactly once");
  assert.equal(body.split(CARD_HEAD_END).length, 2);
});

// ─── verification on the card ──────────────────────────────────────────────

const verification = (over: Partial<CardVerification> & { counts: CardVerification["counts"] }): CardVerification => ({
  state: "completed",
  rows: [],
  ...over,
});

test("failing tests lower the score, add a chip, and point at the tests comment", () => {
  const body = card({
    score: 100,
    verification: verification({ counts: { pass: 3, fail: 1, unverifiable: 0, pending: 0 } }),
  });
  assert.match(body, /❌ `Tests failing \(1\)`/);
  assert.doesNotMatch(body, /No issues found/);
  assert.match(body, /### ✅ Merge score: 90\/100/);
  assert.match(body, /⚠️ \*\*1 of 4 verified tests are failing\*\* — check the "Tests by DevAsign" comment before merging\./);
  assert.doesNotMatch(body, /Do not merge/);
});

test("every test failing caps the score in the red and says do not merge, naming each failure", () => {
  const body = card({
    score: 100,
    verification: verification({
      counts: { pass: 0, fail: 2, unverifiable: 1, pending: 0 },
      rows: [
        { id: "1", text: "Refunds show", verdict: "fail", reason: "refunds line missing", testName: ".devasign/tests/one.test.ts" },
        { id: "2", text: "Total is currency", verdict: "fail", reason: "x".repeat(400) },
        { id: "3", text: "Logging quiet", verdict: "unverifiable", reason: "no test ran" },
      ],
    }),
  });
  assert.match(body, /### 🔴 Merge score: 49\/100/);
  assert.match(body, /🔴 \*\*Do not merge\.\*\* Every verified acceptance-criterion test failed \(2 of 2\)\./);
  assert.match(body, /- \*\*1\*\* — Refunds show: refunds line missing \(`\.devasign\/tests\/one\.test\.ts`\)/);
  assert.match(body, /- \*\*2\*\* — Total is currency: x{199}…/);
  assert.doesNotMatch(body, /- \*\*3\*\*/, "only failures are listed");
  assert.match(body, /Fix the criteria above so their tests pass, then push/);
});

test("a completed verification with no failures is a plain pointer; an unfinished one changes nothing", () => {
  const clean = card({ score: 92, verification: verification({ counts: { pass: 2, fail: 0, unverifiable: 1, pending: 0 } }) });
  assert.match(clean, /### ✅ Merge score: 92\/100/);
  assert.match(clean, /\*\*Tests:\*\* 2 passed, 1 unverifiable — see the "Tests by DevAsign" comment\./);
  const pending = card({ score: 92, verification: verification({ state: "pending", counts: { pass: 0, fail: 0, unverifiable: 0, pending: 3 } }) });
  assert.doesNotMatch(pending, /Tests/);
  assert.equal(pending, card({ score: 92 }));
});

test("the head region can be re-rendered in place once verification lands", () => {
  const inputs = { open: [], fixedCount: 0, score: 100, specless: false, criteriaTotal: 2, criteriaMet: 2, summary: "Looks good." };
  const before = card({ ...inputs, unanchored: items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding({ path: undefined })] } }) });
  assert.equal(spliceCardHeader(before, formatCardHeader(inputs)), before, "unchanged inputs round-trip byte for byte");
  const after = spliceCardHeader(
    before,
    formatCardHeader(inputs, verification({ counts: { pass: 1, fail: 1, unverifiable: 0, pending: 0 } }))
  )!;
  assert.match(after, /### ✅ Merge score: 90\/100/);
  assert.match(after, /Tests failing \(1\)/);
  assert.ok(after.includes("Missing await on flush()"), "the tail of the card survives the splice");
  assert.equal(after.split(CARD_HEAD_START).length, 2);
  assert.doesNotMatch(after, /\n{3,}/);
  assert.equal(spliceCardHeader("## DevAsign Code Review\n\nold card without markers", formatCardHeader(inputs)), null);
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

test("items that never reached a thread are still on the card: unanchored as blocks, overflow as a list", () => {
  const unanchored = items({ holistic: { ...EMPTY_HOLISTIC, crossRepoImpacts: [finding({ path: undefined, concern: "breaks the Go SDK", severity: "warn" })] } });
  const overflow = items({ holistic: { ...EMPTY_HOLISTIC, conventionFindings: [finding({ path: "v.ts", concern: "prefer const", severity: "nit" })] } });
  const met = items({ criteria: [{ id: "9", text: "logging stays quiet", met: true, evidence: null }] });
  const body = card({ unanchored, overflow, metWithoutThread: met });
  assert.match(body, /<summary>🔗 Cross-repo — breaks the Go SDK<\/summary>/, "an unanchored item is its own collapsed block");
  assert.doesNotMatch(body, /Other findings — not anchored to the diff/);
  assert.doesNotMatch(body, /devasign:item/, "card blocks carry no thread marker");
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
  assert.match(body, /<summary>📋 Acceptance criterion not met — #2<\/summary>/);
  assert.match(body, /\*\*Required:\*\* claims are gated/);
});

test("an unanchored block has the same shape as a thread body, minus the marker", () => {
  const [item] = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding({ path: undefined, fixPrompt: "Await it.\n\n```diff\n-a\n+b\n```" } as any)] } });
  const body = card({ unanchored: [item] });
  const at = body.indexOf("<details>\n<summary>🐞 Bug (blocker)");
  assert.ok(at > 0, "block present");
  const lines = body.slice(at).split("\n");
  assert.equal(lines[2], "", "blank line after </summary>");
  assert.match(body, /<summary>Prompt to fix with AI<\/summary>/);
});

test("blocks stop at the cap and at the size budget; the rest fall back to the list", () => {
  const many = Array.from({ length: MAX_CARD_ITEM_BLOCKS + 5 }, (_, i) =>
    finding({ path: `src/module-${i}.ts`, concern: `Unanchored finding number ${i} about a distinct subsystem ${i}.` })
  );
  const unanchored = items({ holistic: { ...EMPTY_HOLISTIC, defects: many } });
  assert.equal(unanchored.length, many.length, "each finding is its own item");
  const body = card({ unanchored });
  assert.equal(body.match(/<summary>🐞 Bug \(blocker\) — /g)!.length, MAX_CARD_ITEM_BLOCKS);
  assert.match(body, /<summary>Other findings — not anchored to the diff \(5\)<\/summary>/);

  const huge = items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding({ path: undefined, fixPrompt: "x".repeat(70_000) } as any)] } });
  const small = card({ unanchored: huge });
  assert.doesNotMatch(small, /<summary>🐞 Bug \(blocker\) — /);
  assert.match(small, /<summary>Other findings — not anchored to the diff \(1\)<\/summary>/);
  assert.ok(small.length < 65_536);
});
