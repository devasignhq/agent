// node --import tsx/esm --test src/summary.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { announceUnverifiable, summaryTable } from "./run.js";
import type { RunnerPlan, RunnerResult } from "./types.js";

const plan: RunnerPlan = {
  planId: "p",
  criteriaRevision: 1,
  criteria: [
    { id: "1", text: "The total | is formatted", kind: "code" },
    { id: "2", text: "The pill shows", kind: "ui" },
    { id: "3", text: "Nothing planned", kind: "code" },
  ],
  tests: [{ id: "t1", path: ".devasign/tests/total.test.ts", content: "x", criterionIds: ["1"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "s", strategyVersion: 1, targetFiles: [] }],
  commands: [],
  playwright: null,
  retries: { generated: 2, existing: 0 },
  uploadLimits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1 },
  unverifiable: [{ criterionId: "2", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=r" }],
};
const results: RunnerResult[] = [
  { id: "r1", testId: "t1", criterionIds: ["1"], test: ".devasign/tests/total.test.ts", runner: "node-test", level: "unit", origin: "generated", status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 1, artifactIds: [] }], durationMs: 1, artifactIds: [] },
];

test("summaryTable lists every criterion: its test, its planned reason with a fix link, or 'no test planned'", () => {
  const table = summaryTable(plan, results);
  const rows = table.split("\n").slice(2);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| 1\. The total \\\| is formatted \| unit generated `\.devasign\/tests\/total\.test\.ts` \| pass \(1 attempt\) \| \|$/);
  assert.match(rows[1], /^\| 2\. The pill shows \| — \| unverifiable \| no app start \/ login configured — \[configure app start\]\(https:\/\/app\/workflow\?repo=r\) \|$/);
  assert.match(rows[2], /^\| 3\. Nothing planned \| — \| unverifiable \| no test planned \|$/);
});

test("summaryTable with no results still has a row per criterion", () => {
  const rows = summaryTable({ ...plan, tests: [], unverifiable: undefined }, []).split("\n").slice(2);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.includes("| unverifiable |")));
});

test("announceUnverifiable warns once per criterion, with the fix link, and once more when nothing was planned", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (msg: unknown) => lines.push(String(msg));
  try {
    announceUnverifiable({ ...plan, tests: [] });
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((l) => /criterion 2 is unverifiable: no app start \/ login configured — fix: https:\/\/app\/workflow\?repo=r/.test(l)));
  assert.ok(lines.some((l) => /no tests could be planned for this PR/.test(l)));
});
