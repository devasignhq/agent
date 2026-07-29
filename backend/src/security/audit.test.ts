// Unit tests for the audit's inventory gate (selectCandidates). This is the
// step that decides which files a run pays a frontier call for, and a bug here
// is silent: the run completes "successfully" having scanned nothing, and the
// dashboard's introduced-vs-resolved chart draws an empty column. No db /
// network / LLM. Run:
//   node --import tsx/esm --test src/security/audit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_ENGINE, selectCandidates } from "./audit.js";
import { DEFAULT_SECURITY_POLICY } from "./policy.js";
import type { RepoIndexEntry } from "../types.js";

const entry = (over: Partial<RepoIndexEntry> = {}): RepoIndexEntry => ({
  id: "e1",
  repoId: "r1",
  path: "backend/src/routes/pay.ts",
  sha: "blob1",
  size: 100,
  language: "ts",
  summary: "payment route",
  exports: [],
  imports: [],
  securityFlags: ["handles-money"],
  indexedAt: 0,
  model: "m",
  ...over,
});

const policy = DEFAULT_SECURITY_POLICY;
const select = (entries: RepoIndexEntry[], full = false) =>
  selectCandidates({ entries, policy, scopePaths: null, full });

// The regression this file exists for: the pre-audit-agent indexer stamped
// securityScannedSha on every file it indexed, scanned or not. Treating that as
// a cache hit made every run on a legacy-indexed repo a 100% cache hit forever.
test("a legacy stamp (no engine tag) is owed a scan, not a cache hit", () => {
  const out = select([entry({ securityScannedSha: "blob1" })]);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.cacheHits, 0);
});

test("a stamp from this engine at the current sha is a cache hit", () => {
  const out = select([entry({ securityScannedSha: "blob1", securityEngine: SECURITY_ENGINE })]);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.cacheHits, 1);
});

test("a full run re-scans even a warm cache — 'Re-scan' has to mean re-scan", () => {
  const warm = entry({ securityScannedSha: "blob1", securityEngine: SECURITY_ENGINE });
  assert.equal(select([warm], true).candidates.length, 1);
  assert.equal(select([warm], true).cacheHits, 0);
});

test("a changed blob is owed a scan even with a current-engine stamp", () => {
  const out = select([entry({ sha: "blob2", securityScannedSha: "blob1", securityEngine: SECURITY_ENGINE })]);
  assert.equal(out.candidates.length, 1);
});

test("the flags/surface gate still applies: unflagged app code is skipped entirely", () => {
  // Not a candidate and not a cache hit — it never enters the inventory.
  const out = select([entry({ path: "frontend/src/theme.ts", securityFlags: [] })]);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.cacheHits, 0);
});

test("unflagged deps/infra are structural risk and stay candidates", () => {
  const out = select([
    entry({ id: "e2", path: "package.json", securityFlags: [] }),
    entry({ id: "e3", path: ".github/workflows/ci.yml", securityFlags: [] }),
  ]);
  assert.equal(out.candidates.length, 2);
});

test("a disabled engine drops its surface", () => {
  const out = selectCandidates({
    entries: [entry()],
    policy: { ...policy, engines: { ...policy.engines, api: false } },
    scopePaths: null,
    full: true,
  });
  assert.equal(out.candidates.length, 0);
});

test("differential scope keeps a run to the paths the merge touched", () => {
  const out = selectCandidates({
    entries: [entry(), entry({ id: "e2", path: "backend/src/routes/auth.ts" })],
    policy,
    scopePaths: new Set(["backend/src/routes/auth.ts"]),
    full: false,
  });
  assert.deepEqual(out.candidates.map((c) => c.path), ["backend/src/routes/auth.ts"]);
});
