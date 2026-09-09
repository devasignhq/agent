// Queue search matching + URL building. The case table here is mirrored in
// backend/src/review/search.test.ts — the two matchers must not drift. Run:
//   node --experimental-strip-types --test src/review-search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesReviewQuery, reviewSearchTerms, reviewsQuery } from "./review-search.ts";

const row = { title: "Fix login redirect", repo: "acme/pay", prNumber: 482 };
const hit = (q: string, r = row) => matchesReviewQuery(r, q);

test("a blank query matches everything, so the box can start empty", () => {
  assert.equal(hit(""), true);
  assert.equal(hit("   "), true);
});

test("matching is case-insensitive in both directions", () => {
  assert.equal(hit("LOGIN"), true);
  assert.equal(hit("fix", { ...row, title: "FIX LOGIN" }), true);
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
  // Prefix, not substring: #482 must not answer to "82".
  assert.equal(hit("82"), false);
  assert.equal(hit("482", { ...row, prNumber: 48 }), false);
});

test("a leading # is stripped; a lone # is not a term", () => {
  assert.equal(hit("#482"), true);
  assert.equal(hit("#999"), false);
  assert.equal(hit("#"), true);
});

test("digits still match the text haystack", () => {
  assert.equal(hit("2024", { title: "Bump to 2024", repo: "acme/pay", prNumber: 7 }), true);
});

test("null or missing fields never throw and stay number-searchable", () => {
  assert.equal(matchesReviewQuery({ title: null, repo: null, prNumber: 12 }, "12"), true);
  assert.equal(matchesReviewQuery({}, "anything"), false);
  assert.equal(matchesReviewQuery({}, ""), true);
});

test("punctuation is a plain substring, never a regex", () => {
  assert.equal(hit("a&b", { ...row, title: "a&b merge" }), true);
  assert.equal(hit("50%", { ...row, title: "cut 50% of calls" }), true);
  assert.equal(hit(".*"), false);
});

test("terms are clamped to 8 and the query to 128 chars", () => {
  assert.equal(reviewSearchTerms("a b c d e f g h i j").length, 8);
  const long = "x".repeat(200);
  assert.equal(reviewSearchTerms(long)[0].length, 128);
});

test("reviewsQuery encodes params instead of interpolating them", () => {
  assert.equal(reviewsQuery(), "");
  assert.equal(reviewsQuery({}), "");
  assert.equal(reviewsQuery({ q: "   " }), "");
  assert.equal(reviewsQuery({ q: "a b" }), "?q=a+b");
  assert.equal(reviewsQuery({ q: "a&b#1" }), "?q=a%26b%231");
  assert.equal(reviewsQuery({ status: "passed", q: "x" }), "?status=passed&q=x");
});
