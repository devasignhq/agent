// Family detection, edge building, staleness and the manifest/YAML readers.
// Pure functions only — no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/topology.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_MAX_AGE_MS,
  buildEdges,
  detectFamilies,
  familyOf,
  parseFamilyDeclaration,
  parseManifest,
  rankSiblings,
  topologyStale,
} from "./topology.js";
import type { RepoTopology, TopoRepo } from "../../types.js";

function repo(fullName: string, patch: Partial<TopoRepo> = {}): TopoRepo {
  return {
    fullName,
    kind: "unknown",
    declaredDeps: [],
    archived: false,
    pushedAt: 1_700_000_000_000,
    defaultBranch: "main",
    ...patch,
  };
}

test("detectFamilies clusters an SDK family on naming", () => {
  const fams = detectFamilies([
    repo("acme/acme-sdk-ts"),
    repo("acme/acme-sdk-go"),
    repo("acme/acme-sdk-python"),
    repo("acme/unrelated-tool"),
  ]);
  assert.equal(fams.length, 1);
  assert.equal(fams[0].name, "acme-sdk");
  assert.equal(fams[0].kind, "sdk-family");
  assert.deepEqual(fams[0].members, ["acme/acme-sdk-go", "acme/acme-sdk-python", "acme/acme-sdk-ts"]);
});

test("declared sisters win over naming and carry high confidence", () => {
  const fams = detectFamilies(
    [repo("acme/service"), repo("acme/soroban-escrow"), repo("acme/bounty-escrow")],
    [{ repo: "acme/service", name: "escrow", sisters: ["acme/soroban-escrow", "acme/bounty-escrow"] }]
  );
  assert.equal(fams.length, 1);
  assert.equal(fams[0].name, "escrow");
  assert.equal(fams[0].confidence, "high");
  assert.equal(fams[0].members.length, 3);
  assert.ok(fams[0].evidence.some((e) => e.includes(".devasign.yml")));
});

test("a declared sister that is not connected is recorded, not silently dropped", () => {
  const fams = detectFamilies(
    [repo("acme/service"), repo("acme/soroban-escrow")],
    [{ repo: "acme/service", sisters: ["acme/soroban-escrow", "acme/never-installed"] }]
  );
  assert.equal(fams.length, 1);
  assert.ok(fams[0].evidence.some((e) => e.includes("not connected") && e.includes("never-installed")));
  assert.ok(!fams[0].members.includes("acme/never-installed"));
});

test("a declaration naming only unconnected sisters produces no family", () => {
  const fams = detectFamilies(
    [repo("acme/service")],
    [{ repo: "acme/service", sisters: ["acme/nope"] }]
  );
  assert.equal(fams.length, 0);
});

test("a shared contract outranks the naming signal on kind", () => {
  const fams = detectFamilies(
    [repo("acme/alpha"), repo("acme/beta")],
    [
      { repo: "acme/alpha", sisters: [], contract: "acme/spec:openapi.yaml" },
      { repo: "acme/beta", sisters: [], contract: "acme/spec:openapi.yaml" },
    ]
  );
  assert.equal(fams.length, 1);
  assert.equal(fams[0].kind, "shared-contract");
  assert.ok(fams[0].evidence.some((e) => e.includes("shared contract")));
});

test("a dependency edge forms a service-client family", () => {
  const fams = detectFamilies([
    repo("acme/core", { publishedName: "@acme/core" }),
    repo("acme/dashboard", { declaredDeps: ["@acme/core", "react"] }),
  ]);
  assert.equal(fams.length, 1);
  assert.equal(fams[0].kind, "service-client");
  assert.ok(fams[0].evidence.some((e) => e.includes("depends on @acme/core")));
});

test("overlapping signals merge into one family keeping the strongest confidence", () => {
  const fams = detectFamilies(
    [
      repo("acme/acme-sdk-ts", { publishedName: "@acme/sdk" }),
      repo("acme/acme-sdk-go"),
      repo("acme/acme-web", { declaredDeps: ["@acme/sdk"] }),
    ],
    [{ repo: "acme/acme-sdk-ts", name: "acme-sdk", sisters: ["acme/acme-sdk-go"] }]
  );
  assert.equal(fams.length, 1);
  assert.equal(fams[0].confidence, "high");
  assert.equal(fams[0].members.length, 3);
});

test("archived repos stay off the family map", () => {
  const fams = detectFamilies([
    repo("acme/acme-sdk-ts"),
    repo("acme/acme-sdk-go", { archived: true }),
  ]);
  assert.equal(fams.length, 0);
});

test("a lone repo is never a family", () => {
  assert.deepEqual(detectFamilies([repo("acme/solo")]), []);
  assert.deepEqual(detectFamilies([]), []);
});

test("buildEdges derives package-dep edges and dedupes", () => {
  const edges = buildEdges([
    repo("acme/core", { publishedName: "@acme/core" }),
    repo("acme/web", { declaredDeps: ["@acme/core", "@acme/core"] }),
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].consumer, "acme/web");
  assert.equal(edges[0].provider, "acme/core");
  assert.equal(edges[0].via, "package-dep");
  assert.equal(edges[0].confidence, "high");
});

test("buildEdges never points a repo at itself and ignores unknown deps", () => {
  const edges = buildEdges([
    repo("acme/core", { publishedName: "@acme/core", declaredDeps: ["@acme/core", "lodash"] }),
  ]);
  assert.deepEqual(edges, []);
});

test("buildEdges derives an http-contract edge from a declaration", () => {
  const edges = buildEdges(
    [repo("acme/web"), repo("acme/spec")],
    [{ repo: "acme/web", sisters: [], contract: "acme/spec:openapi.yaml" }]
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].via, "http-contract");
  assert.equal(edges[0].provider, "acme/spec");
});

