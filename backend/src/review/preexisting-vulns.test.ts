// Unit tests for collectPreexistingVulns — the helper that turns stored
// security findings (for files a PR touches/depends on) into advisory
// findings. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/preexisting-vulns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPreexistingVulns, type PreexistingVulnLike } from "./pipeline.js";

const vuln = (over: Partial<PreexistingVulnLike> = {}): PreexistingVulnLike => ({
  id: "v",
  class: "sql-injection",
  path: "backend/src/db.ts",
  concern: "raw query built from user input",
  fixPrompt: "fix",
  ...over,
});

test("collectPreexistingVulns: forces advisory 'warn' even for a stored blocker, and labels it pre-existing", () => {
  const out = collectPreexistingVulns([vuln()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warn"); // never a blocker — the PR didn't introduce it
  assert.match(out[0].concern, /not introduced by this PR/);
  assert.match(out[0].concern, /\[sql-injection\]/);
  assert.equal(out[0].path, "backend/src/db.ts");
});

test("collectPreexistingVulns: dedupes identical path+concern across entries", () => {
  const v = vuln({ concern: "same concern" });
  const out = collectPreexistingVulns([v, { ...v, id: "v2" }]);
  assert.equal(out.length, 1);
});

test("collectPreexistingVulns: includes a symbol:line locator when present", () => {
  const out = collectPreexistingVulns([vuln({ symbol: "runQuery", line: 12 })]);
  assert.match(out[0].concern, /\(runQuery:12\)/);
});

test("collectPreexistingVulns: caps the total surfaced findings at 20", () => {
  const many = Array.from({ length: 30 }, (_, i) => vuln({ id: `v${i}`, concern: `c${i}` }));
  const out = collectPreexistingVulns(many);
  assert.equal(out.length, 20);
});

test("collectPreexistingVulns: entries with no vulnerabilities yield nothing", () => {
  const out = collectPreexistingVulns([]);
  assert.equal(out.length, 0);
});
