// Offline unit tests for the diff gutter/truncation helpers.
//   node --import tsx/esm --test src/review/diff-format.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffHunks,
  parseDiffHunksByFile,
  mapOldLineToNew,
  numberLines,
  formatRawDiff,
  truncateDiffAtHunkBoundary,
  stripGutterArtifacts,
} from "./diff-format.js";

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export {};",
  "@@ -10,2 +11,2 @@",
  " function f() {",
  "-  return 1;",
  "+  return 2;",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -5 +5 @@",
  "-old line",
  "+new line",
].join("\n");

test("parseDiffHunks: full and short @@ forms", () => {
  const hunks = parseDiffHunks("@@ -1,3 +1,4 @@\n x\n@@ -10 +11,2 @@\n y");
  assert.deepEqual(hunks, [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 2 },
  ]);
});

test("parseDiffHunksByFile: keys by new path, skips /dev/null", () => {
  const byFile = parseDiffHunksByFile(
    SAMPLE_DIFF +
      "\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y"
  );
  assert.deepEqual([...byFile.keys()], ["src/a.ts", "src/b.ts"]);
  assert.equal(byFile.get("src/a.ts")!.length, 2);
  assert.deepEqual(byFile.get("src/b.ts"), [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }]);
});

test("mapOldLineToNew: before, inside, and after hunks", () => {
  const hunks = [
    { oldStart: 10, oldLines: 3, newStart: 10, newLines: 5 },
    { oldStart: 30, oldLines: 4, newStart: 32, newLines: 2 },
  ];
  assert.equal(mapOldLineToNew(5, hunks), 5); // before all hunks
  assert.equal(mapOldLineToNew(11, hunks), 11); // inside first hunk (positional)
  assert.equal(mapOldLineToNew(20, hunks), 22); // between hunks: +2 from first
  assert.equal(mapOldLineToNew(40, hunks), 40); // after all: +2 then -2
  assert.equal(mapOldLineToNew(7, []), 7); // no hunks
});

test("numberLines: right-aligned gutters from a start line", () => {
  assert.equal(numberLines("a\nb", 9), " 9 | a\n10 | b");
});

test("formatRawDiff: added/context guttered in new-file coords, removed blank", () => {
  const out = formatRawDiff(SAMPLE_DIFF).split("\n");
  // Headers pass through untouched.
  assert.equal(out[0], "diff --git a/src/a.ts b/src/a.ts");
  assert.equal(out[4], "@@ -1,3 +1,4 @@");
  // Hunk 1 of a.ts: context 1, removed (blank), added 2, added 3, context 4.
  assert.match(out[5], /^ ?1 \|  const a = 1;$/);
  assert.match(out[6], /^\s+\| -const b = 2;$/);
  assert.match(out[7], /^ ?2 \| \+const b = 3;$/);
  assert.match(out[8], /^ ?3 \| \+const c = 4;$/);
  assert.match(out[9], /^ ?4 \|  export \{\};$/);
  // Hunk 2 resumes at newStart 11.
  assert.match(out[11], /^11 \|  function f\(\) \{$/);
  assert.match(out[12], /^\s+\| - {2}return 1;$/);
  assert.match(out[13], /^12 \| \+ {2}return 2;$/);
  // Second file's single-line hunk numbers from 5.
  assert.match(out[19], /^\s+\| -old line$/);
  assert.match(out[20], /^ ?5 \| \+new line$/);
});

test("formatRawDiff: '\\ No newline' marker gets a blank gutter", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file";
  const out = formatRawDiff(diff).split("\n");
  assert.match(out[5], /^\s+\| \\ No newline at end of file$/);
});

test("truncateDiffAtHunkBoundary: under cap unchanged", () => {
  const r = truncateDiffAtHunkBoundary(SAMPLE_DIFF, 100_000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, SAMPLE_DIFF);
});

test("truncateDiffAtHunkBoundary: cuts at a hunk boundary, never mid-hunk", () => {
  // Cap chosen to land inside the second hunk of a.ts.
  const capInsideSecondHunk = SAMPLE_DIFF.indexOf("+  return 2;");
  const r = truncateDiffAtHunkBoundary(SAMPLE_DIFF, capInsideSecondHunk);
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith(" export {};"), `should end after hunk 1, got: …${r.text.slice(-30)}`);
  assert.ok(!r.text.includes("@@ -10,2"), "the half-fitting hunk is dropped entirely");
});

test("truncateDiffAtHunkBoundary: falls back to raw slice when the first hunk exceeds the cap", () => {
  const r = truncateDiffAtHunkBoundary(SAMPLE_DIFF, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.text, SAMPLE_DIFF.slice(0, 10));
});

test("stripGutterArtifacts: strips a leaked guttered block, leaves real code alone", () => {
  const leaked = "12 | const a = 1;\n13 | const b = 2;\n   | removedish";
  assert.equal(stripGutterArtifacts(leaked), "const a = 1;\nconst b = 2;\nremovedish");
  const legit = "const mask = 5 | flags;\nreturn mask;";
  assert.equal(stripGutterArtifacts(legit), legit);
});
