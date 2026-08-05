// Offline unit tests for model-output parsing/repair.
//   node --import tsx/esm --test src/review/parse.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractJSON,
  repairTruncatedJSON,
  trimLastIncompleteValue,
  findProseCodeBleed,
  repairBledProseField,
} from "./parse.js";

test("extractJSON: fenced json block", () => {
  const raw = 'Here you go:\n```json\n{"a": 1}\n```\nDone.';
  assert.deepEqual(extractJSON(raw), { a: 1 });
});

test("extractJSON: raw JSON", () => {
  assert.deepEqual(extractJSON('  {"a": [1, 2]}  '), { a: [1, 2] });
});

test("extractJSON: brace scan tolerates braces inside strings and prose around", () => {
  const raw = 'Sure! {"msg": "use {x} here", "n": 2} — hope that helps';
  assert.deepEqual(extractJSON(raw), { msg: "use {x} here", n: 2 });
});

test("extractJSON: repairs truncation mid-string", () => {
  const raw = '{"summary": "all good", "items": [{"id": "1", "text": "first"}, {"id": "2", "text": "sec';
  const parsed = extractJSON(raw) as any;
  assert.ok(parsed, "truncated object should be repaired, not dropped");
  assert.equal(parsed.summary, "all good");
  assert.equal(parsed.items[0].id, "1");
});

test("extractJSON: repairs truncation mid-array by trimming the half value", () => {
  const raw = '{"items": [1, 2, 3';
  const parsed = extractJSON(raw) as any;
  assert.ok(parsed);
  assert.deepEqual(parsed.items.slice(0, 2), [1, 2]);
});

test("extractJSON: null on hopeless input", () => {
  assert.equal(extractJSON("no json here at all"), null);
  assert.equal(extractJSON(""), null);
});

test("repairTruncatedJSON: balanced input returns null (nothing to repair)", () => {
  assert.equal(repairTruncatedJSON('{"a": 1}'), null);
});

test("trimLastIncompleteValue: trims back to last comma outside strings", () => {
  assert.equal(trimLastIncompleteValue('{"a": 1, "b": "x,y", "c'), '{"a": 1, "b": "x,y"');
});

test("findProseCodeBleed: verbatim overlap of a code field (signal A)", () => {
  const code = 'const result = await fetchAll(userId, { retries: 3 });';
  const prose = `The retry loop is wrong because ${code} runs twice.`;
  const idx = findProseCodeBleed(prose, [code]);
  assert.ok(idx >= 0, "bleed should be detected");
});

test("findProseCodeBleed: ignores code safely quoted in backticks", () => {
  const code = 'const result = await fetchAll(userId, { retries: 3 });';
  const prose = `The call \`${code}\` runs twice.`;
  assert.equal(findProseCodeBleed(prose, [code]), -1);
});

test("findProseCodeBleed: run of 3+ code-shaped lines (signal C)", () => {
  const prose = "Summary of the fix.\nconst a = 1;\nconst b = 2;\nreturn a + b;\n";
  assert.ok(findProseCodeBleed(prose, []) >= 0);
});

test("repairBledProseField: truncates at the bleed and cleans the boundary", () => {
  const code = 'if (x) { doThing(); } else { doOther(); }';
  const prose = `The condition is inverted so the fallback never runs ${code}`;
  const { text, repaired } = repairBledProseField(prose, [code]);
  assert.equal(repaired, true);
  assert.equal(text, "The condition is inverted so the fallback never runs");
});

test("repairBledProseField: clean prose passes through", () => {
  const { text, repaired } = repairBledProseField("All criteria are met.", ["const x = 1;"]);
  assert.equal(repaired, false);
  assert.equal(text, "All criteria are met.");
});
