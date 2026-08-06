// Unit tests for the triage reason catalogue. The invariants that matter are
// the ones separating a correction the agent can learn from ("the control is in
// middleware") from a dismissal it must not generalise ("not fixing this now").
// Run: node --experimental-strip-types --test src/security-triage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPT_OPTIONS,
  FALSE_POSITIVE_OPTIONS,
  NOTE_MAX,
  canPromoteToAccount,
  optionsFor,
  outcomeSummary,
  precedentById,
  reconfirmReason,
  requiresNote,
  sortPrecedents,
  suppressedByRulings,
  teaches,
  validateRuling,
} from "./security-triage.ts";
import type { SecurityFinding, SecurityPrecedent } from "./api.ts";

const precedent = (over: Partial<SecurityPrecedent> = {}): SecurityPrecedent => ({
  id: "p1",
  repoId: "r1",
  scope: "repo",
  code: "control_exists",
  action: "false_positive",
  note: "auth is in requireAuth",
  class: "missing-authz",
  path: "api/pay.ts",
  createdAt: 1000,
  createdBy: "octocat",
  status: "active",
  statusReason: null,
  suppressedCount: 0,
  lastAppliedAt: null,
  ...over,
});

const finding = (over: Partial<SecurityFinding> = {}) =>
  ({ id: "f1", lastSeenAt: 1000, ...over }) as SecurityFinding;

// --- catalogue -------------------------------------------------------------

test("every false-positive option is distinct from every accept option", () => {
  const fp = FALSE_POSITIVE_OPTIONS.map((o) => o.code);
  const ac = ACCEPT_OPTIONS.map((o) => o.code);
  assert.equal(new Set([...fp, ...ac]).size, fp.length + ac.length);
});

test("optionsFor routes each button to its own family", () => {
  assert.deepEqual(
    optionsFor("false_positive").map((o) => o.code),
    ["control_exists", "not_reachable", "misread_code", "out_of_scope", "duplicate"]
  );
  assert.deepEqual(
    optionsFor("accept").map((o) => o.code),
    ["by_design", "compensating_control", "accepted_cost"]
  );
});

test("dismissals that carry no lesson never teach", () => {
  // Scope facts, dedupe links, and business decisions must not become prompt
  // material — that is how a corpus turns into a mute button.
  for (const code of ["out_of_scope", "duplicate", "accepted_cost"] as const) {
    assert.equal(teaches(code), false, code);
    assert.equal(requiresNote(code), false, code);
    assert.equal(canPromoteToAccount(code), false, code);
  }
});

test("corrections and design decisions teach, and demand a rationale", () => {
  for (const code of ["control_exists", "not_reachable", "misread_code", "by_design", "compensating_control"] as const) {
    assert.equal(teaches(code), true, code);
    assert.equal(requiresNote(code), true, code);
  }
});

test("every option carries a description — the picker is the whole point", () => {
  for (const o of [...FALSE_POSITIVE_OPTIONS, ...ACCEPT_OPTIONS]) {
    assert.ok(o.label.length > 3 && o.description.length > 20, o.code);
  }
});

// --- validation ------------------------------------------------------------

test("validateRuling: no code picked is refused", () => {
  const v = validateRuling({ code: null, note: "anything", applyToAllRepos: false });
  assert.equal(v.ok, false);
});

test("validateRuling: a teachable code with no note is refused", () => {
  const v = validateRuling({ code: "control_exists", note: "   ", applyToAllRepos: false });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.error : "", /explanation/);
});

test("validateRuling: a non-teachable code needs no note", () => {
  const v = validateRuling({ code: "duplicate", note: "", applyToAllRepos: false });
  assert.ok(v.ok);
  assert.equal(v.body.reason, "");
  assert.equal(v.body.scope, "repo");
});

test("validateRuling: opting in promotes the scope", () => {
  const v = validateRuling({ code: "control_exists", note: "middleware", applyToAllRepos: true });
  assert.ok(v.ok);
  assert.equal(v.body.scope, "account");
});

test("validateRuling: a non-teachable code can't be promoted to the account", () => {
  // Nothing is learned from it, so a wider scope would be a lie in the UI.
  const v = validateRuling({ code: "accepted_cost", note: "later", applyToAllRepos: true });
  assert.ok(v.ok);
  assert.equal(v.body.scope, "repo");
});

test("validateRuling: the note is trimmed and clamped to the server's limit", () => {
  const v = validateRuling({ code: "misread_code", note: `  ${"x".repeat(800)}  `, applyToAllRepos: false });
  assert.ok(v.ok);
  assert.equal(v.body.reason.length, NOTE_MAX);
});

test("outcomeSummary: says plainly how far the suppression reaches", () => {
  assert.match(outcomeSummary({ code: "duplicate", note: "", applyToAllRepos: false }), /Nothing is added/);
  assert.match(
    outcomeSummary({ code: "control_exists", note: "n", applyToAllRepos: false }),
    /future scans of this repo/
  );
  const wide = outcomeSummary({ code: "control_exists", note: "n", applyToAllRepos: true });
  assert.match(wide, /every repo in this account/);
  // The promise that keeps a widened ruling honest.
  assert.match(wide, /won't auto-hide findings outside this repo/);
});

// --- ledger ----------------------------------------------------------------

test("suppressedByRulings: only auto-suppressed findings, newest first", () => {
  const rows = suppressedByRulings([
    finding({ id: "a", suppressedByPrecedentId: "p1", lastSeenAt: 10 }),
    finding({ id: "b" }),
    finding({ id: "c", suppressedByPrecedentId: "p2", lastSeenAt: 99 }),
  ]);
  assert.deepEqual(rows.map((f) => f.id), ["c", "a"]);
});

test("suppressedByRulings: a hand-marked false positive is not in the ledger", () => {
  // The ledger is for what the agent muted on its own — that is what needs
  // watching. A finding the user clicked through isn't a surprise to them.
  const rows = suppressedByRulings([finding({ id: "a", state: "false_positive" })]);
  assert.equal(rows.length, 0);
});

test("reconfirmReason: names why a ruling needs another look", () => {
  assert.equal(reconfirmReason(precedent()), null);
  assert.match(
    reconfirmReason(precedent({ status: "needs_reconfirm", statusReason: "code_changed" })) ?? "",
    /code .* has changed/
  );
  assert.match(
    reconfirmReason(precedent({ status: "needs_reconfirm", statusReason: "contradicted" })) ?? "",
    /later treated as real/
  );
});

test("sortPrecedents: rulings needing re-confirmation come first", () => {
  const list = [
    precedent({ id: "busy", suppressedCount: 9 }),
    precedent({ id: "stale", status: "needs_reconfirm", suppressedCount: 1 }),
    precedent({ id: "quiet", suppressedCount: 0 }),
  ];
  assert.deepEqual(sortPrecedents(list).map((p) => p.id), ["stale", "busy", "quiet"]);
});

test("precedentById: findings can resolve the ruling that muted them", () => {
  const map = precedentById([precedent({ id: "p1" }), precedent({ id: "p2" })]);
  assert.equal(map.get("p2")?.id, "p2");
  assert.equal(map.get("nope"), undefined);
});
