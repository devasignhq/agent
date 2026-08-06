// Unit tests for the learned-precedent corpus. The invariants under test are
// the ones that keep a learning loop from turning into a mute button: only
// teachable, reasoned rulings become precedent; auto-suppression stays narrow
// (never class-alone, never cross-repo); and a ruling stops muting once the
// code it was made against moves. No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/precedent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecurityPrecedent, SecurityRulingCode } from "../types.js";
import {
  MAX_INJECTED,
  MAX_INJECTED_CHARS,
  actionForCode,
  anchorHolds,
  isTeachable,
  matchPrecedent,
  precedentFromRuling,
  renderPrecedentBlock,
  selectPrecedents,
} from "./precedent.js";

function finding(over: Partial<Parameters<typeof precedentFromRuling>[0]["finding"]> = {}) {
  return {
    id: "f1",
    class: "missing-authz",
    path: "backend/src/routes/pay.ts",
    symbol: "createPayout",
    evidence: "42: router.post('/payout', createPayout)",
    detectedSha: "sha-a",
    title: "payout route missing auth",
    ...over,
  };
}

function ruling(over: Partial<Parameters<typeof precedentFromRuling>[0]> = {}) {
  return {
    code: "control_exists" as SecurityRulingCode,
    note: "auth is applied by requireAuth in server.ts before this router mounts",
    scope: "repo" as const,
    ownerUserId: "u1",
    repoId: "r1",
    createdBy: "octocat",
    now: 1000,
    engine: "audit-v1",
    finding: finding(),
    ...over,
  };
}

function precedent(over: Partial<SecurityPrecedent> = {}): SecurityPrecedent {
  return {
    id: "p1",
    ownerUserId: "u1",
    repoId: "r1",
    scope: "repo",
    code: "control_exists",
    action: "false_positive",
    note: "auth is in requireAuth middleware",
    class: "missing-authz",
    slug: "payout route missing auth",
    path: "backend/src/routes/pay.ts",
    symbol: "createPayout",
    originFindingId: "f1",
    anchorSha: "sha-a",
    anchorEvidence: "42: router.post('/payout', createPayout)",
    engineAtCreation: "audit-v1",
    createdAt: 1000,
    createdBy: "octocat",
    status: "active",
    statusReason: null,
    suppressedCount: 0,
    lastAppliedAt: null,
    ...over,
  };
}

// --- authoring -------------------------------------------------------------

test("precedentFromRuling: a teachable code with a note becomes precedent", () => {
  const p = precedentFromRuling(ruling());
  assert.ok(p);
  assert.equal(p.code, "control_exists");
  assert.equal(p.action, "false_positive");
  assert.equal(p.status, "active");
  assert.equal(p.anchorSha, "sha-a");
  assert.equal(p.anchorEvidence, "42: router.post('/payout', createPayout)");
});

test("precedentFromRuling: an empty note teaches nothing", () => {
  assert.equal(precedentFromRuling(ruling({ note: "   " })), null);
});

test("precedentFromRuling: non-teachable codes never reach the corpus", () => {
  for (const code of ["out_of_scope", "duplicate", "accepted_cost"] as SecurityRulingCode[]) {
    assert.equal(isTeachable(code), false, `${code} must not be teachable`);
    assert.equal(precedentFromRuling(ruling({ code, note: "a real reason" })), null, code);
  }
});

test("actionForCode: accepted-risk codes suppress as accepted, corrections as false_positive", () => {
  assert.equal(actionForCode("by_design"), "accepted");
  assert.equal(actionForCode("compensating_control"), "accepted");
  assert.equal(actionForCode("accepted_cost"), "accepted");
  assert.equal(actionForCode("control_exists"), "false_positive");
  assert.equal(actionForCode("misread_code"), "false_positive");
});

// --- the HARD channel ------------------------------------------------------

const HERE = { repoId: "r1", path: "backend/src/routes/pay.ts" };

test("matchPrecedent: same repo, same class, same file — suppresses", () => {
  const hit = matchPrecedent({ class: "missing-authz" }, [precedent()], HERE);
  assert.equal(hit?.id, "p1");
});

test("matchPrecedent: same repo, same class, same symbol in a moved file — suppresses", () => {
  const hit = matchPrecedent(
    { class: "missing-authz", symbol: "createPayout" },
    [precedent()],
    { repoId: "r1", path: "backend/src/routes/payouts/index.ts" }
  );
  assert.equal(hit?.id, "p1");
});

test("matchPrecedent: class alone is never enough", () => {
  // Same class, different file, no shared symbol — a different bug entirely.
  const hit = matchPrecedent(
    { class: "missing-authz", symbol: "deleteTenant" },
    [precedent()],
    { repoId: "r1", path: "backend/src/routes/admin.ts" }
  );
  assert.equal(hit, null);
});

test("matchPrecedent: an account-scoped ruling never auto-suppresses", () => {
  // It is prompt-only by design: an architectural fact must not silently mute
  // a finding in a repo the maintainer never looked at.
  const hit = matchPrecedent({ class: "missing-authz" }, [precedent({ scope: "account" })], HERE);
  assert.equal(hit, null);
});

test("matchPrecedent: never crosses repos", () => {
  const hit = matchPrecedent({ class: "missing-authz" }, [precedent()], { ...HERE, repoId: "r2" });
  assert.equal(hit, null);
});

