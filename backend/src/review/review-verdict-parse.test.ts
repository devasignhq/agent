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

test("suggestion line numbers that aren't positive integers are dropped", () => {
  for (const bad of [42.5, -1, 0, "abc"]) {
    const raw = validVerdict.replace('"line":42', `"line":${JSON.stringify(bad)}`);
    const v = parseReviewVerdict(raw, ["bounty-1", "bounty-2"]);
    assert.ok(v);
    assert.equal(v.suggestions[0].line, undefined, `line=${bad} should be dropped`);
  }
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

// ── Structured evidence/patch fields (upgraded prompt contract) ──────────────

test("criterion evidenceCode and suggestedChange objects are coerced and gutter-stripped", () => {
  const raw = JSON.stringify({
    summary: "s",
    criteria: [
      {
        id: "c1",
        met: false,
        evidence: "e",
        evidenceCode: {
          path: "src/a.ts",
          startLine: 12,
          language: "TypeScript",
          code: "12 | const a = 1;\n13 | const b = 2;",
        },
        suggestedChange: {
          path: "src/a.ts",
          startLine: 12,
          original: "const a = 1;",
          suggested: "const a = 2;",
        },
      },
    ],
    comments: [],
    suggestions: [],
  });
  const v = parseReviewVerdict(raw, ["c1"]);
  assert.ok(v);
  assert.deepEqual(v.criteria[0].evidenceCode, {
    path: "src/a.ts",
    startLine: 12,
    language: "typescript", // lowercased
    code: "const a = 1;\nconst b = 2;", // gutters stripped
  });
  assert.equal(v.criteria[0].suggestedChange?.suggested, "const a = 2;");
});

test("malformed evidenceCode/suggestedChange coerce to null, never a parse failure", () => {
  const raw = JSON.stringify({
    summary: "s",
    criteria: [
      { id: "c1", met: true, evidence: "e", evidenceCode: "not-an-object", suggestedChange: { path: "" } },
    ],
    comments: [],
    suggestions: [],
  });
  const v = parseReviewVerdict(raw, ["c1"]);
  assert.ok(v, "verdict must survive malformed structured fields");
  assert.equal(v.criteria[0].evidenceCode, null);
  assert.equal(v.criteria[0].suggestedChange, null);
});

test("suggestion severity parses; anything unknown defaults to warn", () => {
  const mk = (sev: unknown) =>
    JSON.stringify({
      summary: "s",
      criteria: [{ id: "c1", met: false, evidence: "e" }],
      comments: [],
      suggestions: [{ criterionId: "c1", title: "t", rationale: "r", severity: sev }],
    });
  assert.equal(parseReviewVerdict(mk("blocker"), ["c1"])!.suggestions[0].severity, "blocker");
  assert.equal(parseReviewVerdict(mk("nit"), ["c1"])!.suggestions[0].severity, "nit");
  assert.equal(parseReviewVerdict(mk("catastrophic"), ["c1"])!.suggestions[0].severity, "warn");
  assert.equal(parseReviewVerdict(mk(undefined), ["c1"])!.suggestions[0].severity, "warn");
});

test("suggestion suggestedChange: object goes to patch, string stays legacy", () => {
  const raw = JSON.stringify({
    summary: "s",
    criteria: [{ id: "c1", met: false, evidence: "e" }],
    comments: [],
    suggestions: [
      {
        criterionId: "c1",
        title: "structured",
        rationale: "r",
        suggestedChange: { path: "src/a.ts", startLine: 3, original: "x", suggested: "y" },
      },
      { criterionId: "c1", title: "legacy", rationale: "r", suggestedChange: "+ y\n- x" },
    ],
  });
  const v = parseReviewVerdict(raw, ["c1"]);
  assert.ok(v);
  assert.equal(v.suggestions[0].patch?.path, "src/a.ts");
  assert.equal(v.suggestions[0].suggestedChange, undefined);
  assert.equal(v.suggestions[1].patch, undefined);
  assert.equal(v.suggestions[1].suggestedChange, "+ y\n- x");
});

test("a truncated verdict whose complete prefix covers the criteria is repaired, not nulled", () => {
  const full = JSON.stringify({
    summary: "all good",
    criteria: [
      { id: "c1", met: true, evidence: "done in src/a.ts" },
      { id: "c2", met: true, evidence: "done in src/b.ts" },
    ],
    comments: [],
    suggestions: [],
  });
  // Cut mid-way through the suggestions key — after the criteria array closed.
  const truncated = full.slice(0, full.indexOf('"suggestions"') + 14);
  const v = parseReviewVerdict(truncated, ["c1", "c2"]);
  assert.ok(v, "the complete criteria prefix should be recovered by JSON repair");
  assert.equal(v.criteria.length, 2);
});

test("code bleeding into a suggestion's rationale is truncated at the bleed", () => {
  const code = "if (!items?.length) { return { items: [] }; }";
  const raw = JSON.stringify({
    summary: "s",
    criteria: [{ id: "c1", met: false, evidence: "e" }],
    comments: [],
    suggestions: [
      {
        criterionId: "c1",
        title: "t",
        rationale: `Guard the empty case before the main path runs ${code}`,
        suggestedChange: { path: "src/a.ts", startLine: 3, original: "x", suggested: code },
      },
    ],
  });
  const v = parseReviewVerdict(raw, ["c1"]);
  assert.ok(v);
  assert.equal(v.suggestions[0].rationale, "Guard the empty case before the main path runs");
});
