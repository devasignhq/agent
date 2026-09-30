// Unit tests for the proof-gate presentation rules. Run:
//   node --test src/security-proof.test.ts   (frontend npm test globs these)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  needsUntestedBadge,
  partitionFindings,
  proofGateOn,
  proofTag,
  readinessBanners,
  untestedSummary,
} from "./security-proof.ts";
import type { FindingPresentation, SecurityFinding, SecurityProof, SecurityRepoView } from "./api";

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding =>
  ({
    id: "f1",
    fingerprint: "fp",
    repoId: "r1",
    path: "api/pay.ts",
    class: "missing-authz",
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
    bounty: null,
    ...over,
  }) as SecurityFinding;

const withPresentation = (id: string, presentation: FindingPresentation, over: Partial<SecurityFinding> = {}) =>
  finding({ id, presentation, ...over });

const repo = (over: Partial<SecurityRepoView> = {}): SecurityRepoView =>
  ({
    id: "r1",
    owner: "octocat",
    name: "widgets",
    defaultBranch: "main",
    indexState: "ready",
    indexedAt: 1,
    policy: {} as any,
    gate: { verdict: "pass", rules: [], blockingFindingIds: [] },
    latestScan: null,
    ...over,
  }) as SecurityRepoView;

const proof = (over: Partial<SecurityProof> = {}): SecurityProof => ({
  status: "verified",
  method: "test",
  engine: "proof-v1",
  updatedAt: 1,
  ...over,
});

test("proofGateOn is true as soon as one repo reports the gate", () => {
  assert.equal(proofGateOn([repo(), repo({ id: "r2" })]), false);
  assert.equal(proofGateOn([repo(), repo({ id: "r2", proofGate: true })]), true);
});

test("with the gate off the partition reproduces the legacy split", () => {
  const rows = [
    finding({ id: "open", state: "open" }),
    finding({ id: "held", state: "unverified" }),
    finding({ id: "resolved", state: "resolved" }),
    finding({ id: "muted", state: "false_positive", suppressedByPrecedentId: "p1" }),
  ];
  const p = partitionFindings(rows, false);
  // Unchanged: every finding still reaches the chips, search and table.
  assert.deepEqual(p.pool.map((f) => f.id), ["open", "held", "resolved", "muted"]);
  assert.deepEqual(p.untested.map((f) => f.id), ["held"]);
  assert.deepEqual(p.suppressed.map((f) => f.id), ["muted"]);
});

test("with the gate on only proven and human-touched rows stay in the list", () => {
  const rows = [
    withPresentation("proven", "main"),
    withPresentation("kept", "kept"),
    withPresentation("untested", "untested", { lastSeenAt: 10 }),
    withPresentation("also-untested", "untested", { lastSeenAt: 20 }),
    withPresentation("gone", "resolved"),
    withPresentation("dismissed", "suppressed"),
  ];
  const p = partitionFindings(rows, true);
  // Untested rows leave; resolved and dismissed rows keep their chips.
  assert.deepEqual(p.pool.map((f) => f.id), ["proven", "kept", "gone", "dismissed"]);
  // newest first
  assert.deepEqual(p.untested.map((f) => f.id), ["also-untested", "untested"]);
  assert.deepEqual(p.suppressed, []);
});

test("a ruling-muted row stays in its own ledger even under the gate", () => {
  const rows = [withPresentation("muted", "suppressed", { suppressedByPrecedentId: "p1" })];
  const p = partitionFindings(rows, true);
  assert.deepEqual(p.suppressed.map((f) => f.id), ["muted"]);
  assert.deepEqual(p.pool.map((f) => f.id), ["muted"]);
  assert.deepEqual(p.untested, []);
});

test("only a kept row is badged untested", () => {
  assert.equal(needsUntestedBadge(withPresentation("a", "kept")), true);
  assert.equal(needsUntestedBadge(withPresentation("b", "main")), false);
  assert.equal(needsUntestedBadge(withPresentation("c", "untested")), false);
  assert.equal(needsUntestedBadge(finding()), false);
});

