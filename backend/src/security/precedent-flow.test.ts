// The learning loop, end to end over two scans — the composition audit.ts
// performs per file: expire stale rulings against the fetched content, select
// what to inject, match what to auto-suppress, then reconcile. The unit tests
// cover each rule in isolation; this one pins the ORDER, which is where a
// suppression feature goes wrong. No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/precedent-flow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecurityFinding } from "../types.js";
import { anchorHolds, matchPrecedent, precedentFromRuling, renderPrecedentBlock, selectPrecedents } from "./precedent.js";
import { reconcileFile, type DetectedFinding, type ReconcileCtx } from "./reconcile.js";

const REPO = "r1";
const ENGINE = "audit-v1";

// What the mock audit agent emits — same shape the real one does, and the same
// class/symbol pair the LLM mock's SECURITY_SAMPLE finding carries.
const detection = (over: Partial<DetectedFinding> = {}): DetectedFinding => ({
  slug: "payout-route-missing-auth",
  class: "missing-authz",
  surface: "api",
  severity: "medium",
  confidence: "needs_human",
  title: "payout route appears to lack an authorization check",
  concern: "reads the account id from the body and moves funds with no in-file check",
  evidence: "line 42: const accountId = req.body.accountId;",
  symbol: "payoutHandler",
  exploitNarrative: ["a", "b", "c"],
  ...over,
});

const ctx = (path: string, sha: string): ReconcileCtx => ({
  repoId: REPO,
  path,
  sha,
  now: 2_000_000,
  model: "m",
  origin: { pr: null, sha: null, author: null },
});

const FILE_A = "api/routes/payouts.ts";
const FILE_B = "api/routes/refunds.ts";
const CONTENT_A = `export function payoutHandler(req, res) {\n  const accountId = req.body.accountId;\n}\n`;

// One pass of what the audit worker does to a single file.
function scanPass(args: {
  path: string;
  sha: string;
  content: string;
  corpus: ReturnType<typeof precedentFromRuling>[];
  existing: SecurityFinding[];
  detected: DetectedFinding[];
}) {
  const live = args.corpus.filter((p): p is NonNullable<typeof p> => !!p);

  // 1. Expiry, against the content we just fetched.
  for (const p of live) {
    if (p.status !== "active" || p.repoId !== REPO || p.path !== args.path) continue;
    if (anchorHolds(p, { sha: args.sha, content: args.content })) continue;
    p.status = "needs_reconfirm";
    p.statusReason = "code_changed";
  }

  // 2. What the model is told.
  const injected = renderPrecedentBlock(selectPrecedents(live, { repoId: REPO, path: args.path }));

  // 3. What is muted without the model getting a vote.
  const annotated = args.detected.map((d) => {
    const p = matchPrecedent(d, live, { repoId: REPO, path: args.path });
    return p ? { ...d, suppressedBy: { precedentId: p.id, action: p.action, note: p.note } } : d;
  });

  // 4. Rows.
  const result = reconcileFile({
    existing: args.existing,
    detected: annotated,
    ctx: ctx(args.path, args.sha),
  });
  return { injected, result };
}

test("loop: a ruling in one file mutes the same bug in a sibling file, and says so", () => {
  // Scan 1 — nothing learned yet, so the finding lands active.
  const first = scanPass({
    path: FILE_A,
    sha: "sha-a",
    content: CONTENT_A,
    corpus: [],
    existing: [],
    detected: [detection()],
  });
  assert.equal(first.injected, "", "nothing to inject on a virgin corpus");
  assert.equal(first.result.insert[0].state, "new");

  const row = first.result.insert[0];

  // The maintainer looks at it and explains what the agent got wrong.
  const p = precedentFromRuling({
    code: "control_exists",
    note: "requireAuth wraps the whole /v1 router in server.ts",
    scope: "repo",
    installationId: "inst-1",
    ownerUserId: "u1",
    repoId: REPO,
    createdBy: "octocat",
    now: 1_500_000,
    engine: ENGINE,
    finding: { ...row, title: row.title, detectedSha: row.detectedSha },
  });
  assert.ok(p);

  // Scan 2 — the SAME bug class and symbol, in a file that has no row yet.
  const second = scanPass({
    path: FILE_B,
    sha: "sha-b",
    content: CONTENT_A,
    corpus: [p],
    existing: [],
    detected: [detection()],
  });

  // The soft channel: the model is told, and told it may still disagree.
  assert.match(second.injected, /requireAuth wraps the whole \/v1 router/);

  // The hard channel: the row is born suppressed, and never counted as new.
  const muted = second.result.insert[0];
  assert.equal(muted.state, "false_positive");
  assert.equal(muted.suppressedByPrecedentId, p.id);
  assert.equal(second.result.introduced, 0);
  assert.deepEqual(second.result.appliedPrecedentIds, [p.id]);
});

