// Unit tests for reconcileFile — the pure core that decides, per scanned file,
// which model findings are new rows, which update existing rows in place
// (keeping triage state), and which stored findings get auto-resolved. No db /
// network / LLM. Run:
//   node --import tsx/esm --test src/security/reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFile, type ReconcileCtx } from "./reconcile.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { AgentFinding } from "./agent.js";
import type { SecurityFinding, SecurityFindingState } from "../types.js";

const ctx = (over: Partial<ReconcileCtx> = {}): ReconcileCtx => ({
  repoId: "r1",
  path: "api/pay.ts",
  sha: "sha2",
  now: 1_000_000,
  model: "m2",
  origin: { pr: 487, sha: "8c1a2f", author: "dmitri" },
  ...over,
});

const detected = (over: Partial<AgentFinding> = {}): AgentFinding => ({
  slug: "payout-missing-auth",
  class: "missing-authz",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "Payout route reachable without authentication",
  concern: "no auth middleware in the chain",
  exploitNarrative: ["a", "b", "c"],
  ...over,
});

const stored = (over: Partial<SecurityFinding> = {}): SecurityFinding => {
  const base: SecurityFinding = {
    id: "f1",
    fingerprint: fingerprintFinding({
      repoId: "r1",
      path: "api/pay.ts",
      class: "missing-authz",
      slug: "payout-missing-auth",
    }),
    repoId: "r1",
    path: "api/pay.ts",
    class: "missing-authz",
    surface: "api",
    severity: "critical",
    confidence: "confirmed",
    title: "Payout route reachable without authentication",
    concern: "no auth middleware in the chain",
    state: "open",
    firstDetectedAt: 500_000,
    lastSeenAt: 500_000,
    detectedSha: "sha1",
    model: "m1",
    activity: [],
  };
  return { ...base, ...over };
};

test("a brand-new fingerprint inserts a state 'new' row with origin attribution", () => {
  const out = reconcileFile({ existing: [], detected: [detected()], ctx: ctx() });
  assert.equal(out.insert.length, 1);
  assert.equal(out.update.length, 0);
  assert.equal(out.introduced, 1);
  const row = out.insert[0];
  assert.equal(row.state, "new");
  assert.equal(row.introducedByPr, 487);
  assert.equal(row.introducedByAuthor, "dmitri");
  assert.equal(row.activity.length, 1);
  assert.equal(row.activity[0].kind, "detected");
});

test("a re-detection patches the existing row in place and keeps triage state", () => {
  const existing = stored({ state: "issue_created", issueNumber: 12, assigneeLogin: "maya" });
  const out = reconcileFile({ existing: [existing], detected: [detected({ line: 99 })], ctx: ctx() });
  assert.equal(out.insert.length, 0);
  assert.equal(out.update.length, 1);
  const patch = out.update[0].patch;
  assert.equal(patch.line, 99);
  assert.equal(patch.lastSeenAt, 1_000_000);
  // Triage fields must NOT be touched by the patch.
  assert.ok(!("state" in patch));
  assert.ok(!("issueNumber" in patch));
  assert.ok(!("assigneeLogin" in patch));
});

test("a severity re-assessment updates severity and logs a redetected event", () => {
  const out = reconcileFile({
    existing: [stored({ severity: "high" })],
    detected: [detected({ severity: "critical" })],
    ctx: ctx(),
  });
  const patch = out.update[0].patch;
  assert.equal(patch.severity, "critical");
  assert.equal(patch.activity?.at(-1)?.kind, "redetected");
});

test("a resolved finding that reappears reopens to 'open'", () => {
  const out = reconcileFile({
    existing: [stored({ state: "resolved", resolvedAt: 900_000 })],
    detected: [detected()],
    ctx: ctx(),
  });
  const patch = out.update[0].patch;
  assert.equal(patch.state, "open");
  assert.equal(patch.resolvedAt, null);
  assert.equal(patch.activity?.at(-1)?.kind, "reopened");
});

for (const state of ["accepted", "false_positive"] as SecurityFindingState[]) {
  test(`a suppressed (${state}) finding is refreshed but never resurfaced`, () => {
    const out = reconcileFile({
      existing: [stored({ state })],
      detected: [detected()],
      ctx: ctx(),
    });
    const patch = out.update[0].patch;
    assert.ok(!("state" in patch), "state must stay suppressed");
    assert.equal(patch.lastSeenAt, 1_000_000);
  });
}

test("an active finding NOT re-detected in its scanned file resolves", () => {
  const out = reconcileFile({ existing: [stored()], detected: [], ctx: ctx() });
  assert.equal(out.resolved, 1);
  const patch = out.update[0].patch;
  assert.equal(patch.state, "resolved");
  assert.equal(patch.activity?.at(-1)?.kind, "resolved");
});

test("a suppressed finding not re-detected is left alone (no resolve churn)", () => {
  const out = reconcileFile({
    existing: [stored({ state: "false_positive" })],
    detected: [],
    ctx: ctx(),
  });
  assert.equal(out.update.length, 0);
  assert.equal(out.resolved, 0);
});

test("two model findings collapsing to one fingerprint insert once", () => {
  const out = reconcileFile({
    existing: [],
    detected: [detected(), detected({ title: "worded differently", concern: "same thing" })],
    ctx: ctx(),
  });
  assert.equal(out.insert.length, 1);
});
