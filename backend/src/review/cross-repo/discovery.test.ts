// Candidate ranking, excerpting, and the "never claim absence over a repo we
// did not read" rule. In-memory db only, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/discovery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import {
  excerptAround,
  loadSiblingIndexes,
  needlesFor,
  probeParity,
  rankCandidates,
} from "./discovery.js";
import type { RepoIndexEntry } from "../../types.js";

function seedRepo(owner: string, name: string, indexState: "ready" | "none" = "ready") {
  const id = uuid();
  db.insert("repositories", {
    id,
    installationId: uuid(),
    owner,
    name,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState,
  } as any);
  return id;
}

function seedEntry(repoId: string, patch: Partial<RepoIndexEntry> = {}) {
  const row: RepoIndexEntry = {
    id: uuid(),
    repoId,
    path: "src/a.ts",
    sha: "sha1",
    size: 100,
    language: "ts",
    summary: "A file.",
    exports: [],
    imports: [],
    securityFlags: [],
    indexedAt: 1,
    model: "m",
    ...patch,
  };
  db.insert("repoIndex", row);
  return row;
}

test("excerptAround finds the needle and windows around it", () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n").replace("line 30", "createBounty(a);");
  const got = excerptAround(text, ["createBounty"], { radius: 2 });
  assert.ok(got);
  assert.equal(got!.line, 31);
  assert.equal(got!.matchedOn, "createBounty");
  assert.match(got!.excerpt, /createBounty\(a\);/);
  assert.equal(got!.excerpt.split("\n").length, 5);
});

test("excerptAround returns null when the bytes do not contain the needle", () => {
  // This is the rule that stops an LLM-produced index entry from becoming evidence.
  assert.equal(excerptAround("nothing to see here", ["createBounty"]), null);
  assert.equal(excerptAround("", ["createBounty"]), null);
  assert.equal(excerptAround("createBounty", []), null);
});

test("excerptAround caps the excerpt length", () => {
  const text = "x".repeat(50) + "\ncreateBounty\n" + "y".repeat(50_000);
  const got = excerptAround(text, ["createBounty"], { maxChars: 100 });
  assert.ok(got!.excerpt.length <= 100);
});

test("loadSiblingIndexes only returns repos with a usable index", () => {
  const ready = seedRepo("acme", "ready-repo", "ready");
  seedRepo("acme", "unindexed-repo", "none");
  seedEntry(ready, { path: "src/x.ts" });
  const out = loadSiblingIndexes(["acme/ready-repo", "acme/unindexed-repo", "acme/missing-repo"]);
  assert.deepEqual(out.map((s) => s.fullName), ["acme/ready-repo"]);
  assert.equal(out[0].entries.length, 1);
});

test("rankCandidates puts a package-level importer above a lexical match", () => {
  const id = seedRepo("acme", "rank-web");
  seedEntry(id, { path: "src/importer.ts", imports: ["@acme/core"] });
  seedEntry(id, { path: "src/prose.ts", summary: "mentions createBounty in passing" });
  const siblings = loadSiblingIndexes(["acme/rank-web"]);
  const ranked = rankCandidates(siblings, [needlesFor("createBounty", "symbol")], "@acme/core", 10);
  assert.equal(ranked[0].entry.path, "src/importer.ts");
  assert.equal(ranked[0].matchedOn, "@acme/core");
});

test("rankCandidates matches an exported symbol in a sibling", () => {
  const id = seedRepo("acme", "rank-sdk");
  seedEntry(id, { path: "src/bounty.ts", exports: ["create_bounty"] });
  const siblings = loadSiblingIndexes(["acme/rank-sdk"]);
  const ranked = rankCandidates(siblings, [needlesFor("createBounty", "symbol")], undefined, 10);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].matchedOn, "create_bounty");
});

test("rankCandidates honours the limit", () => {
  const id = seedRepo("acme", "rank-many");
  for (let i = 0; i < 10; i++) seedEntry(id, { path: `src/f${i}.ts`, exports: ["createBounty"] });
  const siblings = loadSiblingIndexes(["acme/rank-many"]);
  assert.equal(rankCandidates(siblings, [needlesFor("createBounty", "symbol")], undefined, 3).length, 3);
});

test("probeParity reports present when a sibling exports the symbol", () => {
  const id = seedRepo("acme", "parity-go");
  seedEntry(id, { path: "bounty.go", exports: ["CreateBounty"] });
  const [probe] = probeParity(["acme/parity-go"], "createBounty");
  assert.equal(probe.status, "present");
  assert.match(probe.searched, /CreateBounty/);
});

test("probeParity reports absent only for a repo it actually read", () => {
  const id = seedRepo("acme", "parity-empty");
  seedEntry(id, { path: "other.go", exports: ["Unrelated"] });
  const [probe] = probeParity(["acme/parity-empty"], "createBounty");
  assert.equal(probe.status, "absent");
  assert.match(probe.searched, /indexed files/);
});

test("probeParity says unknown — never absent — for an unindexed sibling", () => {
  seedRepo("acme", "parity-unindexed", "none");
  const [probe] = probeParity(["acme/parity-unindexed"], "createBounty");
  assert.equal(probe.status, "unknown");
  assert.match(probe.searched, /no index for this repo/);
});

test("loadSiblingIndexes keeps a repo whose index is built but empty", () => {
  seedRepo("acme", "empty-but-ready", "ready");
  const out = loadSiblingIndexes(["acme/empty-but-ready"]);
  assert.equal(out.length, 1, "a ready repo with zero rows must still be represented");
  assert.deepEqual(out[0].entries, []);
});

test("probeParity will not call a zero-file index 'absent'", () => {
  // Searching nothing and reporting absent is an affirmative claim about a repo
  // we never looked inside — the one thing parity must never do.
  seedRepo("acme", "empty-parity", "ready");
  const [probe] = probeParity(["acme/empty-parity"], "createBounty");
  assert.equal(probe.status, "unknown");
  assert.match(probe.searched, /no indexable files/);
});

test("an empty sibling index contributes no candidates and does not throw", () => {
  seedRepo("acme", "empty-rank", "ready");
  const siblings = loadSiblingIndexes(["acme/empty-rank"]);
  assert.deepEqual(rankCandidates(siblings, [needlesFor("createBounty", "symbol")], "@acme/core", 5), []);
});
