// Unit tests for the pre-existing-vuln re-verification pure pieces:
//   - partitionReverifiedVulns: maps the model's per-file verdicts onto stored
//     vulns, with a safe "still-present" default for anything not clearly resolved.
//   - formatPreexistingFinding / formatResolvedFinding: the shared finding shapers.
// No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/preexisting-reverify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  partitionReverifiedVulns,
  formatPreexistingFinding,
  formatResolvedFinding,
} from "./pipeline.js";
import type { PreexistingVulnLike } from "./pipeline.js";

const vuln = (over: Partial<PreexistingVulnLike> = {}): PreexistingVulnLike => ({
  id: "v",
  class: "sql-injection",
  path: "backend/src/db.ts",
  concern: "raw query built from user input",
  fixPrompt: "fix",
  ...over,
});

const entry = (path: string, vulns: PreexistingVulnLike[]) => ({ path, vulns });

// ── formatters ──────────────────────────────────────────────────────────────

test("formatPreexistingFinding: forces advisory 'warn', labels pre-existing, keeps fixPrompt + locator", () => {
  const f = formatPreexistingFinding(vuln({ symbol: "runQuery", line: 12 }));
  assert.equal(f.severity, "warn");
  assert.equal(f.path, "backend/src/db.ts");
  assert.match(f.concern, /\[sql-injection\]/);
  assert.match(f.concern, /\(runQuery:12\)/);
  assert.match(f.concern, /not introduced by this PR/);
  assert.equal(f.fixPrompt, "fix");
});

test("formatResolvedFinding: frames it as resolved, drops the fixPrompt (nothing to fix)", () => {
  const f = formatResolvedFinding(vuln({ symbol: "runQuery", line: 12 }));
  assert.equal(f.severity, "warn");
  assert.match(f.concern, /resolved by this PR/);
  assert.match(f.concern, /\(runQuery:12\)/);
  assert.equal(f.fixPrompt, undefined);
});

// ── partitionReverifiedVulns ──────────────────────────────────────────────────

test("partitionReverifiedVulns: a 'resolved' verdict moves the vuln to resolved, 'present' keeps it", () => {
  const entries = [
    entry("backend/src/db.ts", [
      vuln({ concern: "fixed one" }),
      vuln({ id: "v2", concern: "still here" }),
    ]),
  ];
  const verdicts = new Map([
    [
      "backend/src/db.ts",
      [
        { index: 0, status: "resolved" },
        { index: 1, status: "present" },
      ],
    ],
  ]);
  const out = partitionReverifiedVulns(entries, verdicts);
  assert.equal(out.resolved.length, 1);
  assert.match(out.resolved[0].concern, /fixed one/);
  assert.match(out.resolved[0].concern, /resolved by this PR/);
  assert.equal(out.stillPresent.length, 1);
  assert.match(out.stillPresent[0].concern, /still here/);
  assert.match(out.stillPresent[0].concern, /not introduced by this PR/);
});

test("partitionReverifiedVulns: a file with NO verdict keeps every vuln still-present (safe default)", () => {
  const entries = [entry("backend/src/db.ts", [vuln(), vuln({ id: "v2", concern: "second" })])];
  const out = partitionReverifiedVulns(entries, new Map()); // fetch/LLM failed → no entry
  assert.equal(out.resolved.length, 0);
  assert.equal(out.stillPresent.length, 2);
});

test("partitionReverifiedVulns: an out-of-range or unparseable status stays still-present", () => {
  const entries = [entry("backend/src/db.ts", [vuln()])];
  // index 5 doesn't exist; the real vuln at index 0 has no verdict → present.
  const verdicts = new Map([["backend/src/db.ts", [{ index: 5, status: "resolved" }]]]);
  const out = partitionReverifiedVulns(entries, verdicts);
  assert.equal(out.resolved.length, 0);
  assert.equal(out.stillPresent.length, 1);

  // A garbage status string is not "resolved" → present.
  const out2 = partitionReverifiedVulns(
    entries,
    new Map([["backend/src/db.ts", [{ index: 0, status: "maybe?" }]]])
  );
  assert.equal(out2.resolved.length, 0);
  assert.equal(out2.stillPresent.length, 1);
});

test("partitionReverifiedVulns: dedupes identical path+concern across entries", () => {
  const v = vuln({ concern: "same concern" });
  const entries = [
    entry("backend/src/db.ts", [v]),
    entry("backend/src/db.ts", [{ ...v, id: "v2" }]),
  ];
  const out = partitionReverifiedVulns(entries, new Map());
  assert.equal(out.stillPresent.length, 1);
});
