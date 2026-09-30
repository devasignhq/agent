// Unit tests for collectPreexistingVulns — the helper that turns stored
// security findings (for files a PR touches/depends on) into advisory
// findings. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/preexisting-vulns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPreexistingVulns, presentablePreexisting, type PreexistingVulnLike } from "./pipeline.js";
import type { SecurityFinding } from "../types.js";

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

const stored = (over: Partial<SecurityFinding>): SecurityFinding => ({
  id: "s",
  fingerprint: "fp",
  repoId: "r1",
  path: "backend/src/db.ts",
  class: "sql-injection",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "t",
  concern: "c",
  state: "open",
  firstDetectedAt: 1,
  lastSeenAt: 1,
  detectedSha: "blob1",
  model: "m",
  activity: [],
  ...over,
});

test("presentablePreexisting: without the proof gate every active stored finding is mentioned", () => {
  const out = presentablePreexisting(
    [stored({ id: "a" }), stored({ id: "b", state: "unverified" }), stored({ id: "c", state: "accepted" })],
    false
  );
  assert.deepEqual(out.map((f) => f.id), ["a"]);
});

test("presentablePreexisting: under the proof gate untested stored findings reach neither advisories nor re-verify", () => {
  const proof = { status: "verified" as const, method: "test" as const, blobSha: "blob1", engine: "proof-v1", updatedAt: 1 };
  const out = presentablePreexisting(
    [
      stored({ id: "untested" }),
      stored({ id: "proven", proof }),
      stored({ id: "stale", proof: { ...proof, blobSha: "blob0" } }),
      stored({ id: "held-but-proven", state: "unverified", proof }),
      stored({ id: "kept", state: "issue_created", issueNumber: 3 }),
    ],
    true
  );
  assert.deepEqual(out.map((f) => f.id), ["proven", "held-but-proven"]);
});
