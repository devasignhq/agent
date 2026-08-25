// Contract-delta pre-scan, normalisation, and the drop rules that keep an
// advisory finding honest. No network, no db. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/stage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMPACT_FINDINGS,
  needlesForDelta,
  normaliseContractDelta,
  normaliseImpacts,
  normaliseParityNotes,
  scanContractCandidates,
  type ContractDeltaEntry,
} from "./stage.js";
import type { CandidateSnippet, ParityProbe } from "./discovery.js";

function diffFor(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n${body}\n`;
}

test("scanContractCandidates finds exported surfaces", () => {
  assert.deepEqual(
    scanContractCandidates(diffFor("src/api.ts", "+export function createBounty() {}")),
    ["src/api.ts"]
  );
  assert.deepEqual(
    scanContractCandidates(diffFor("pkg/api.go", "+func CreateBounty(ctx context.Context) {}")),
    ["pkg/api.go"]
  );
  assert.deepEqual(
    scanContractCandidates(diffFor("lib/api.py", "+def create_bounty(x):")),
    ["lib/api.py"]
  );
});

test("scanContractCandidates finds routes and env vars", () => {
  assert.equal(scanContractCandidates(diffFor("src/r.ts", '+router.post("/v1/payouts", h);')).length, 1);
  assert.equal(scanContractCandidates(diffFor("src/c.ts", "+const n = process.env.STELLAR_NETWORK;")).length, 1);
});

test("scanContractCandidates flags contract-shaped paths outright", () => {
  assert.deepEqual(scanContractCandidates(diffFor("api/schema.graphql", "+  field: String")), ["api/schema.graphql"]);
  assert.deepEqual(scanContractCandidates(diffFor("contracts/escrow.rs", "+  let x = 1;")), ["contracts/escrow.rs"]);
});

test("scanContractCandidates is empty for a purely internal change", () => {
  const diff = diffFor("src/util.ts", "+  const helper = () => 1;\n-  const helper = () => 0;");
  assert.deepEqual(scanContractCandidates(diff), []);
  assert.deepEqual(scanContractCandidates(""), []);
});

test("normaliseContractDelta drops entries with an unknown enum value", () => {
  const out = normaliseContractDelta([
    { surface: "ts-export", name: "a", change: "added", compat: "compatible", path: "p" },
    { surface: "nope", name: "b", change: "added", compat: "compatible", path: "p" },
    { surface: "ts-export", name: "c", change: "exploded", compat: "compatible", path: "p" },
    { surface: "ts-export", name: "d", change: "added", compat: "maybe", path: "p" },
    { surface: "ts-export", name: "", change: "added", compat: "compatible", path: "p" },
  ]);
  assert.deepEqual(out.map((e) => e.name), ["a"]);
});

test("normaliseContractDelta dedupes and tolerates junk input", () => {
  const dup = { surface: "http", name: "POST /v1/x", change: "added", compat: "compatible", path: "p" };
  assert.equal(normaliseContractDelta([dup, { ...dup }]).length, 1);
  assert.deepEqual(normaliseContractDelta(null), []);
  assert.deepEqual(normaliseContractDelta("nope"), []);
});

test("needlesForDelta skips compatible entries and routes route-surfaces", () => {
  const delta: ContractDeltaEntry[] = [
    { surface: "ts-export", name: "createBounty", change: "signature_changed", detail: "", compat: "breaking", path: "p" },
    { surface: "ts-export", name: "listPayouts", change: "added", detail: "", compat: "compatible", path: "p" },
    { surface: "http", name: "POST /v1/payouts", change: "removed", detail: "", compat: "breaking", path: "p" },
  ];
  const needles = needlesForDelta(delta);
  assert.deepEqual(needles.map((n) => n.name), ["createBounty", "POST /v1/payouts"]);
  assert.equal(needles[0].kind, "symbol");
  assert.ok(needles[0].variants.includes("create_bounty"));
  assert.equal(needles[1].kind, "route");
  assert.ok(needles[1].variants.includes("/v1/payouts"));
});

// Byte-confirmed excerpts, as excerptAround would have produced them.
function snip(repoFullName: string, path: string, excerpt: string): CandidateSnippet {
  return { repoFullName, path, sha: "s", line: 1, excerpt, matchedOn: "x", lane: "index" };
}

const READ = [
  snip("acme/web", "src/a.ts", "const b = await createBounty(a, b);\nreturn b;"),
  snip("acme/web", "src/f.ts", "call0()\ncall1()\ncall2()\ncall3()\ncall4()\ncall5()"),
];

test("normaliseImpacts drops any finding with no quoted consuming line", () => {
  const out = normaliseImpacts(
    [
      { where: "acme/web:src/a.ts", concern: "breaks", evidence: "createBounty(a, b)" },
      { where: "acme/web:src/b.ts", concern: "breaks too", evidence: "" },
      { where: "acme/web:src/c.ts", concern: "breaks as well" },
    ],
    READ
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "acme/web:src/a.ts");
});

test("normaliseImpacts drops a line the sibling's bytes do not contain", () => {
  // A real repo we really read, with a consuming line the model composed. This
  // is the case a repo-name-only check waved through.
  const out = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", concern: "breaks", evidence: "await refundEscrow(id);" }],
    READ
  );
  assert.deepEqual(out, []);
});

test("normaliseImpacts tolerates reformatting but not invention", () => {
  const readIt = [snip("acme/web", "src/a.ts", "  const b =\n    await createBounty(a, b);")];
  const reflowed = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", concern: "c", evidence: "const b = await createBounty(a, b);" }],
    readIt
  );
  assert.equal(reflowed.length, 1, "whitespace differences must not drop a real line");
  const invented = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", concern: "c", evidence: "const b = await createBounty(a, b, c);" }],
    readIt
  );
  assert.deepEqual(invented, [], "an extra argument is a different line");
});

test("normaliseImpacts drops every impact when no sibling code was read", () => {
  // The parity-only path reaches the model with "(no sibling code found)".
  const out = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", concern: "breaks", evidence: "createBounty(a, b)" }],
    []
  );
  assert.deepEqual(out, []);
});

test("normaliseImpacts forces warn severity whatever the model says", () => {
  const out = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", concern: "c", evidence: "createBounty(a, b)", severity: "blocker" }],
    READ
  );
  assert.equal(out[0].severity, "warn");
});

test("normaliseImpacts refuses a repo it never actually read", () => {
  const out = normaliseImpacts(
    [{ where: "acme/hallucinated:src/a.ts", concern: "c", evidence: "createBounty(a, b)" }],
    READ
  );
  assert.deepEqual(out, []);
});

test("normaliseImpacts keeps the consuming line in the rendered concern", () => {
  const read = [snip("acme/web", "src/a.ts", "x\nawait createBounty(t, a);\ny")];
  const out = normaliseImpacts(
    [{ where: "acme/web:src/a.ts", line: 88, concern: "It breaks.", evidence: "await createBounty(t, a);" }],
    read
  );
  assert.match(out[0].concern, /Consuming line: `await createBounty\(t, a\);`/);
  assert.equal(out[0].line, 88);
});

test("normaliseImpacts caps the finding count", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    where: `acme/web:src/f.ts`,
    concern: `breaks ${i}`,
    evidence: `call${i % 6}()`,
  }));
  assert.equal(normaliseImpacts(many, READ).length, MAX_IMPACT_FINDINGS);
});

function probes(entries: Array<[string, ParityProbe["status"]]>): ParityProbe[] {
  return entries.map(([repoFullName, status]) => ({ repoFullName, status, searched: "x, y" }));
}

test("normaliseParityNotes confirms absence against the probes, not the model", () => {
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "absent"]])]]);
  const out = normaliseParityNotes(
    [{ featureSlug: "list-payouts", title: "t", searched: "s", missingIn: ["acme/sdk-go"], concern: "c" }],
    map
  );
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].severity, "nit");
  assert.deepEqual(out.features[0].missingIn, ["acme/sdk-go"]);
});

test("normaliseParityNotes persists the canonical slug, not the model's spelling", () => {
  // parity.ts keys the stored row on `${family}/${slug}`. Persisting the raw
  // spelling made "listPayouts" and "list-payouts" two rows for one gap, which
  // re-notified every install member on the next review.
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "absent"]])]]);
  for (const spelling of ["listPayouts", "List_Payouts", "list-payouts"]) {
    const out = normaliseParityNotes(
      [{ featureSlug: spelling, title: "t", searched: "s", missingIn: ["acme/sdk-go"], concern: "c" }],
      map
    );
    assert.equal(out.features[0].slug, "list-payouts", `"${spelling}" must canonicalise`);
  }
});

test("normaliseParityNotes will not claim absence for an unread repo", () => {
  // probeParity marks a sibling with no index "unknown"; the note must not survive.
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "unknown"]])]]);
  const out = normaliseParityNotes(
    [{ featureSlug: "list-payouts", title: "t", searched: "s", missingIn: ["acme/sdk-go"], concern: "c" }],
    map
  );
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.features, []);
});

test("normaliseParityNotes drops a note that says nothing about what it searched", () => {
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "absent"]])]]);
  const out = normaliseParityNotes(
    [{ featureSlug: "list-payouts", title: "t", searched: "", missingIn: ["acme/sdk-go"], concern: "c" }],
    map
  );
  assert.deepEqual(out.notes, []);
});

test("normaliseParityNotes tolerates a slug spelled differently by the model", () => {
  // The probe map is keyed by our slugify(); the model echoes its own spelling.
  // A strict lookup here silently discarded every parity note.
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "absent"]])]]);
  for (const spelling of ["listPayouts", "List_Payouts", "LIST-PAYOUTS"]) {
    const out = normaliseParityNotes(
      [{ featureSlug: spelling, title: "t", searched: "s", missingIn: ["acme/sdk-go"], concern: "c" }],
      map
    );
    assert.equal(out.notes.length, 1, `slug "${spelling}" should still resolve`);
  }
});

test("normaliseParityNotes still refuses a slug that matches no probe at all", () => {
  const map = new Map([["list-payouts", probes([["acme/sdk-go", "absent"]])]]);
  const out = normaliseParityNotes(
    [{ featureSlug: "totally-unrelated", title: "t", searched: "s", missingIn: ["acme/sdk-go"], concern: "c" }],
    map
  );
  assert.deepEqual(out.notes, []);
});

test("normaliseParityNotes keeps only the repos the probes confirmed", () => {
  const map = new Map([["f", probes([["acme/a", "absent"], ["acme/b", "present"]])]]);
  const out = normaliseParityNotes(
    [{ featureSlug: "f", title: "t", searched: "s", missingIn: ["acme/a", "acme/b"], concern: "c" }],
    map
  );
  assert.deepEqual(out.features[0].missingIn, ["acme/a"]);
});

// ─── Offline sample path ────────────────────────────────────────────────────
// CROSS_REPO_SAMPLE=1 exercises both LLM branches without billing. These also
// prove the mock dispatches to the cross-repo branches rather than being
// hijacked by the much broader "PR review" matcher declared above them.

test("CROSS_REPO_SAMPLE=1 drives both stages end to end through the mock", async (t) => {
  const prior = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = prior;
  });
  const { assessCrossRepoImpact, extractContractDelta } = await import("./stage.js");

  const delta = await extractContractDelta({
    diff: diffFor("src/bounties.ts", "+export function createBounty() {}"),
    candidates: ["src/bounties.ts"],
  });
  assert.equal(delta.length, 2);
  assert.equal(delta[0].name, "createBounty");
  assert.equal(delta[0].compat, "breaking");

  const probeMap = new Map([
    ["list-payouts", [{ repoFullName: "acme/acme-sdk-go", status: "absent" as const, searched: "ListPayouts" }]],
  ]);
  const result = await assessCrossRepoImpact({
    delta,
    snippets: [
      {
        repoFullName: "acme/acme-web",
        path: "src/api/bounties.ts",
        sha: "s",
        line: 88,
        excerpt: "const b = await createBounty(title, amount);",
        matchedOn: "createBounty",
        lane: "index",
      },
    ],
    parityProbes: probeMap,
    familyMembers: ["acme/acme-sdk-go"],
    selfFullName: "acme/acme-sdk-ts",
  });

  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].severity, "warn");
  assert.match(result.impacts[0].path!, /^acme\/acme-web:/);
  assert.match(result.impacts[0].concern, /Consuming line:/);
  assert.equal(result.parityNotes.length, 1);
  assert.equal(result.parityNotes[0].severity, "nit");
  assert.equal(result.parityFeatures[0].slug, "list-payouts");
});

test("without the sample flag both stages return clean", async () => {
  const prior = process.env.CROSS_REPO_SAMPLE;
  delete process.env.CROSS_REPO_SAMPLE;
  try {
    const { assessCrossRepoImpact, extractContractDelta } = await import("./stage.js");
    assert.deepEqual(await extractContractDelta({ diff: "x", candidates: [] }), []);
    const r = await assessCrossRepoImpact({
      delta: [],
      snippets: [],
      parityProbes: new Map(),
      familyMembers: [],
      selfFullName: "acme/a",
    });
    assert.deepEqual(r.impacts, []);
    assert.deepEqual(r.parityNotes, []);
  } finally {
    if (prior !== undefined) process.env.CROSS_REPO_SAMPLE = prior;
  }
});
