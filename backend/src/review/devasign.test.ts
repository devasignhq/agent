// Offline tests for DEVASIGN.md hierarchical scoping. No network/db:
//   node --import tsx/esm --test src/review/devasign.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { devasignDocsForChangedFiles } from "./devasign.js";

test("root DEVASIGN.md governs every changed file", () => {
  const scopes = devasignDocsForChangedFiles(
    ["DEVASIGN.md"],
    ["server.ts", "frontend/src/app.tsx"]
  );
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].dir, "");
  assert.deepEqual(scopes[0].governedFiles, ["frontend/src/app.tsx", "server.ts"]);
});

test("a subdirectory DEVASIGN.md governs only files under that path", () => {
  const scopes = devasignDocsForChangedFiles(
    ["DEVASIGN.md", "frontend/DEVASIGN.md"],
    ["backend/x.ts", "frontend/src/y.tsx"]
  );
  const root = scopes.find((s) => s.dir === "");
  const fe = scopes.find((s) => s.dir === "frontend");
  assert.deepEqual(root?.governedFiles, ["backend/x.ts", "frontend/src/y.tsx"]);
  assert.deepEqual(fe?.governedFiles, ["frontend/src/y.tsx"]); // backend/x.ts excluded
});

test("a sibling directory's doc does not apply", () => {
  const scopes = devasignDocsForChangedFiles(["frontend/DEVASIGN.md"], ["backend/x.ts"]);
  assert.deepEqual(scopes, []);
});

test("prefix match is path-segment exact, not string prefix", () => {
  // "frontend/" must not match "frontend-utils/..."
  const scopes = devasignDocsForChangedFiles(
    ["frontend/DEVASIGN.md"],
    ["frontend-utils/helper.ts"]
  );
  assert.deepEqual(scopes, []);
});

test("nested docs compound and return root-first", () => {
  const scopes = devasignDocsForChangedFiles(
    ["frontend/src/DEVASIGN.md", "DEVASIGN.md", "frontend/DEVASIGN.md"],
    ["frontend/src/y.tsx"]
  );
  assert.deepEqual(
    scopes.map((s) => s.dir),
    ["", "frontend", "frontend/src"]
  );
  for (const s of scopes) assert.deepEqual(s.governedFiles, ["frontend/src/y.tsx"]);
});

test("a changed DEVASIGN.md is not itself a governed file", () => {
  const scopes = devasignDocsForChangedFiles(
    ["DEVASIGN.md"],
    ["DEVASIGN.md", "frontend/DEVASIGN.md", "src/real.ts"]
  );
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0].governedFiles, ["src/real.ts"]);
});

test("no docs, or docs with no governed changes, yields no scopes", () => {
  assert.deepEqual(devasignDocsForChangedFiles([], ["a.ts"]), []);
  assert.deepEqual(devasignDocsForChangedFiles(["docs/DEVASIGN.md"], ["src/a.ts"]), []);
});