function topo(patch: Partial<RepoTopology> = {}): RepoTopology {
  return {
    id: "t1",
    installationId: "i1",
    owner: "acme",
    isOrg: true,
    generatedAt: 1_000_000,
    buildMs: 10,
    repoCount: 3,
    repoIdsAtBuild: 3,
    totalCount: 3,
    truncated: false,
    repos: [],
    families: [],
    edges: [],
    codeSearch: { status: "ok", probedAt: 1_000_000 },
    error: null,
    ...patch,
  };
}

test("topologyStale: a missing map is always stale", () => {
  assert.equal(topologyStale(null, { repoIds: [1, 2, 3] }, 1_000_000), true);
});

test("topologyStale: fresh map with an unchanged repo set is not stale", () => {
  assert.equal(topologyStale(topo(), { repoIds: [1, 2, 3] }, 1_000_100), false);
});

test("topologyStale: age past the max triggers a rebuild", () => {
  assert.equal(topologyStale(topo(), { repoIds: [1, 2, 3] }, 1_000_000 + TOPOLOGY_MAX_AGE_MS), true);
});

test("topologyStale: a changed connected-repo count triggers a rebuild", () => {
  assert.equal(topologyStale(topo(), { repoIds: [1, 2, 3, 4] }, 1_000_100), true);
  assert.equal(topologyStale(topo(), { repoIds: [1, 2] }, 1_000_100), true);
});

test("topologyStale: a truncated build does not rebuild forever", () => {
  // repoCount (60 classified) diverges from repoIds (150 connected); comparing
  // against repoIdsAtBuild is what keeps the hourly sweep from looping.
  const truncated = topo({ repoCount: 60, repoIdsAtBuild: 150, totalCount: 150, truncated: true });
  const live = { repoIds: Array.from({ length: 150 }, (_, i) => i) };
  assert.equal(topologyStale(truncated, live, 1_000_100), false);
});

test("familyOf picks the highest-confidence family for a repo", () => {
  const t = topo({
    families: [
      { name: "weak", kind: "monorepo-split", members: ["acme/a"], confidence: "low", evidence: [] },
      { name: "strong", kind: "sdk-family", members: ["acme/a"], confidence: "high", evidence: [] },
    ],
  });
  assert.equal(familyOf(t, "acme/a")?.name, "strong");
  assert.equal(familyOf(t, "acme/zzz"), null);
  assert.equal(familyOf(null, "acme/a"), null);
});

test("rankSiblings puts declared consumers first and drops archived repos", () => {
  const t = topo({
    repos: [repo("acme/web"), repo("acme/dead", { archived: true }), repo("acme/other")],
    edges: [
      { consumer: "acme/web", provider: "acme/core", via: "package-dep", evidence: "", confidence: "high" },
    ],
  });
  const ranked = rankSiblings(t, "acme/core", ["acme/web", "acme/dead", "acme/other"], 5);
  assert.equal(ranked[0], "acme/web");
  assert.ok(!ranked.includes("acme/dead"));
  assert.ok(!ranked.includes("acme/core"));
});

test("rankSiblings works with no topology at all", () => {
  const ranked = rankSiblings(null, "acme/core", ["acme/web", "acme/other"], 5);
  assert.equal(ranked.length, 2);
  assert.ok(!ranked.includes("acme/core"));
});

test("parseManifest reads package.json name and deps", () => {
  const out = parseManifest(
    "package.json",
    JSON.stringify({ name: "@acme/core", dependencies: { react: "^18" }, devDependencies: { tsx: "^4" } })
  );
  assert.equal(out.publishedName, "@acme/core");
  assert.ok(out.declaredDeps.includes("react"));
  assert.ok(out.declaredDeps.includes("tsx"));
});

test("parseManifest survives a malformed manifest", () => {
  const out = parseManifest("package.json", "{ not json");
  assert.equal(out.publishedName, undefined);
  assert.deepEqual(out.declaredDeps, []);
});

test("parseManifest reads a go.mod module path", () => {
  const out = parseManifest("go.mod", "module github.com/acme/sdk-go\n\nrequire github.com/pkg/errors v0.9.1\n");
  assert.equal(out.publishedName, "github.com/acme/sdk-go");
  assert.ok(out.declaredDeps.includes("github.com/pkg/errors"));
});

test("parseFamilyDeclaration reads the family block, comments and all", () => {
  const yml = [
    "version: 2",
    "family:                       # explicit sister declaration",
    "  name: devasign-escrow",
    "  role: service",
    "  sisters:",
    "    # both contracts expose the same entrypoints",
    "    - devasignhq/soroban-escrow",
    "    - devasignhq/bounty-escrow",
    "parity:",
    "  policy: note",
  ].join("\n");
  const d = parseFamilyDeclaration("devasignhq/devasign-app", yml);
  assert.ok(d);
  assert.equal(d!.name, "devasign-escrow");
  assert.equal(d!.role, "service");
  assert.deepEqual(d!.sisters, ["devasignhq/soroban-escrow", "devasignhq/bounty-escrow"]);
});

test("parseFamilyDeclaration stops at the next top-level key", () => {
  const yml = "family:\n  name: fam\n  sisters:\n    - a/b\nmoney:\n  paths:\n    - c/d\n";
  const d = parseFamilyDeclaration("a/root", yml);
  assert.deepEqual(d!.sisters, ["a/b"]);
});

test("parseFamilyDeclaration returns null when there is no family block", () => {
  assert.equal(parseFamilyDeclaration("a/b", "version: 2\nreview:\n  language: en\n"), null);
  assert.equal(parseFamilyDeclaration("a/b", ""), null);
});
