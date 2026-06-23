// Pure-decision tests: prove each workflow control maps to the agent decision it
// should, deterministically and offline (no db / network / LLM). Run:
//   node --import tsx/esm --test src/review/decisions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReviewEvent, triggerOutcome, withMaintainerInstructions } from "./decisions.js";
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
});
