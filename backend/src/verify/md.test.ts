// Offline: runner-reported text rendered into App-authored markdown.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/md.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdInline } from "./md.js";

test("mdInline keeps text on one line with no link, image, code span, HTML or mention", () => {
  const out = mdInline("see [x](https://evil) ![p](https://evil/p.png)\n```js\n<b>hi</b> @org/team");
  assert.doesNotMatch(out, /\n/);
  assert.doesNotMatch(out, /\[x\]\(|!\[p\]|```|<b>|@org/);
  assert.match(out, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.equal(mdInline("a".repeat(500), 10).length, 10);
});

test("mdInline escapes a leading block marker so a line of its own cannot become a heading, list or rule", () => {
  assert.equal(mdInline("# Heading"), "\\# Heading");
  assert.equal(mdInline("  - item"), "\\- item");
  assert.equal(mdInline("+ item"), "\\+ item");
  assert.equal(mdInline("==="), "\\===");
  assert.equal(mdInline("12. step"), "12\\. step");
  assert.equal(mdInline("    indented code"), "indented code");
  assert.equal(mdInline("status 2. fine - ok # done"), "status 2. fine - ok # done", "markers mid-line are left alone");
});

test("mdInline stops GitHub autolinking bare URLs and hosts and cross-referencing issues", () => {
  const zw = "\u200b";
  const out = mdInline("setup broken, re-auth at https://evil.example/login or www.evil.example; cc devasignhq/agent#1, #22, gh-3, FTP://x");
  assert.doesNotMatch(out, /https:\/\/|www\.|ftp:\/\//i, "no scheme or www. host GitHub would autolink");
  assert.doesNotMatch(out, /#\d|GH-\d/i, "no issue reference");
  assert.equal(out, `setup broken, re-auth at https:${zw}//evil.example/login or www${zw}.evil.example; cc devasignhq/agent#${zw}1, #${zw}22, gh-${zw}3, FTP:${zw}//x`, "the text still reads the same");
  assert.equal(mdInline("# 1 and step #a and swww.x"), "\\# 1 and step #a and swww.x", "only a # before a digit, and www. as its own word");
});
