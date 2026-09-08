// Pure tests for the review-comment anchoring rules. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/anchor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines, resolveAnchor, SNAP_WITHIN } from "./anchor.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@",
  " context",
  "-gone",
  "+added",
  "+also added",
  " tail",
  "@@ -80,2 +81,2 @@",
  " keep",
  "+changed",
].join("\n");

test("commentableLines maps each hunk to its new-file span", () => {
  const idx = commentableLines(DIFF);
  assert.deepEqual(idx.get("src/a.ts"), [
    { from: 10, to: 13 },
    { from: 81, to: 82 },
  ]);
});

test("a deleted file contributes no commentable path", () => {
  const diff = [
    "diff --git a/src/gone.ts b/src/gone.ts",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
  ].join("\n");
  assert.equal(commentableLines(diff).size, 0);
});

test("a pure-deletion hunk yields no right-side range", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -5,2 +4,0 @@",
    "-x",
    "-y",
  ].join("\n");
  assert.equal(commentableLines(diff).size, 0);
});

test("a binary entry does not attach its absence to the previous file", () => {
  const diff = [
    DIFF,
    "diff --git a/logo.png b/logo.png",
    "index 333..444 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");
  const idx = commentableLines(diff);
  assert.deepEqual([...idx.keys()], ["src/a.ts"]);
  assert.equal(idx.get("src/a.ts")!.length, 2);
});

test("a rename keys on the new path", () => {
  const diff = [
    "diff --git a/old.ts b/new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,1 +1,2 @@",
    " a",
    "+b",
  ].join("\n");
  assert.deepEqual([...commentableLines(diff).keys()], ["new.ts"]);
});

test("an empty diff produces an empty index, so everything degrades to the card", () => {
  assert.equal(commentableLines("").size, 0);
  assert.deepEqual(resolveAnchor({ path: "src/a.ts", line: 11 }, commentableLines("")), {
    kind: "none",
    reason: "path-not-in-diff",
  });
});

test("a line inside a hunk anchors exactly, on the RIGHT side", () => {
  const idx = commentableLines(DIFF);
  assert.deepEqual(resolveAnchor({ path: "src/a.ts", line: 12 }, idx), {
    kind: "line",
    path: "src/a.ts",
    line: 12,
    side: "RIGHT",
  });
});

test("a line just outside a hunk snaps to the nearest legal line and records the original", () => {
  const idx = commentableLines(DIFF);
  const a = resolveAnchor({ path: "src/a.ts", line: 15 }, idx);
  assert.deepEqual(a, {
    kind: "line",
    path: "src/a.ts",
    line: 13,
    side: "RIGHT",
    snappedFrom: 15,
  });
});

test("snapping stops at the boundary — one line past it falls back to file level", () => {
  const idx = commentableLines(DIFF);
  const edge = resolveAnchor({ path: "src/a.ts", line: 13 + SNAP_WITHIN }, idx);
  assert.equal(edge.kind, "line");
  const past = resolveAnchor({ path: "src/a.ts", line: 13 + SNAP_WITHIN + 1 }, idx);
  assert.deepEqual(past, { kind: "file", path: "src/a.ts" });
});

test("a path in the diff with no usable line anchors at file level", () => {
  const idx = commentableLines(DIFF);
  assert.deepEqual(resolveAnchor({ path: "src/a.ts" }, idx), { kind: "file", path: "src/a.ts" });
  // A nonsense line is not a reason to drop the item — the file still exists.
  assert.deepEqual(resolveAnchor({ path: "src/a.ts", line: 0 }, idx), {
    kind: "file",
    path: "src/a.ts",
  });
});

test("no path, or a path outside the diff, is unanchorable", () => {
  const idx = commentableLines(DIFF);
  assert.deepEqual(resolveAnchor({}, idx), { kind: "none", reason: "no-path" });
  assert.deepEqual(resolveAnchor({ path: "src/nope.ts", line: 3 }, idx), {
    kind: "none",
    reason: "path-not-in-diff",
  });
});
