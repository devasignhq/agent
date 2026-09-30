// The Security page API under the proof gate: with SECURITY_PROOF_MODE off the
// payload is unchanged; on, findings carry a presentation, repos a readiness, and
// untested rows can be dismissed but not filed as issues. In-memory db. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= STATSIG_SECRET_KEY= \
//     node --import tsx/esm --test src/routes/security-proof.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { DEFAULT_SECURITY_POLICY } from "../security/policy.js";
import type { SecurityFinding } from "../types.js";
import { securityFindingIssueHandler, securityFindingPatchHandler, securityOverviewHandler } from "./api.js";

const ORIGINAL = process.env.SECURITY_PROOF_MODE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SECURITY_PROOF_MODE;
  else process.env.SECURITY_PROOF_MODE = ORIGINAL;
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => {
    res.statusCode = n;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

const reqFor = (userId: string, params: Record<string, string> = {}, body: unknown = {}): any => ({
  cookies: { devasign_session: signSession(userId) },
  params,
  body,
});

// onPrPush off: publishGateForRepo would otherwise try to reach GitHub.
const QUIET_POLICY = {
  ...DEFAULT_SECURITY_POLICY,
  triggers: { ...DEFAULT_SECURITY_POLICY.triggers, onPrPush: false },
};
const VERIFIED = {
  status: "verified" as const,
  method: "test" as const,
  blobSha: "blob1",
  engine: "proof-v1",
  updatedAt: 1,
};

function finding(repoId: string, over: Partial<SecurityFinding>): SecurityFinding {
  return {
    id: uuid(),
    fingerprint: uuid(),
    repoId,
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
  };
}

function seed() {
  for (const c of [
    "users",
    "subscriptions",
    "installations",
    "repositories",
    "securityFindings",
    "securityScans",
  ] as const) {
    db.remove(c, () => true);
  }
  const userId = uuid();
  const installId = uuid();
  db.insert("users", {
    id: userId,
    githubId: 1,
    githubLogin: "octocat",
    email: "o@e.com",
    plan: "free",
    createdAt: 1,
  } as any);
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan: "pro",
    status: "active",
    currentPeriodEnd: Date.now() + 30 * 24 * 3600_000,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
  } as any);
  db.insert("installations", {
    id: installId,
    userId,
    accountId: 1,
    accountLogin: "octocat",
    installationId: 1,
    repoIds: [],
  } as any);
  const repo = (name: string, over: Record<string, unknown>) =>
    db.insert("repositories", {
      id: uuid(),
      installationId: installId,
      owner: "octocat",
      name,
      defaultBranch: "main",
      reviewsEnabled: true,
      securityPolicy: QUIET_POLICY,
      ...over,
    } as any);
  const ready = repo("ready", { private: true, verify: { onboarding: { state: "verified" } } });
  const bare = repo("bare", { private: false });
  const rows = {
    proven: db.insert("securityFindings", finding(ready.id, { proof: VERIFIED })),
    untested: db.insert("securityFindings", finding(ready.id, {})),
    held: db.insert("securityFindings", finding(ready.id, { state: "unverified" })),
    kept: db.insert(
      "securityFindings",
      finding(ready.id, {
        state: "issue_created",
        issueNumber: 7,
        issueUrl: "https://github.com/octocat/ready/issues/7",
      })
    ),
    other: db.insert("securityFindings", finding(bare.id, {})),
  };
  return { userId, ready, bare, rows };
}

test("proof mode off: the overview carries no proof-gate keys", () => {
  delete process.env.SECURITY_PROOF_MODE;
  const { userId } = seed();
  const res = fakeRes();
  securityOverviewHandler(reqFor(userId), res);
  assert.equal(res.statusCode, 200);
  for (const f of res.body.findings) assert.equal("presentation" in f, false);
  for (const r of res.body.repos) {
    for (const k of ["proofGate", "private", "proofReadiness"]) assert.equal(k in r, false, k);
  }
});

test("proof mode on: findings carry a presentation and repos a readiness", () => {
  process.env.SECURITY_PROOF_MODE = "on";
  const { userId, ready, bare, rows } = seed();
  const res = fakeRes();
  securityOverviewHandler(reqFor(userId), res);
  const by = new Map(res.body.findings.map((f: any) => [f.id, f.presentation]));
  assert.equal(by.get(rows.proven.id), "main");
  assert.equal(by.get(rows.untested.id), "untested");
  assert.equal(by.get(rows.held.id), "untested");
  assert.equal(by.get(rows.kept.id), "kept");
  const repos = new Map(res.body.repos.map((r: any) => [r.id, r]));
  assert.deepEqual(
    [(repos.get(ready.id) as any).proofReadiness, (repos.get(bare.id) as any).proofReadiness],
    ["ready", "needs_setup"]
  );
  assert.equal((repos.get(ready.id) as any).proofGate, true);
  assert.equal((repos.get(bare.id) as any).private, false);
  assert.deepEqual((repos.get(ready.id) as any).gate.blockingFindingIds, [rows.proven.id]);
});

test("a held-back row can be dismissed under the proof gate, and not without it", () => {
  delete process.env.SECURITY_PROOF_MODE;
  let seeded = seed();
  let res = fakeRes();
  securityFindingPatchHandler(
    reqFor(seeded.userId, { id: seeded.ready.id, findingId: seeded.rows.held.id }, { action: "false_positive" }),
    res
  );
  assert.equal(res.statusCode, 409);

  process.env.SECURITY_PROOF_MODE = "on";
  seeded = seed();
  res = fakeRes();
  securityFindingPatchHandler(
    reqFor(seeded.userId, { id: seeded.ready.id, findingId: seeded.rows.held.id }, { action: "false_positive" }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.finding.state, "false_positive");
  assert.equal(res.body.finding.presentation, "suppressed");
});

// Prompted by our own verifier on PR #279: the overview's gate-off shape was
// asserted, but the PATCH response's was not — and PATCH is what every triage
// consumer reads back.
test("proof mode off: a successful PATCH returns the stored row, with no proof keys", () => {
  delete process.env.SECURITY_PROOF_MODE;
  const { userId, ready, rows } = seed();
  const res = fakeRes();
  securityFindingPatchHandler(
    reqFor(userId, { id: ready.id, findingId: rows.untested.id }, { action: "accept" }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.finding.state, "accepted");
  assert.equal("presentation" in res.body.finding, false);
  assert.equal("proof" in res.body.finding, false);
  // Byte-for-byte the row the db holds — no view wrapper in the way.
  assert.deepEqual(
    res.body.finding,
    db.find("securityFindings", (f) => f.id === rows.untested.id)
  );
});

test("an untested row can't become an issue under the proof gate; a kept row returns its existing issue", async () => {
  process.env.SECURITY_PROOF_MODE = "on";
  const { userId, ready, rows } = seed();
  let res = fakeRes();
  await securityFindingIssueHandler(reqFor(userId, { id: ready.id, findingId: rows.untested.id }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "untested");

  res = fakeRes();
  await securityFindingIssueHandler(reqFor(userId, { id: ready.id, findingId: rows.kept.id }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.issueNumber, 7);
});
