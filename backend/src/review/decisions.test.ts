// Pure-decision tests: prove each workflow control maps to the agent decision it
// should, deterministically and offline (no db / network / LLM). Run:
//   node --import tsx/esm --test src/review/decisions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsMaintainerFeedback,
  prStateOf,
  resolveReviewEvent,
  resolveVerdictStatus,
  triggerOutcome,
  withMaintainerInstructions,
} from "./decisions.js";
import { WORKFLOW_DEFAULTS } from "./workflow.js";

// ── verdict.blocking → GitHub review event ──────────────────────────────────
test("resolveReviewEvent: blocking + changes-requested → REQUEST_CHANGES", () => {
  const r = resolveReviewEvent({ status: "changes_requested", specless: false, blocking: true, endGoalAlreadyRequested: false });
  assert.equal(r.event, "REQUEST_CHANGES");
  assert.equal(r.downgradedToComment, false);
});

test("resolveReviewEvent: advisory (blocking=false) + changes-requested → COMMENT, downgraded", () => {
  const r = resolveReviewEvent({ status: "changes_requested", specless: false, blocking: false, endGoalAlreadyRequested: false });
  assert.equal(r.event, "COMMENT");
  assert.equal(r.downgradedToComment, true);
});

test("resolveReviewEvent: passed + spec → APPROVE (never downgraded)", () => {
  const r = resolveReviewEvent({ status: "passed", specless: false, blocking: false, endGoalAlreadyRequested: false });
  assert.equal(r.event, "APPROVE");
  assert.equal(r.downgradedToComment, false);
});

test("resolveReviewEvent: passed + spec-less → COMMENT, CTA once then refresh-only", () => {
  const first = resolveReviewEvent({ status: "passed", specless: true, blocking: true, endGoalAlreadyRequested: false });
  assert.equal(first.event, "COMMENT");
  assert.equal(first.includeEndGoalCTA, true);
  assert.equal(first.postConversationReview, true);

  const repeat = resolveReviewEvent({ status: "passed", specless: true, blocking: true, endGoalAlreadyRequested: true });
  assert.equal(repeat.event, "COMMENT");
  assert.equal(repeat.includeEndGoalCTA, false);
  assert.equal(repeat.postConversationReview, false); // already asked → refresh Check Run only
});

// ── security blocker is non-downgradeable ───────────────────────────────────
test("resolveReviewEvent: advisory + security blocker → REQUEST_CHANGES held (not downgraded)", () => {
  const r = resolveReviewEvent({
    status: "changes_requested",
    specless: false,
    blocking: false, // advisory mode would normally downgrade to COMMENT
    endGoalAlreadyRequested: false,
    hasSecurityBlocker: true,
  });
  assert.equal(r.event, "REQUEST_CHANGES");
  assert.equal(r.downgradedToComment, false);
  assert.equal(r.securityBlockerHeld, true);
});

test("resolveReviewEvent: advisory + NO security blocker → still downgrades to COMMENT", () => {
  const r = resolveReviewEvent({
    status: "changes_requested",
    specless: false,
    blocking: false,
    endGoalAlreadyRequested: false,
    hasSecurityBlocker: false,
  });
  assert.equal(r.event, "COMMENT");
  assert.equal(r.downgradedToComment, true);
  assert.equal(r.securityBlockerHeld, false);
});

test("resolveReviewEvent: blocking mode + security blocker → REQUEST_CHANGES, nothing held (no downgrade to suppress)", () => {
  const r = resolveReviewEvent({
    status: "changes_requested",
    specless: false,
    blocking: true,
    endGoalAlreadyRequested: false,
    hasSecurityBlocker: true,
  });
  assert.equal(r.event, "REQUEST_CHANGES");
  assert.equal(r.downgradedToComment, false);
  assert.equal(r.securityBlockerHeld, false); // downgrade never triggered, so nothing to hold
});

test("resolveReviewEvent: passed + security flag is irrelevant when there's nothing to block", () => {
  const r = resolveReviewEvent({
    status: "passed",
    specless: false,
    blocking: false,
    endGoalAlreadyRequested: false,
    hasSecurityBlocker: true,
  });
  assert.equal(r.event, "APPROVE");
  assert.equal(r.securityBlockerHeld, false);
});

// ── trigger policy → skip / re-review ───────────────────────────────────────
const wfWith = (t: Partial<typeof WORKFLOW_DEFAULTS.trigger>) => ({
  trigger: { ...WORKFLOW_DEFAULTS.trigger, ...t },
});

test("triggerOutcome: skipDrafts + draft → skip 'draft'", () => {
  assert.equal(triggerOutcome(wfWith({ skipDrafts: true }), { isDraft: true, isBot: false }).skip, "draft");
});

test("triggerOutcome: skipBots + bot → skip 'bot'", () => {
  assert.equal(triggerOutcome(wfWith({ skipBots: true }), { isDraft: false, isBot: true }).skip, "bot");
});

test("triggerOutcome: drafts take precedence over bots", () => {
  assert.equal(triggerOutcome(wfWith({ skipDrafts: true, skipBots: true }), { isDraft: true, isBot: true }).skip, "draft");
});

test("triggerOutcome: defaults never skip (skipDrafts/skipBots off)", () => {
  assert.equal(triggerOutcome(WORKFLOW_DEFAULTS, { isDraft: true, isBot: true }).skip, null);
});

