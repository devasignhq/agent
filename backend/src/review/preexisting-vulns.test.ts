// Unit tests for collectPreexistingVulns — the helper that turns the repo
// index's stored vulnerabilities (for files a PR touches/depends on) into
// advisory findings. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/preexisting-vulns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPreexistingVulns } from "./pipeline.js";
import type { RepoIndexEntry, Vulnerability } from "../types.js";

const vuln = (over: Partial<Vulnerability> = {}): Vulnerability => ({
  id: "v",
  class: "sql-injection",
  severity: "blocker",
  path: "backend/src/db.ts",
  concern: "raw query built from user input",
  fixPrompt: "fix",
  detectedSha: "sha",
  detectedAt: 0,
  model: "m",
  ...over,
});

const entry = (path: string, vulns: Vulnerability[]): RepoIndexEntry => ({
  id: path,
  repoId: "r1",
  path,
  sha: "sha",
  size: 100,
  language: "ts",
  summary: "",
  exports: [],
  imports: [],
  securityFlags: ["raw-sql"],
  vulnerabilities: vulns,
  securityScannedSha: "sha",
  indexedAt: 0,
  model: "m",
});

// Only `entries` is read; the rest satisfies the HolisticContext shape.
const ctx = (entries: RepoIndexEntry[]) => ({
  entries,
  touchedCount: entries.length,
  dependentCount: 0,
  manifest: [],
});

test("collectPreexistingVulns: forces advisory 'warn' even for a stored blocker, and labels it pre-existing", () => {
  const out = collectPreexistingVulns(ctx([entry("backend/src/db.ts", [vuln({ severity: "blocker" })])]));
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warn"); // never a blocker — the PR didn't introduce it
  assert.match(out[0].concern, /not introduced by this PR/);
  assert.match(out[0].concern, /\[sql-injection\]/);
  assert.equal(out[0].path, "backend/src/db.ts");
});

test("collectPreexistingVulns: dedupes identical path+concern across entries", () => {
  const v = vuln({ concern: "same concern" });
  const out = collectPreexistingVulns(
    ctx([
      entry("backend/src/db.ts", [v]),
      entry("backend/src/db.ts", [{ ...v, id: "v2" }]),
    ])
  );
  assert.equal(out.length, 1);
});

test("collectPreexistingVulns: includes a symbol:line locator when present", () => {
  const out = collectPreexistingVulns(ctx([entry("backend/src/db.ts", [vuln({ symbol: "runQuery", line: 12 })])]));
  assert.match(out[0].concern, /\(runQuery:12\)/);
});

test("collectPreexistingVulns: caps the total surfaced findings at 20", () => {
  const many = Array.from({ length: 30 }, (_, i) => vuln({ id: `v${i}`, concern: `c${i}` }));
  const out = collectPreexistingVulns(ctx([entry("backend/src/db.ts", many)]));
  assert.equal(out.length, 20);
});

test("collectPreexistingVulns: entries with no vulnerabilities yield nothing", () => {
  const out = collectPreexistingVulns(ctx([entry("backend/src/x.ts", [])]));
  assert.equal(out.length, 0);
});
