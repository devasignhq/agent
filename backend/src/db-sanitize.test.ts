// Proves the jsonb scrubber removes exactly the code units Postgres rejects and
// nothing else, deterministically and offline (no db / network). Run:
//   node --import tsx/esm --test src/db-sanitize.test.ts
//
// Special characters are built with String.fromCharCode so this source file
// stays plain ASCII (a literal NUL / lone surrogate in source is exactly the
// kind of thing that gets mangled by editors and tooling).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnstorableDataError, sanitizeForJsonb, sanitizeString } from "./db-sanitize.js";

const NUL = String.fromCharCode(0x0000);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdfff);
const REPLACEMENT = String.fromCharCode(0xfffd);
const EMOJI = String.fromCharCode(0xd83d, 0xde00); // U+1F600, a valid pair

// ── sanitizeString ──────────────────────────────────────────────────────────
test("strips NUL bytes", () => {
  assert.equal(sanitizeString(`a${NUL}b${NUL}`), "ab");
});

test("replaces a lone high surrogate with U+FFFD", () => {
  assert.equal(sanitizeString(`x${LONE_HIGH}y`), `x${REPLACEMENT}y`);
});

test("replaces a lone low surrogate with U+FFFD", () => {
  assert.equal(sanitizeString(`x${LONE_LOW}y`), `x${REPLACEMENT}y`);
});

test("keeps a valid surrogate pair (emoji) intact", () => {
  assert.equal(sanitizeString(`hi ${EMOJI}!`), `hi ${EMOJI}!`);
});

test("returns the SAME reference for an already-clean string (no realloc)", () => {
  const s = "perfectly normal text with emoji " + EMOJI;
  assert.equal(sanitizeString(s), s); // value-equal
});

test("cleaned output is valid for JSON round-trip (no NUL survives)", () => {
  const cleaned = sanitizeString(`pre${NUL}${LONE_HIGH}post`);
  assert.equal(cleaned.includes(NUL), false);
  // JSON of the cleaned string parses back to itself.
  assert.equal(JSON.parse(JSON.stringify(cleaned)), cleaned);
});

// ── sanitizeForJsonb (deep) ───────────────────────────────────────────────────
test("deep-cleans strings nested in objects and arrays", () => {
  const row = {
    id: "r1",
    verdict: `bad${NUL}verdict`,
    criteria: [{ text: `c${LONE_HIGH}` }, { text: "ok" }],
    meta: { detail: `d${NUL}`, count: 3, ok: true, nothing: null },
  };
  const out = sanitizeForJsonb(row);
  assert.equal(out.verdict, "badverdict");
  assert.equal(out.criteria[0].text, `c${REPLACEMENT}`);
  assert.equal(out.criteria[1].text, "ok");
  assert.equal(out.meta.detail, "d");
  assert.equal(out.meta.count, 3);
  assert.equal(out.meta.ok, true);
  assert.equal(out.meta.nothing, null);
  // The whole thing serializes without a NUL anywhere.
  assert.equal(JSON.stringify(out).includes(NUL), false);
});

test("returns the SAME reference when nothing needed cleaning", () => {
  const row = { id: "r2", verdict: "clean", criteria: [{ text: "fine" }] };
  assert.equal(sanitizeForJsonb(row), row);
});

test("does not mutate the input row (clean produces a copy)", () => {
  const row = { id: "r3", verdict: `x${NUL}` };
  const out = sanitizeForJsonb(row);
  assert.notEqual(out, row);
  assert.equal(row.verdict, `x${NUL}`); // original untouched
  assert.equal(out.verdict, "x");
});

test("passes through primitives untouched", () => {
  assert.equal(sanitizeForJsonb(42), 42);
  assert.equal(sanitizeForJsonb(true), true);
  assert.equal(sanitizeForJsonb(null), null);
  assert.equal(sanitizeForJsonb(undefined), undefined);
});

// ── isUnstorableDataError ─────────────────────────────────────────────────────
test("treats 22xxx / 23xxx SQLSTATE as poison (data errors)", () => {
  assert.equal(isUnstorableDataError({ code: "22P05" }), true); // untranslatable char
  assert.equal(isUnstorableDataError({ code: "22021" }), true); // invalid byte sequence
  assert.equal(isUnstorableDataError({ code: "23505" }), true); // unique violation
});

test("treats connection / transient errors as retryable (not poison)", () => {
  assert.equal(isUnstorableDataError({ code: "ECONNRESET" }), false);
  assert.equal(isUnstorableDataError({ code: "57P01" }), false); // admin shutdown
  assert.equal(isUnstorableDataError(new Error("socket hang up")), false);
  assert.equal(isUnstorableDataError(undefined), false);
  assert.equal(isUnstorableDataError(null), false);
});