test("triggerOutcome: onSynchronize flows through to reReviewOnSync", () => {
  assert.equal(triggerOutcome(wfWith({ onSynchronize: true }), { isDraft: false, isBot: false }).reReviewOnSync, true);
  assert.equal(triggerOutcome(wfWith({ onSynchronize: false }), { isDraft: false, isBot: false }).reReviewOnSync, false);
});

// ── prompts → appended to the stage's system prompt ─────────────────────────
test("withMaintainerInstructions: blank/absent prompt leaves the system prompt unchanged", () => {
  const sys = "You are DevAsign's PR review step. Emit JSON.";
  assert.equal(withMaintainerInstructions(sys, ""), sys);
  assert.equal(withMaintainerInstructions(sys, "   "), sys);
  assert.equal(withMaintainerInstructions(sys, undefined), sys);
});

test("withMaintainerInstructions: a prompt is appended after the base, under a header", () => {
  const sys = "You are DevAsign's PR review step. Emit JSON.";
  const out = withMaintainerInstructions(sys, "  Focus on error handling.  ");
  assert.ok(out.startsWith(sys), "base prompt must stay first so the offline mock's markers still match");
  assert.ok(out.includes("## Maintainer instructions"));
  assert.ok(out.includes("Focus on error handling."), "trimmed maintainer text is appended");
  assert.ok(
    out.includes("<maintainer_instructions>\nFocus on error handling.\n</maintainer_instructions>"),
    "maintainer text is delimited by XML tags so the model can tell it from prompt structure"
  );
});

// ── verdict status: passed / changes_requested / blocked ────────────────────
// `blocked` is the narrow red tier. Everything else that isn't a clean pass is
// changes_requested (yellow), which is the ordinary outcome.
const verdict = (o: Partial<Parameters<typeof resolveVerdictStatus>[0]>) =>
  resolveVerdictStatus({ allMet: false, hasBlocker: false, liveCount: 0, scoredCount: 0, metCount: 0, ...o });

test("resolveVerdictStatus: all criteria met, no blocker → passed", () => {
  assert.equal(verdict({ allMet: true, liveCount: 3, scoredCount: 3, metCount: 3 }), "passed");
});

test("resolveVerdictStatus: a blocker-severity finding → blocked", () => {
  assert.equal(verdict({ hasBlocker: true, liveCount: 3, scoredCount: 3, metCount: 2 }), "blocked");
});

test("resolveVerdictStatus: a blocker outranks all-met", () => {
  assert.equal(verdict({ allMet: true, hasBlocker: true, liveCount: 2, scoredCount: 2, metCount: 2 }), "blocked");
});

test("resolveVerdictStatus: some met, some unmet → changes_requested", () => {
  assert.equal(verdict({ liveCount: 3, scoredCount: 3, metCount: 1 }), "changes_requested");
});

test("resolveVerdictStatus: every criterion judged and none met → blocked", () => {
  assert.equal(verdict({ liveCount: 3, scoredCount: 3, metCount: 0 }), "blocked");
});

// The single-criterion miss is the textbook changes_requested. Requiring two
// scored criteria is what keeps red rare.
test("resolveVerdictStatus: a lone unmet criterion stays changes_requested", () => {
  assert.equal(verdict({ liveCount: 1, scoredCount: 1, metCount: 0 }), "changes_requested");
});

// A partially scored run has no grounds to call the deviation absolute.
test("resolveVerdictStatus: unmet + still-pending criteria → changes_requested", () => {
  assert.equal(verdict({ liveCount: 3, scoredCount: 2, metCount: 0 }), "changes_requested");
});

test("resolveVerdictStatus: nothing scored yet → changes_requested, never blocked", () => {
  assert.equal(verdict({ liveCount: 4, scoredCount: 0, metCount: 0 }), "changes_requested");
});

// A specless PR (or one whose criteria were all retired) is vacuously all-met.
test("resolveVerdictStatus: no live criteria → passed, not blocked", () => {
  assert.equal(verdict({ allMet: true, liveCount: 0, scoredCount: 0, metCount: 0 }), "passed");
});

test("resolveReviewEvent: blocked routes to REQUEST_CHANGES like changes_requested", () => {
  const r = resolveReviewEvent({ status: "blocked", specless: false, blocking: true, endGoalAlreadyRequested: false });
  assert.equal(r.event, "REQUEST_CHANGES");
});

// ── PR lifecycle ────────────────────────────────────────────────────────────
test("acceptsMaintainerFeedback: open and legacy rows accept, merged/closed don't", () => {
  assert.equal(acceptsMaintainerFeedback(undefined), true);
  assert.equal(acceptsMaintainerFeedback("open"), true);
  assert.equal(acceptsMaintainerFeedback("merged"), false);
  assert.equal(acceptsMaintainerFeedback("closed"), false);
});

test("prStateOf: merged wins over closed; open is the default", () => {
  assert.equal(prStateOf({ merged: true, state: "closed" }), "merged");
  assert.equal(prStateOf({ merged_at: "2026-01-01T00:00:00Z", state: "closed" }), "merged");
  assert.equal(prStateOf({ merged: false, state: "closed" }), "closed");
  assert.equal(prStateOf({ state: "open" }), "open");
  assert.equal(prStateOf({}), "open");
});
