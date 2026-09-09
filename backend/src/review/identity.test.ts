// Pure tests for wording-independent finding identity. The positive fixtures are
// the exact texts the real model produced on verify-demo#5 across two pushes —
// the cases that produced a phantom "fixed" and three threads for one bug. Run:
//   node --import tsx/esm --test src/review/identity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestMatch,
  LINE_WINDOW,
  quotedSpans,
  sameFinding,
  similarity,
  type FindingIdentity,
} from "./identity.js";

const at = (line: number | undefined, concern: string, extra: Partial<FindingIdentity> = {}): FindingIdentity => ({
  path: "src/handler.ts",
  line,
  concern,
  ...extra,
});

// The same deferral, two runs apart. Note the second quotes the TODO with double
// quotes, not backticks, and the surrounding prose has apostrophes.
const DEFERRAL_RUN1 = at(
  59,
  "Incidental: The added comment `// TODO: honour the pagination params from the ticket (page, pageSize) before shipping.` admits that pagination params (page, pageSize) from the ticket are not yet honoured. This work is deferred, but the PR description explicitly discloses pagination as a follow-up and the three acceptance criteria concern only audit-write source tagging and failure logging, so this does not undercut a stated promise of this PR."
);
const DEFERRAL_RUN2 = at(
  59,
  'Incidental: Undercuts PR description\'s pagination follow-up note (explicitly disclosed, not part of the three acceptance criteria). Verbatim admission: "// TODO: honour the pagination params from the ticket (page, pageSize) before shipping." The pagination params (page, pageSize) are not honoured; pageCount and the list slice still use a fixed PAGE_SIZE, deferring the ticket\'s pagination support.'
);

// One rethrow on line 45, as three stages described it.
const REGRESSION = at(
  45,
  'The catch block previously swallowed audit-write failures (logged a warning and continued to return the list). The diff adds `throw err;` inside the catch, so any failure of `store.put("audit", ...)` now propagates out of `listHandler`, converting a previously non-fatal audit side-effect into a hard failure of the entire list operation. Callers that relied on `listHandler` returning items even when the audit store is unavailable will now receive a rejected promise.'
);
const BUG = at(
  45,
  "The catch block now logs the audit-write failure and then rethrows it with `throw err;`. This propagates the audit failure out of listHandler, causing the entire list request to fail whenever the audit `store.put` throws, even though the audit write is a non-essential side effect and the items were already successfully loaded.",
  { defectClass: "error-handling" }
);
const NIT = at(
  45,
  "This `throw err;` re-propagates the audit-write failure out of `listHandler`, so a failed audit write makes the entire list request fail. This regresses the requirement (and the PR's stated intent) that the audit write must never fail the list request. Remove the throw so the handler still returns its successful response after logging."
);

// Genuinely different concerns on the same lines.
const LOGGER_ARGS = at(45, "The warning message interpolates the raw error object, which prints [object Object] in the structured logger.");
const LOGGER_CONTRACT = at(44, "logger.warn is called with two positional arguments but the logger contract takes a single message string.");

// ─── quoted spans ──────────────────────────────────────────────────────────

test("a long quoted span is extracted in backticks, double quotes, or single quotes", () => {
  const todo = "todohonourthepaginationparamsfromtheticketpagepagesizebeforeshipping";
  assert.ok(quotedSpans(DEFERRAL_RUN1.concern).has(todo), "backticks");
  assert.ok(quotedSpans(DEFERRAL_RUN2.concern).has(todo), "double quotes, despite the apostrophes around it");
  assert.ok(quotedSpans("the label 'Send this for review now' is wrong").size === 1, "single quotes");
});

test("apostrophes are not quote delimiters", () => {
  const spans = quotedSpans("the ticket's note says the handler's audit write can't fail the request's response");
  assert.equal(spans.size, 0);
});

test("short quoted spans are identifiers, not evidence", () => {
  assert.equal(quotedSpans("`throw err;` inside `listHandler` after `store.put`").size, 0);
});

// ─── sameFinding ───────────────────────────────────────────────────────────

test("the reworded deferral is the same finding — the quoted TODO carries it even across quote styles", () => {
  assert.ok(sameFinding(DEFERRAL_RUN1, DEFERRAL_RUN2));
  assert.ok(sameFinding(DEFERRAL_RUN2, DEFERRAL_RUN1), "symmetric");
});

test("the regression and the bug on line 45 are the same finding (shared vocabulary)", () => {
  assert.ok(similarity(REGRESSION.concern, BUG.concern) >= 0.4);
  assert.ok(sameFinding(REGRESSION, BUG));
});

test("the nit matches the bug but not the regression directly — which is why merging must cluster", () => {
  assert.ok(sameFinding(BUG, NIT));
  assert.equal(sameFinding(REGRESSION, NIT), false);
});

test("a different concern on the same line stays different", () => {
  assert.equal(sameFinding(BUG, LOGGER_ARGS), false);
  assert.equal(sameFinding(REGRESSION, LOGGER_CONTRACT), false);
  assert.equal(sameFinding(NIT, LOGGER_ARGS), false);
});

test("a different file is never the same finding, whatever the words", () => {
  assert.equal(sameFinding(BUG, { ...BUG, path: "src/other.ts" }), false);
});

test("the line window is inclusive at LINE_WINDOW and closed one past it", () => {
  const near = { ...BUG, line: BUG.line! + LINE_WINDOW };
  const far = { ...BUG, line: BUG.line! + LINE_WINDOW + 1 };
  assert.ok(sameFinding(BUG, near));
  assert.equal(sameFinding(BUG, far), false);
});

test("an identical suggested-change original is decisive on its own", () => {
  const a = at(10, "Swallows the error.", { original: "  logger.warn(\"write failed\", err);" });
  const b = at(12, "Logs and continues past a failed write.", { original: "logger.warn('write failed', err)" });
  assert.equal(similarity(a.concern, b.concern), 0, "no shared vocabulary at all");
  assert.ok(sameFinding(a, b));
});

test("a shared defect class lowers the vocabulary bar, but only nearby", () => {
  const a = at(10, "Rejects the returned promise whenever the audit write throws inside the try block.", { defectClass: "error-handling" });
  const b = at(11, "Audit write failure escapes the handler as a rejection.", { defectClass: "error-handling" });
  assert.ok(similarity(a.concern, b.concern) < 0.4);
  assert.ok(sameFinding(a, b));
  assert.equal(sameFinding(a, { ...b, line: 40 }), false);
});

test("with no line on one side the wording must nearly coincide", () => {
  const noLine = { ...BUG, line: undefined };
  assert.equal(sameFinding(noLine, REGRESSION), false, "0.6 overlap is not enough without a line");
  assert.ok(sameFinding(noLine, { ...BUG, line: undefined, concern: BUG.concern + " Extra sentence." }));
});

// ─── bestMatch ─────────────────────────────────────────────────────────────

test("bestMatch prefers the candidate with the most shared vocabulary, then the nearest line", () => {
  const picked = bestMatch(REGRESSION, [NIT, BUG, LOGGER_ARGS], (c) => c);
  assert.equal(picked, BUG);
  assert.equal(bestMatch(LOGGER_ARGS, [REGRESSION, BUG, NIT], (c) => c), null);
});
