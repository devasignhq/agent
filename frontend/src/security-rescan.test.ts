// Run: node --experimental-strip-types --test src/security-rescan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSelection,
  scanningRepoIds,
  scanProgressLabel,
  selectableRepos,
  summarizeRescan,
} from "./security-rescan.ts";
import type { SecurityRepoView, SecurityScanSummary } from "./api.ts";

function repo(id: string): SecurityRepoView {
  return {
    id,
    owner: "acme",
    name: id,
    defaultBranch: "main",
    indexState: "ready",
    indexedAt: 1,
    policy: {
      version: 1,
      triggers: { onMerge: true, onPrPush: false, nightly: false, advisories: false },
      engines: { api: true, frontend: true, infra: true, secrets: true, deps: true },
      gates: { critical: "block", high: "block", medium: "warn", low: "track" },
    },
    gate: { verdict: "pass", rules: [], blockingFindingIds: [] },
    latestScan: null,
  };
}

function scan(repoId: string, status: SecurityScanSummary["status"]): SecurityScanSummary {
  return {
    id: `scan-${repoId}-${status}`,
    repoId,
    trigger: "manual",
    full: true,
    status,
    startedAt: 1,
    filesScanned: 0,
    cacheHits: 0,
    introduced: 0,
    resolved: 0,
    stillOpen: 0,
  };
}

const REPOS = [repo("a"), repo("b"), repo("c")];

test("scanningRepoIds picks up queued and running, ignores settled runs", () => {
  const busy = scanningRepoIds([
    scan("a", "queued"),
    scan("b", "running"),
    scan("c", "completed"),
    scan("c", "errored"),
  ]);
  assert.deepEqual([...busy].sort(), ["a", "b"]);
});

test("a repo with an older completed run is still selectable", () => {
  const busy = scanningRepoIds([scan("a", "completed"), scan("a", "errored")]);
  assert.deepEqual(
    selectableRepos(REPOS, busy).map((r) => r.id),
    ["a", "b", "c"]
  );
});

test("defaultSelection follows the dashboard filter when it names a free repo", () => {
  assert.deepEqual([...defaultSelection(REPOS, new Set(), "b")], ["b"]);
});

test("defaultSelection falls back to every free repo for the 'all' filter", () => {
  const busy = new Set(["b"]);
  assert.deepEqual([...defaultSelection(REPOS, busy, "all")].sort(), ["a", "c"]);
});

test("defaultSelection ignores a filter pointing at a repo that is already scanning", () => {
  const busy = new Set(["b"]);
  assert.deepEqual([...defaultSelection(REPOS, busy, "b")].sort(), ["a", "c"]);
});

test("with every repo scanning there is nothing to pre-select", () => {
  const busy = new Set(["a", "b", "c"]);
  assert.equal(selectableRepos(REPOS, busy).length, 0);
  assert.equal(defaultSelection(REPOS, busy, "all").size, 0);
});

test("scanProgressLabel is null when idle and counts busy repos otherwise", () => {
  assert.equal(scanProgressLabel(REPOS, new Set()), null);
  assert.equal(scanProgressLabel(REPOS, new Set(["a", "b"])), "Scanning 2 of 3 repositories…");
  assert.equal(scanProgressLabel([repo("a")], new Set(["a"])), "Scanning 1 of 1 repository…");
});

test("scanProgressLabel ignores scans for repos no longer in the install", () => {
  assert.equal(scanProgressLabel(REPOS, new Set(["gone"])), null);
});

test("summarizeRescan reports queued and skipped counts", () => {
  assert.equal(
    summarizeRescan({
      ok: true,
      queued: [
        { repoId: "a", scanRunId: "1" },
        { repoId: "c", scanRunId: "2" },
      ],
      skipped: [{ repoId: "b", reason: "in_progress" }],
    }),
    "Re-scan queued for 2 repositories · 1 already scanning"
  );
  assert.equal(
    summarizeRescan({ ok: true, queued: [{ repoId: "a", scanRunId: "1" }], skipped: [] }),
    "Re-scan queued for 1 repository"
  );
  assert.equal(summarizeRescan({ ok: true, queued: [], skipped: [] }), "Nothing to scan.");
});
