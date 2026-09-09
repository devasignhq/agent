// Queue search matching. The case table here mirrors frontend/src/review-search.test.ts
// — the two matchers must not drift, since the frontend re-applies this predicate
// over whatever this one returns. Run:
//   node --import tsx/esm --test src/review/search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewMatchesTerms, reviewSearchTerms } from "./search.js";

const row = { prTitle: "Fix login redirect", prNumber: 482 };
const hit = (q: string, r = row, label = "acme/pay") =>
  reviewMatchesTerms(r, label, reviewSearchTerms(q));

test("a blank query matches everything", () => {
  assert.equal(hit(""), true);
  assert.equal(hit("   "), true);
});

test("matching is case-insensitive in both directions", () => {
  assert.equal(hit("LOGIN"), true);
  assert.equal(hit("fix", { ...row, prTitle: "FIX LOGIN" }), true);
});

test("repo matches by owner, by name, and by full label", () => {
  assert.equal(hit("acme"), true);
  assert.equal(hit("pay"), true);
  assert.equal(hit("acme/pay"), true);
  assert.equal(hit("othercorp"), false);
});

test("multiple terms are ANDed, so a second word narrows", () => {
  assert.equal(hit("acme login"), true);
  assert.equal(hit("acme logout"), false);
});

test("a digit term prefix-matches the PR number", () => {
  assert.equal(hit("4"), true);
  assert.equal(hit("48"), true);
  assert.equal(hit("482"), true);
  assert.equal(hit("4820"), false);
  assert.equal(hit("82"), false);
  assert.equal(hit("482", { ...row, prNumber: 48 }), false);
});

test("a leading # is stripped; a lone # is not a term", () => {
  assert.equal(hit("#482"), true);
  assert.equal(hit("#999"), false);
  assert.equal(hit("#"), true);
});

test("digits still match the text haystack", () => {
  assert.equal(hit("2024", { prTitle: "Bump to 2024", prNumber: 7 }), true);
});

test("null or missing fields never throw and stay number-searchable", () => {
  assert.equal(reviewMatchesTerms({ prTitle: null, prNumber: 12 }, "", reviewSearchTerms("12")), true);
  assert.equal(reviewMatchesTerms({}, "", reviewSearchTerms("anything")), false);
  assert.equal(reviewMatchesTerms({}, "", reviewSearchTerms("")), true);
});

test("punctuation is a plain substring, never a regex", () => {
  assert.equal(hit("a&b", { ...row, prTitle: "a&b merge" }), true);
  assert.equal(hit("50%", { ...row, prTitle: "cut 50% of calls" }), true);
  assert.equal(hit(".*"), false);
});

test("terms are clamped to 8 and the query to 128 chars", () => {
  assert.equal(reviewSearchTerms("a b c d e f g h i j").length, 8);
  assert.equal(reviewSearchTerms("x".repeat(200))[0].length, 128);
});
