// Unit tests for the security policy defaults/normalization and the merge-gate
// matrix. No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/policy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGate,
  DEFAULT_SECURITY_POLICY,
  effectiveSecurityPolicy,
  normalizeSecurityPolicy,
} from "./policy.js";
import type { PRReview, Repository, SecurityFinding } from "../types.js";

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: "f1",
  fingerprint: "fp1",
  repoId: "r1",
  path: "api/pay.ts",
  class: "missing-authz",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "t",
  concern: "c",
  state: "open",
  firstDetectedAt: 0,
  lastSeenAt: 0,
  detectedSha: "s",
  model: "m",
  activity: [],
  ...over,
});

const review = (over: Partial<PRReview> = {}): PRReview =>
  ({
    id: "rv1",
    repoId: "r1",
    prNumber: 1,
    prTitle: "t",
    headSha: "h",
    baseSha: "b",
    status: "changes_requested",
    verdict: null,
    criteria: [],
    taskId: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as PRReview;

test("effectiveSecurityPolicy merges defaults under a partial stored policy", () => {
  const repo = { securityPolicy: { version: 1, triggers: { onMerge: false } } } as unknown as Repository;
  const p = effectiveSecurityPolicy(repo);
  assert.equal(p.triggers.onMerge, false);         // stored override wins
  assert.equal(p.triggers.onPrPush, true);         // default fills the gap
  assert.equal(p.gates.critical, "block");
  assert.deepEqual(effectiveSecurityPolicy(undefined), DEFAULT_SECURITY_POLICY);
});

test("normalizeSecurityPolicy drops junk and refuses a silent 'track' on critical", () => {
  const p = normalizeSecurityPolicy({
    triggers: { onMerge: "yes", nightly: true },
    engines: { api: false },
    gates: { critical: "track", high: "block", medium: "bogus" },
  });
  assert.equal(p.triggers.onMerge, true);   // non-boolean → default
  assert.equal(p.triggers.nightly, true);
  assert.equal(p.engines.api, false);
  assert.equal(p.gates.critical, "warn");   // track on critical clamped up
  assert.equal(p.gates.high, "block");
  assert.equal(p.gates.medium, "track");    // bogus → default
});

test("computeGate: an open critical fails the required rule and lists the finding id", () => {
  const gate = computeGate({
    findings: [finding()],
    openReviews: [],
    policy: DEFAULT_SECURITY_POLICY,
  });
  assert.equal(gate.verdict, "fail");
  assert.deepEqual(gate.blockingFindingIds, ["f1"]);
  const r1 = gate.rules.find((r) => r.id === "no-open-critical");
  assert.ok(r1 && !r1.pass && r1.required && r1.count === 1);
});

test("computeGate: fix_ready still blocks (the default branch is still vulnerable)", () => {
  const gate = computeGate({
    findings: [finding({ state: "fix_ready" })],
    openReviews: [],
    policy: DEFAULT_SECURITY_POLICY,
  });
  assert.equal(gate.verdict, "fail");
});

test("computeGate: snoozed, resolved, accepted, false_positive and unverified findings never gate", () => {
  for (const state of ["snoozed", "resolved", "accepted", "false_positive", "unverified"] as const) {
    const gate = computeGate({
      findings: [finding({ state })],
      openReviews: [],
      policy: DEFAULT_SECURITY_POLICY,
    });
    assert.equal(gate.verdict, "pass", state);
  }
});

test("computeGate: high findings warn by default but block when the policy says so", () => {
  const high = finding({ severity: "high" });
  const dflt = computeGate({ findings: [high], openReviews: [], policy: DEFAULT_SECURITY_POLICY });
  assert.equal(dflt.verdict, "pass");
  const warnRule = dflt.rules.find((r) => r.id === "warn-high");
  assert.ok(warnRule && !warnRule.pass && !warnRule.required);

  const strict = {
    ...DEFAULT_SECURITY_POLICY,
    gates: { ...DEFAULT_SECURITY_POLICY.gates, high: "block" as const },
  };
  const blocked = computeGate({ findings: [high], openReviews: [], policy: strict });
  assert.equal(blocked.verdict, "fail");
});

test("computeGate: an open PR introducing a critical fails R2 from the review snapshot", () => {
  const gate = computeGate({
    findings: [],
    openReviews: [review({ securityFindings: [{ concern: "c", severity: "critical" }] })],
    policy: DEFAULT_SECURITY_POLICY,
  });
  assert.equal(gate.verdict, "fail");
  const r2 = gate.rules.find((r) => r.id === "no-introduced-blocking");
  assert.ok(r2 && !r2.pass && r2.count === 1);
});

test("computeGate: a PR introducing only a medium passes R2 under the default policy", () => {
  const gate = computeGate({
    findings: [],
    openReviews: [review({ securityFindings: [{ concern: "c", severity: "medium" }] })],
    policy: DEFAULT_SECURITY_POLICY,
  });
  assert.equal(gate.verdict, "pass");
});

const PROVEN = { status: "verified" as const, method: "test" as const, blobSha: "s", engine: "proof-v1", updatedAt: 1 };

test("proof gate: an unproven critical never gates, a proven one fails R1", () => {
  const off = computeGate({ findings: [finding()], openReviews: [], policy: DEFAULT_SECURITY_POLICY, proofGate: true });
  assert.equal(off.verdict, "pass");
  const on = computeGate({
    findings: [finding({ proof: PROVEN })],
    openReviews: [],
    policy: DEFAULT_SECURITY_POLICY,
    proofGate: true,
  });
  assert.equal(on.verdict, "fail");
  assert.deepEqual(on.blockingFindingIds, ["f1"]);
});

test("proof gate: a stale proof, or an untested issue/bounty row, never gates", () => {
  for (const f of [
    finding({ proof: { ...PROVEN, blobSha: "older" } }),
    finding({ state: "issue_created", issueNumber: 3 }),
    finding({ state: "bounty", issueNumber: 3, bountyId: "b" }),
  ]) {
    const gate = computeGate({ findings: [f], openReviews: [], policy: DEFAULT_SECURITY_POLICY, proofGate: true });
    assert.equal(gate.verdict, "pass", f.state);
  }
});

test("proof gate: a proven row the LLM verifier held back still gates", () => {
  const gate = computeGate({
    findings: [finding({ state: "unverified", proof: PROVEN })],
    openReviews: [],
    policy: DEFAULT_SECURITY_POLICY,
    proofGate: true,
  });
  assert.equal(gate.verdict, "fail");
});

test("proof gate: PR-introduced criticals only warn, and untested findings are counted as awaiting", () => {
  const gate = computeGate({
    findings: [finding(), finding({ id: "f2", severity: "high" })],
    openReviews: [review({ securityFindings: [{ concern: "c", severity: "critical" }] })],
    policy: DEFAULT_SECURITY_POLICY,
    proofGate: true,
  });
  assert.equal(gate.verdict, "pass");
  const r2 = gate.rules.find((r) => r.id === "no-introduced-blocking");
  assert.ok(r2 && !r2.pass && !r2.required);
  const awaiting = gate.rules.find((r) => r.id === "awaiting-proof");
  assert.ok(awaiting && awaiting.count === 2 && !awaiting.required);
  const warnHigh = gate.rules.find((r) => r.id === "warn-high");
  assert.ok(warnHigh && warnHigh.pass && warnHigh.count === 0);
});

test("proof gate off: the gate is exactly what it was", () => {
  const args = { findings: [finding()], openReviews: [], policy: DEFAULT_SECURITY_POLICY };
  assert.deepEqual(computeGate({ ...args, proofGate: false }), computeGate(args));
  assert.equal(computeGate(args).rules.some((r) => r.id === "awaiting-proof"), false);
});

test("public-repo opt-in defaults off, coerces junk, and survives a client that omits it", () => {
  assert.deepEqual(DEFAULT_SECURITY_POLICY.proof, { publicOptIn: false });
  assert.deepEqual(effectiveSecurityPolicy({ securityPolicy: { version: 1 } } as unknown as Repository).proof, {
    publicOptIn: false,
  });
  const prev = { ...DEFAULT_SECURITY_POLICY, proof: { publicOptIn: true, publicOptInBy: "ada", publicOptInAt: 9 } };
  assert.deepEqual(normalizeSecurityPolicy({ triggers: {} }, prev).proof, prev.proof);
  assert.deepEqual(normalizeSecurityPolicy({ proof: { publicOptIn: "yes" } }, prev).proof, prev.proof);
  assert.equal(normalizeSecurityPolicy({ proof: { publicOptIn: false } }, prev).proof.publicOptIn, false);
  assert.equal(normalizeSecurityPolicy({ proof: { publicOptIn: true } }).proof.publicOptIn, true);
});
