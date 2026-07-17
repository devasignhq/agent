// Pure tests for parseReviewVerdict — the strict parser that guards the
// criteria verdict against truncated/disjoint LLM JSON. A lenient fallback here
// is what used to turn a cut-off response into an all-criteria-"Not met"
// comment. No db / network / LLM (mirrors criteria-format.test.ts). Run:
//   node --import tsx/esm --test src/review/review-verdict-parse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict } from "./pipeline.js";
import { complete, completeWithMeta } from "../llm.js";

const validVerdict = JSON.stringify({
  verdict: "changes_requested",
  summary: "One criterion still open.",
  criteria: [
    { id: "bounty-1", met: true, evidence: "CORS allowlist extended in app.ts." },
    { id: "bounty-2", met: false, evidence: "No memo validation found in stellar/memo.ts." },
  ],
  comments: [{ path: "src/app.ts", line: 10, body: "note" }],
  suggestions: [
    {
      criterionId: "bounty-2",
      title: "Validate memos",
      rationale: "r",
      path: "backend/src/stellar/memo.ts",
      line: 42,
      suggestedChange: "+ if (!isValidMemo(memo)) throw new Error();",
      fixPrompt: "Fix: ...",
    },
  ],
});

test("valid JSON with matching ids parses and shapes every field", () => {
  const v = parseReviewVerdict(validVerdict, ["bounty-1", "bounty-2"]);
  assert.ok(v);
  assert.equal(v.summary, "One criterion still open.");
  assert.equal(v.criteria.length, 2);
  assert.equal(v.criteria[0].id, "bounty-1");
  assert.equal(v.comments.length, 1);
  assert.equal(v.suggestions.length, 1);
  assert.equal(v.suggestions[0].criterionId, "bounty-2");
  assert.equal(v.suggestions[0].codeExample, undefined);
  // New location/diff fields pass through the explicit mapper.
  assert.equal(v.suggestions[0].path, "backend/src/stellar/memo.ts");
  assert.equal(v.suggestions[0].line, 42);
  assert.equal(v.suggestions[0].suggestedChange, "+ if (!isValidMemo(memo)) throw new Error();");
});

test("a fenced ```json wrapper still parses", () => {
  const v = parseReviewVerdict("```json\n" + validVerdict + "\n```", ["bounty-1"]);
  assert.ok(v);
  assert.equal(v.criteria.length, 2);
});

test("a truncated response (JSON cut mid-stream) returns null, not an empty verdict", () => {
  // This is the exact large-PR failure mode: max_tokens cut the JSON in half.
  const truncated = validVerdict.slice(0, Math.floor(validVerdict.length / 2));
  assert.equal(parseReviewVerdict(truncated, ["bounty-1", "bounty-2"]), null);
});

test("verdict whose criteria ids are disjoint from the expected ids returns null", () => {
  // e.g. the model (or the offline mock, historically) answered for "1".."4"
  // while the review asked about bounty-N — merging would zero-match everything.
  const wrongIds = validVerdict.replaceAll("bounty-1", "1").replaceAll("bounty-2", "2");
  assert.equal(parseReviewVerdict(wrongIds, ["bounty-1", "bounty-2"]), null);
});

test("id matching tolerates case and whitespace differences", () => {
  const v = parseReviewVerdict(validVerdict, ["  BOUNTY-1 ", "Bounty-2"]);
  assert.ok(v);
});

test("empty expectedIds (spec-less PR) stays lenient about the criteria list", () => {
  const v = parseReviewVerdict(JSON.stringify({ summary: "Sound diff.", criteria: [] }), []);
  assert.ok(v);
  assert.equal(v.summary, "Sound diff.");
  assert.deepEqual(v.criteria, []);
});

test("non-JSON text returns null", () => {
  assert.equal(parseReviewVerdict("I could not produce a verdict.", ["c1"]), null);
});

test("offline completeWithMeta reports a clean stop and matches complete()", async () => {
  const opts = { system: "PR review", messages: [{ role: "user" as const, content: "# Criteria\n- c1: does the thing\n" }] };
  const meta = await completeWithMeta(opts);
  assert.equal(meta.stopReason, "end_turn");
  assert.equal(meta.text, await complete(opts));
});
