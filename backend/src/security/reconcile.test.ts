// Unit tests for reconcileFile — the pure core that decides, per scanned file,
// which model findings are new rows, which update existing rows in place
// (keeping triage state), and which stored findings get auto-resolved. No db /
// network / LLM. Run:
//   node --import tsx/esm --test src/security/reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFile, type DetectedFinding, type ReconcileCtx } from "./reconcile.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { SecurityFinding, SecurityFindingState, SecurityVerification } from "../types.js";

const ctx = (over: Partial<ReconcileCtx> = {}): ReconcileCtx => ({
  repoId: "r1",
  path: "api/pay.ts",
  sha: "sha2",
  now: 1_000_000,
  model: "m2",
  origin: { pr: 487, sha: "8c1a2f", author: "dmitri" },
  ...over,
});

const CONFIRMED: SecurityVerification = {
  status: "confirmed",
  evidence: [{ path: "api/pay.ts", line: 3, quote: "router.post('/payout', payoutHandler)" }],
  verifiedAt: 1_999_000,
  model: "m2",
  engine: "verify-v1",
};
const REFUTED: SecurityVerification = {
  status: "refuted",
  reason: "refuted",
  detail: "requireAuth is applied where the router is mounted",
  evidence: [],
  refutingControl: { path: "api/app.ts", line: 40, quote: "app.use('/api', requireAuth, router)" },
  verifiedAt: 1_999_000,
  model: "m2",
  engine: "verify-v1",
};

const detected = (over: Partial<DetectedFinding> = {}): DetectedFinding => ({
  slug: "payout-missing-auth",
  class: "missing-authz",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "Payout route reachable without authentication",
  concern: "no auth middleware in the chain",
  exploitNarrative: ["a", "b", "c"],
  verification: CONFIRMED,
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
  assert.equal(row.activity.length, 2);
  assert.equal(row.activity[0].kind, "detected");
  assert.equal(row.activity[1].kind, "verified");
  assert.equal(row.verification?.status, "confirmed");
});

test("a new fingerprint the verifier did not confirm is born 'unverified' and counts as held back", () => {
  const out = reconcileFile({ existing: [], detected: [detected({ verification: REFUTED })], ctx: ctx() });
  assert.equal(out.insert.length, 1);
  assert.equal(out.introduced, 0);
  assert.equal(out.heldBack, 1);
  const row = out.insert[0];
  assert.equal(row.state, "unverified");
  assert.match(row.stateReason ?? "", /refuted — api\/app\.ts:40/);
  assert.equal(row.verification?.refutingControl?.path, "api/app.ts");
});

test("an unverified row the verifier later confirms surfaces as 'new'", () => {
  const existing = stored({ state: "unverified", stateReason: "refuted — x" });
  const out = reconcileFile({ existing: [existing], detected: [detected()], ctx: ctx() });
  assert.equal(out.insert.length, 0);
  assert.equal(out.introduced, 1);
  const patch = out.update[0].patch;
  assert.equal(patch.state, "new");
  assert.equal(patch.stateReason, null);
  assert.equal(patch.activity?.at(-1)?.kind, "verified");
});

test("an open row the verifier refutes is demoted to 'unverified' — not resolved", () => {
  const existing = stored({ state: "open" });
  const out = reconcileFile({ existing: [existing], detected: [detected({ verification: REFUTED })], ctx: ctx() });
  assert.equal(out.demoted, 1);
  assert.equal(out.heldBack, 1);
  assert.equal(out.resolved, 0);
  const patch = out.update[0].patch;
  assert.equal(patch.state, "unverified");
  assert.match(patch.stateReason ?? "", /^refuted/);
});

test("a row with an issue or bounty keeps its state on a held-back verdict, with the disagreement logged", () => {
  for (const over of [{ state: "issue_created" as const, issueNumber: 12 }, { state: "bounty" as const, bountyId: "b1" }]) {
    const out = reconcileFile({ existing: [stored(over)], detected: [detected({ verification: REFUTED })], ctx: ctx() });
    assert.equal(out.demoted, 0, over.state);
    const patch = out.update[0].patch;
    assert.equal(patch.state, undefined, over.state);
    assert.equal(patch.activity?.at(-1)?.kind, "verified");
    assert.match(patch.activity?.at(-1)?.detail ?? "", /^Held back/);
  }
});

test("a resolved row is not reopened by a held-back re-detection", () => {
  const out = reconcileFile({ existing: [stored({ state: "resolved" })], detected: [detected({ verification: REFUTED })], ctx: ctx() });
  assert.equal(out.update[0].patch.state, undefined);
  assert.equal(out.heldBack, 0);
});

test("an unverified row that is no longer detected is removed, not resolved", () => {
  const out = reconcileFile({ existing: [stored({ state: "unverified" })], detected: [], ctx: ctx() });
  assert.deepEqual(out.remove, ["f1"]);
  assert.equal(out.update.length, 0);
  assert.equal(out.resolved, 0);
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

// --- precedent-driven auto-suppression -------------------------------------

const muted = { precedentId: "p1", action: "false_positive" as const, note: "auth is in requireAuth" };

test("a detection annotated by a maintainer ruling is born suppressed, not active", () => {
  const out = reconcileFile({ existing: [], detected: [{ ...detected(), suppressedBy: muted }], ctx: ctx() });
  assert.equal(out.insert.length, 1);
  const row = out.insert[0];
  assert.equal(row.state, "false_positive");
  assert.equal(row.suppressedByPrecedentId, "p1");
  assert.equal(row.stateReason, "auth is in requireAuth");
  // It must not count as introduced — the dashboard's "new findings" number
  // would otherwise report work the maintainer already adjudicated.
  assert.equal(out.introduced, 0);
  assert.deepEqual(out.appliedPrecedentIds, ["p1"]);
  // The suppression has to be legible in the row's own history.
  assert.ok(row.activity.some((e) => /Auto-suppressed by your earlier ruling/.test(e.detail)));
});

test("an accepted-risk ruling suppresses as accepted, not as a false positive", () => {
  const out = reconcileFile({
    existing: [],
    detected: [{ ...detected(), suppressedBy: { ...muted, action: "accepted" } }],
    ctx: ctx(),
  });
  assert.equal(out.insert[0].state, "accepted");
});

test("a ruling never overrides the triage state a finding already earned", () => {
  // The row exists and a human filed an issue from it. A precedent matching the
  // same class must not quietly mute a finding that is already being worked.
  const out = reconcileFile({
    existing: [stored({ state: "issue_created", issueNumber: 12 })],
    detected: [{ ...detected(), suppressedBy: muted }],
    ctx: ctx(),
  });
  assert.equal(out.insert.length, 0);
  assert.equal(out.appliedPrecedentIds.length, 0);
  assert.ok(!("state" in out.update[0].patch), "existing triage state must survive");
});

test("an unannotated detection is unaffected by the suppression path", () => {
  const out = reconcileFile({ existing: [], detected: [detected()], ctx: ctx() });
  assert.equal(out.insert[0].state, "new");
  assert.equal(out.insert[0].suppressedByPrecedentId, undefined);
  assert.equal(out.introduced, 1);
  assert.deepEqual(out.appliedPrecedentIds, []);
});