test("matchPrecedent: a revoked or needs_reconfirm ruling stops suppressing", () => {
  for (const status of ["revoked", "needs_reconfirm"] as const) {
    assert.equal(matchPrecedent({ class: "missing-authz" }, [precedent({ status })], HERE), null, status);
  }
});

test("matchPrecedent: a generic short symbol can't carry a cross-file match", () => {
  const hit = matchPrecedent(
    { class: "missing-authz", symbol: "run" },
    [precedent({ symbol: "run" })],
    { repoId: "r1", path: "backend/src/routes/other.ts" }
  );
  assert.equal(hit, null);
});

test("matchPrecedent: a different class in the same file does not match", () => {
  const hit = matchPrecedent({ class: "sql-injection" }, [precedent()], HERE);
  assert.equal(hit, null);
});

// --- expiry ----------------------------------------------------------------

const FILE = `import { router } from "./r";\nrouter.post('/payout', createPayout)\nexport default router;`;

test("anchorHolds: true when the quoted evidence line is still in the file", () => {
  assert.equal(anchorHolds(precedent(), { sha: "sha-b", content: FILE }), true);
});

test("anchorHolds: tolerates reindentation and a changed sha elsewhere in the file", () => {
  const reindented = `import { router } from "./r";\n    router.post('/payout',   createPayout)\n// a new comment\n`;
  assert.equal(anchorHolds(precedent(), { sha: "sha-zzz", content: reindented }), true);
});

test("anchorHolds: false once the code the ruling rested on is gone", () => {
  const rewritten = `router.post('/payout', requireAuth, createPayout)\n`;
  assert.equal(anchorHolds(precedent(), { sha: "sha-b", content: rewritten }), false);
});

test("anchorHolds: with no quoted evidence, falls back to the blob sha", () => {
  const p = precedent({ anchorEvidence: undefined });
  assert.equal(anchorHolds(p, { sha: "sha-a", content: FILE }), true);
  assert.equal(anchorHolds(p, { sha: "sha-b", content: FILE }), false);
});

test("anchorHolds: trivial quoted lines don't keep a dead ruling alive", () => {
  // "});" would match almost any file — it must not count as the anchor.
  const p = precedent({ anchorEvidence: "12: });" });
  assert.equal(anchorHolds(p, { sha: "sha-b", content: FILE }), false);
});

// --- the SOFT channel ------------------------------------------------------

test("selectPrecedents: ranks same-file over same-dir over account-wide", () => {
  const corpus = [
    precedent({ id: "far", path: "frontend/src/app.tsx" }),
    precedent({ id: "acct", scope: "account", repoId: "r9", path: "other/x.ts" }),
    precedent({ id: "dir", path: "backend/src/routes/admin.ts" }),
    precedent({ id: "same", path: HERE.path }),
  ];
  const ids = selectPrecedents(corpus, HERE).map((p) => p.id);
  assert.deepEqual(ids, ["same", "dir", "acct", "far"]);
});

test("selectPrecedents: another repo's repo-scoped rulings are excluded", () => {
  const corpus = [precedent({ id: "other-repo", repoId: "r2" }), precedent({ id: "mine" })];
  const ids = selectPrecedents(corpus, HERE).map((p) => p.id);
  assert.deepEqual(ids, ["mine"]);
});

test("selectPrecedents: account-scoped rulings from another repo do travel", () => {
  const corpus = [precedent({ id: "arch", repoId: "r2", scope: "account" })];
  assert.equal(selectPrecedents(corpus, HERE).length, 1);
});

test("selectPrecedents: revoked rulings are never injected", () => {
  assert.equal(selectPrecedents([precedent({ status: "revoked" })], HERE).length, 0);
});

test("selectPrecedents: needs_reconfirm still informs the prompt", () => {
  // It stops auto-suppressing (see matchPrecedent) but the context is useful.
  assert.equal(selectPrecedents([precedent({ status: "needs_reconfirm" })], HERE).length, 1);
});

test("selectPrecedents: caps the injected count", () => {
  const corpus = Array.from({ length: 40 }, (_, i) => precedent({ id: `p${i}` }));
  assert.equal(selectPrecedents(corpus, HERE).length, MAX_INJECTED);
});

test("renderPrecedentBlock: empty corpus renders nothing", () => {
  assert.equal(renderPrecedentBlock([]), "");
});

test("renderPrecedentBlock: carries the note and stays inside the char budget", () => {
  const block = renderPrecedentBlock([precedent()]);
  assert.match(block, /Prior maintainer rulings/);
  assert.match(block, /auth is in requireAuth middleware/);
  assert.match(block, /false positive/);

  const fat = Array.from({ length: MAX_INJECTED }, (_, i) =>
    precedent({ id: `p${i}`, note: "x".repeat(400) })
  );
  assert.ok(renderPrecedentBlock(fat).length <= MAX_INJECTED_CHARS + 200);
});

test("renderPrecedentBlock: an accepted-risk ruling doesn't read as a correction", () => {
  const block = renderPrecedentBlock([precedent({ code: "by_design", action: "accepted" })]);
  assert.match(block, /accepted the risk/);
  assert.doesNotMatch(block, /false positive/);
});

test("renderPrecedentBlock: a stale ruling is flagged rather than hidden", () => {
  const block = renderPrecedentBlock([precedent({ status: "needs_reconfirm" })]);
  assert.match(block, /code has since changed/);
});