test("proofTag names the proof in plain language", () => {
  assert.deepEqual(proofTag(proof()), { label: "verified by test", detail: null, tone: "ok" });
  assert.equal(proofTag(proof({ method: "rule" })).label, "verified by rule");
  assert.equal(proofTag(proof({ status: "testing" })).label, "testing…");
  assert.deepEqual(proofTag(proof({ status: "not_reproduced" })), {
    label: "not reproduced",
    detail: "the attack was blocked when tested",
    tone: "plain",
  });
  assert.deepEqual(proofTag(proof({ status: "untested", reason: "stale" })), {
    label: "untested",
    detail: "the code changed since the test ran",
    tone: "plain",
  });
  assert.equal(proofTag(proof({ status: "inconclusive", reason: "control_failed" })).detail, "the test itself did not work");
  assert.equal(proofTag(proof({ status: "untestable", reason: "not_reachable" })).detail, "not reachable from the running app");
  assert.deepEqual(proofTag(undefined), {
    label: "untested",
    detail: "no test has been written yet",
    tone: "plain",
  });
});

test("an unknown hold reason still produces a sentence, never 'undefined'", () => {
  const tag = proofTag(proof({ status: "inconclusive", reason: "something-new" as any }));
  assert.equal(tag.label, "untested");
  assert.equal(tag.detail, "the test was inconclusive");
});

test("readiness banners only fire for gated repos with findings actually waiting", () => {
  const repos = [
    repo({ id: "needs", proofGate: true, proofReadiness: "needs_setup" }),
    repo({ id: "public", proofGate: true, private: false, proofReadiness: "needs_opt_in" }),
    repo({ id: "ready", proofGate: true, proofReadiness: "ready" }),
    repo({ id: "ungated", proofReadiness: "needs_setup" }),
  ];
  const findings = [
    withPresentation("a", "untested", { repoId: "needs" }),
    withPresentation("b", "untested", { repoId: "needs" }),
    withPresentation("c", "kept", { repoId: "public" }),
    withPresentation("d", "main", { repoId: "ready" }),
    withPresentation("e", "untested", { repoId: "ungated" }),
  ];
  const banners = readinessBanners(repos, findings);
  assert.deepEqual(banners.map((b) => b.repoId), ["needs", "public"]);
  assert.match(banners[0].message, /2 findings in octocat\/widgets are waiting for a test/);
  assert.equal(banners[0].href, "/workflow?repo=needs&setup=browser");
  assert.match(banners[1].message, /because it is public/);
  assert.equal(banners[1].href, null);
});

test("a single waiting finding reads in the singular", () => {
  const banners = readinessBanners(
    [repo({ id: "r1", proofGate: true, proofReadiness: "needs_setup" })],
    [withPresentation("a", "untested", { repoId: "r1" })]
  );
  assert.match(banners[0].message, /1 finding in octocat\/widgets is waiting for a test/);
});

test("the untested ledger summarises by reason, commonest first", () => {
  const rows = [
    withPresentation("a", "untested", { proof: proof({ status: "untested", reason: "no_test_written" }) }),
    withPresentation("b", "untested", { proof: proof({ status: "untested", reason: "no_test_written" }) }),
    withPresentation("c", "untested", { proof: proof({ status: "not_reproduced" }) }),
  ];
  const summary = untestedSummary(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.byLabel[0].count, 2);
  assert.match(summary.byLabel[0].label, /no test has been written yet/);
  assert.equal(summary.byLabel[1].count, 1);
});

test("the Proof export column is empty without proof data and populated with it", async () => {
  const { proofText } = await import("./security-export.ts");
  assert.equal(proofText(finding()), "");
  const proven = finding({
    proof: proof({ testedSha: "0123456789abcdef", testPath: ".devasign/tests/pay.proof.test.ts" }),
  });
  assert.equal(
    proofText(proven),
    "verified by test\ntested at 0123456789ab\ntest: .devasign/tests/pay.proof.test.ts"
  );
  assert.match(proofText(finding({ proof: proof({ status: "untested", reason: "stale" }) })), /code changed/);
});

test("readiness banners respect the repo filter", () => {
  const repos = [
    repo({ id: "a", proofGate: true, proofReadiness: "needs_setup" }),
    repo({ id: "b", proofGate: true, proofReadiness: "needs_setup" }),
  ];
  const findings = [
    withPresentation("f1", "untested", { repoId: "a" }),
    withPresentation("f2", "untested", { repoId: "b" }),
  ];
  assert.deepEqual(readinessBanners(repos, findings, "all").map((x) => x.repoId), ["a", "b"]);
  assert.deepEqual(readinessBanners(repos, findings, "b").map((x) => x.repoId), ["b"]);
});