test("loop: once the code moves out from under a ruling, it stops muting", () => {
  const p = precedentFromRuling({
    code: "control_exists",
    note: "requireAuth wraps the whole /v1 router in server.ts",
    scope: "repo",
    installationId: "inst-1",
    ownerUserId: "u1",
    repoId: REPO,
    createdBy: "octocat",
    now: 1_500_000,
    engine: ENGINE,
    finding: {
      id: "f1",
      class: "missing-authz",
      path: FILE_A,
      symbol: "payoutHandler",
      evidence: "line 42: const accountId = req.body.accountId;",
      detectedSha: "sha-a",
      title: "payout route missing auth",
    },
  });
  assert.ok(p);

  // The file is rewritten and the line the ruling rested on is gone.
  const rewritten = `export function payoutHandler(req, res) {\n  const accountId = session.accountId;\n}\n`;
  const out = scanPass({
    path: FILE_A,
    sha: "sha-c",
    content: rewritten,
    corpus: [p],
    existing: [],
    detected: [detection()],
  });

  assert.equal(p.status, "needs_reconfirm");
  assert.equal(p.statusReason, "code_changed");
  // Surfaced again rather than silently muted — the whole point of expiry.
  assert.equal(out.result.insert[0].state, "new");
  assert.equal(out.result.insert[0].suppressedByPrecedentId, undefined);
  // …but the maintainer's reasoning is still shown to the model, flagged stale.
  assert.match(out.injected, /code has since changed/);
});

test("loop: an account-scoped ruling informs the model but mutes nothing", () => {
  const p = precedentFromRuling({
    code: "control_exists",
    note: "auth always lives in middleware in our services",
    scope: "account",
    installationId: "inst-1",
    ownerUserId: "u1",
    repoId: "r-other",
    createdBy: "octocat",
    now: 1_500_000,
    engine: ENGINE,
    finding: {
      id: "f9",
      class: "missing-authz",
      path: "svc/other.ts",
      symbol: "payoutHandler",
      detectedSha: "sha-x",
      title: "t",
    },
  });
  assert.ok(p);

  const out = scanPass({
    path: FILE_B,
    sha: "sha-b",
    content: CONTENT_A,
    corpus: [p],
    existing: [],
    detected: [detection()],
  });

  assert.match(out.injected, /auth always lives in middleware/);
  assert.equal(out.result.insert[0].state, "new", "an account ruling must never auto-hide");
  assert.equal(out.result.appliedPrecedentIds.length, 0);
});

test("loop: a ruling with no rationale never enters the corpus", () => {
  const p = precedentFromRuling({
    code: "control_exists",
    note: "",
    scope: "repo",
    installationId: "inst-1",
    ownerUserId: "u1",
    repoId: REPO,
    createdBy: "octocat",
    now: 1_500_000,
    engine: ENGINE,
    finding: { id: "f1", class: "missing-authz", path: FILE_A, detectedSha: "sha-a", title: "t" },
  });
  assert.equal(p, null);

  // …so a later scan of a sibling file is unaffected.
  const out = scanPass({
    path: FILE_B,
    sha: "sha-b",
    content: CONTENT_A,
    corpus: [p],
    existing: [],
    detected: [detection()],
  });
  assert.equal(out.injected, "");
  assert.equal(out.result.insert[0].state, "new");
});
