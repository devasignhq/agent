// Offline: implied blast-radius criteria from a diff + index entries.
//   node --import tsx/esm --test src/verify/blast-radius.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blastRadiusCriteria, changedSurfaces } from "./blast-radius.js";

const DIFF = [
  "diff --git a/backend/src/routes/revenue.ts b/backend/src/routes/revenue.ts",
  "--- a/backend/src/routes/revenue.ts",
  "+++ b/backend/src/routes/revenue.ts",
  "@@ -1,3 +1,4 @@",
  '-app.get("/api/revenue", (req, res) => res.json({ total }));',
  '+app.get("/api/revenue", (req, res) => res.json({ total, refunds }));',
  "+export function sumRefunds(rows: Row[]) { return 0; }",
  "diff --git a/backend/src/routes/revenue.test.ts b/backend/src/routes/revenue.test.ts",
  "+++ b/backend/src/routes/revenue.test.ts",
  '+app.get("/api/ignored", () => {});',
].join("\n");

const ENTRIES = [
  { path: "backend/src/routes/revenue.ts", imports: ["express"], exports: ["sumRefunds"], summary: "Revenue route." },
  { path: "frontend/src/screen-revenue.tsx", imports: ["react", "./api"], exports: ["RevenueScreen"], summary: "Fetches /api/revenue and renders totals." },
  { path: "backend/src/reports.ts", imports: ["./routes/revenue.js"], exports: ["report"], summary: "Builds the monthly report with sumRefunds." },
  { path: "backend/src/routes/revenue.test.ts", imports: ["./revenue.js"], exports: [], summary: "Tests /api/revenue." },
];

test("changedSurfaces lists routes and exports on +/- lines, skipping test files", () => {
  const s = changedSurfaces(DIFF);
  assert.deepEqual(
    s.map((x) => [x.kind, x.name]),
    [
      ["route", "GET /api/revenue"],
      ["export", "sumRefunds"],
    ]
  );
});

test("a route with a frontend consumer yields an implied ui criterion; an export with a backend caller yields code", () => {
  const out = blastRadiusCriteria({ diff: DIFF, entries: ENTRIES, existing: [{ id: "2", text: "x", met: null, evidence: null }] });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "3");
  assert.equal(out[0].kind, "ui");
  assert.equal(out[0].implied, true);
  assert.match(out[0].text, /Existing consumers of `GET \/api\/revenue` \(`frontend\/src\/screen-revenue\.tsx`\)/);
  assert.equal(out[0].source?.input, "diff");
  assert.equal(out[1].kind, "code");
  assert.match(out[1].text, /callers of `sumRefunds`/);
  assert.match(out[1].text, /backend\/src\/reports\.ts/);
});

test("no index, no consumers, or a cap → fewer criteria", () => {
  assert.deepEqual(blastRadiusCriteria({ diff: DIFF, entries: [], existing: [] }), []);
  assert.equal(blastRadiusCriteria({ diff: DIFF, entries: ENTRIES, existing: [], max: 1 }).length, 1);
  const noConsumers = ENTRIES.filter((e) => e.path.endsWith("revenue.ts"));
  assert.deepEqual(blastRadiusCriteria({ diff: DIFF, entries: noConsumers, existing: [] }), []);
});
