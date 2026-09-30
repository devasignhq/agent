// Unit tests for the proof rule: when test outcomes count as a verified finding,
// when a proof goes stale, and where a finding is presented under the gate. Run:
//   node --import tsx/esm --test src/security/proof.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAttempts,
  effectiveProof,
  isProven,
  judgeProof,
  presentationOf,
  untestedProof,
} from "./proof.js";
import type { SecurityFinding, SecurityProof } from "../types.js";

const proof = (over: Partial<SecurityProof> = {}): SecurityProof => ({
  status: "verified",
  method: "test",
  blobSha: "blob1",
  testedSha: "c0ffee",
  engine: "proof-v1",
  updatedAt: 1,
  ...over,
});

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
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
  ...over,
});

test("aggregateAttempts: errors and empties poison, mixes are flaky", () => {
  assert.equal(aggregateAttempts([]), "error");
  assert.equal(aggregateAttempts(["fail", "error"]), "error");
  assert.equal(aggregateAttempts(["pass", "pass"]), "pass");
  assert.equal(aggregateAttempts(["fail", "fail", "fail"]), "fail");
  assert.equal(aggregateAttempts(["fail", "pass"]), "flaky");
});

test("verified only when the control passes and the probe fails on every attempt", () => {
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["fail", "fail", "fail"] }), { status: "verified" });
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["fail", "fail"] }), { status: "verified" });
});

test("one failing probe attempt is not enough to verify", () => {
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["fail"] }), {
    status: "inconclusive",
    reason: "single_attempt",
  });
});

test("a failing control makes the result inconclusive, whatever the probe did", () => {
  assert.deepEqual(judgeProof({ control: ["fail"], probe: ["fail", "fail"] }), {
    status: "inconclusive",
    reason: "control_failed",
  });
  assert.deepEqual(judgeProof({ control: ["error"], probe: ["fail", "fail"] }), {
    status: "inconclusive",
    reason: "test_errored",
  });
  assert.deepEqual(judgeProof({ control: ["fail", "pass"], probe: ["fail", "fail"] }), {
    status: "inconclusive",
    reason: "flaky",
  });
});

test("a crashing or unstable probe is inconclusive, never verified", () => {
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["fail", "error"] }), {
    status: "inconclusive",
    reason: "test_errored",
  });
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["fail", "pass"] }), {
    status: "inconclusive",
    reason: "flaky",
  });
  assert.deepEqual(judgeProof({ control: ["pass"], probe: [] }), { status: "inconclusive", reason: "test_errored" });
});

test("both halves passing means the protection held", () => {
  assert.deepEqual(judgeProof({ control: ["pass"], probe: ["pass"] }), { status: "not_reproduced" });
});

test("a finding with no proof is untested", () => {
  const p = effectiveProof(finding());
  assert.equal(p.status, "untested");
  assert.equal(isProven(finding()), false);
});

test("a proof goes stale once the file blob moves", () => {
  const f = finding({
    proof: proof({ detail: "403 expected, got 200", attempts: { control: 1, probe: 3 } }),
    detectedSha: "blob2",
  });
  const p = effectiveProof(f);
  assert.equal(p.status, "untested");
  assert.equal(p.reason, "stale");
  assert.equal(p.testedSha, "c0ffee");
  assert.equal(p.detail, undefined);
  assert.equal(isProven(f), false);
});

test("a proof on the current blob stands, including a rule-verified one", () => {
  assert.equal(isProven(finding({ proof: proof() })), true);
  assert.equal(isProven(finding({ proof: proof({ method: "rule" }) })), true);
  assert.equal(isProven(finding({ proof: proof({ status: "not_reproduced" }) })), false);
});

test("untestedProof carries an optional reason", () => {
  assert.deepEqual(untestedProof(5), { status: "untested", method: "test", engine: "proof-v1", updatedAt: 5 });
  assert.equal(untestedProof(5, "not_reachable").reason, "not_reachable");
});

test("presentation: proven rows are main, human-touched rows are kept, the rest untested", () => {
  assert.equal(presentationOf(finding({ proof: proof() })), "main");
  assert.equal(presentationOf(finding({ state: "unverified", proof: proof() })), "main");
  assert.equal(presentationOf(finding({ state: "issue_created", issueNumber: 7 })), "kept");
  assert.equal(presentationOf(finding({ state: "bounty", issueNumber: 7, bountyId: "b1" })), "kept");
  assert.equal(presentationOf(finding()), "untested");
  assert.equal(presentationOf(finding({ state: "unverified" })), "untested");
  assert.equal(presentationOf(finding({ state: "fix_ready" })), "untested");
  assert.equal(presentationOf(finding({ state: "new", proof: proof({ blobSha: "old" }) })), "untested");
});

test("presentation: suppressed and resolved rows keep their own sections", () => {
  assert.equal(presentationOf(finding({ state: "accepted" })), "suppressed");
  assert.equal(presentationOf(finding({ state: "false_positive", proof: proof() })), "suppressed");
  assert.equal(presentationOf(finding({ state: "resolved", proof: proof() })), "resolved");
});
