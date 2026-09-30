// Unit tests for the proof gate: mode resolution, per-repo readiness, and the
// finding view the API serves. In-memory db, no network. Run:
//   DATABASE_URL= STATSIG_SECRET_KEY= node --import tsx/esm --test src/security/proof-gate.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { findingView, proofGateFor, proofMode, proofReadiness } from "./proof-gate.js";
import { DEFAULT_SECURITY_POLICY } from "./policy.js";
import type { Repository, SecurityFinding } from "../types.js";

const ORIGINAL = process.env.SECURITY_PROOF_MODE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SECURITY_PROOF_MODE;
  else process.env.SECURITY_PROOF_MODE = ORIGINAL;
});

const repo = (over: Partial<Repository> = {}): Repository =>
  ({
    id: uuid(),
    installationId: "no-such-install",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
    private: true,
    verify: { onboarding: { state: "verified" } },
    ...over,
  }) as Repository;

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
  detectedSha: "blob2",
  model: "m",
  activity: [],
  ...over,
});

test("proofMode: only on and statsig switch it, anything else is off", () => {
  delete process.env.SECURITY_PROOF_MODE;
  assert.equal(proofMode(), "off");
  process.env.SECURITY_PROOF_MODE = "on";
  assert.equal(proofMode(), "on");
  process.env.SECURITY_PROOF_MODE = " STATSIG ";
  assert.equal(proofMode(), "statsig");
  process.env.SECURITY_PROOF_MODE = "yes";
  assert.equal(proofMode(), "off");
});

test("proofGateFor: env on and off are absolute", () => {
  process.env.SECURITY_PROOF_MODE = "on";
  assert.equal(proofGateFor(repo()), true);
  process.env.SECURITY_PROOF_MODE = "off";
  assert.equal(proofGateFor(repo()), false);
});

test("proofGateFor: statsig mode fails closed without an install or a configured Statsig", () => {
  process.env.SECURITY_PROOF_MODE = "statsig";
  assert.equal(proofGateFor(repo()), false);
  const userId = uuid();
  const install = db.insert("installations", { id: uuid(), installationId: 77, userId } as any);
  assert.equal(proofGateFor(repo({ installationId: install.id })), false);
});

test("proofReadiness: tests need a verified CI setup, and public repos need an opt-in", () => {
  assert.equal(proofReadiness(repo({ verify: undefined })), "needs_setup");
  assert.equal(proofReadiness(repo({ verify: { onboarding: { state: "pr_merged" } } } as any)), "needs_setup");
  assert.equal(proofReadiness(repo({ workflow: { stages: { verify: false } } } as any)), "needs_setup");
  assert.equal(proofReadiness(repo()), "ready");
  assert.equal(proofReadiness(repo({ private: false })), "needs_opt_in");
  assert.equal(
    proofReadiness(
      repo({ private: false, securityPolicy: { ...DEFAULT_SECURITY_POLICY, proof: { publicOptIn: true } } })
    ),
    "ready"
  );
});

test("findingView: off hands back the stored row untouched", () => {
  const f = finding();
  assert.equal(findingView(f, false), f);
});

test("findingView: on adds the presentation and serves the effective proof", () => {
  const f = finding({
    proof: { status: "verified", method: "test", blobSha: "blob1", engine: "proof-v1", updatedAt: 1 },
  });
  const v = findingView(f, true);
  assert.equal(v.presentation, "untested");
  assert.equal(v.proof?.status, "untested");
  assert.equal(v.proof?.reason, "stale");
  assert.equal(f.proof?.status, "verified");
});
