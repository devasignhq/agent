// Unit tests for the GitHub issue body built from a security finding — the
// hand-off document a contributor (or a bounty applicant) actually reads. No
// db / network / LLM. Run:
//   node --import tsx/esm --test src/security/issue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFindingIssue, findingIssueBody, IssueCreationError } from "./issue.js";
import type { SecurityFinding } from "../types.js";

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: "f1",
  fingerprint: "fp1",
  repoId: "r1",
  path: "api/routes/payouts.ts",
  line: 88,
  symbol: "registerRoutes",
  class: "missing-authz",
  cwe: "CWE-306",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "Payout route reachable without authentication",
  concern: "The rewrite dropped requireAuth from the payouts group.",
  evidence: 'line 88: app.post("/v1/payouts", createPayout)',
  exploitNarrative: ["reach the route", "post a payout", "funds move"],
  blastRadius: "funds — up to the per-tx cap",
  invariant: "every payout call is authenticated",
  remediation: "Re-add requireAuth before the idempotency middleware.",
  regressionTest: 'expect(post("/v1/payouts", { noAuth: true })).toHaveStatus(401);',
  state: "open",
  firstDetectedAt: 0,
  lastSeenAt: 0,
  detectedSha: "sha",
  model: "m",
  activity: [],
  ...over,
});

test("issue body carries severity, location, exploit path, fix and regression test", () => {
  const body = findingIssueBody(finding());
  assert.match(body, /\*\*Severity:\*\* critical/);
  assert.match(body, /\*\*CWE-306\*\*/);
  assert.match(body, /api\/routes\/payouts\.ts:88/);
  assert.match(body, /registerRoutes/);
  assert.match(body, /### Exploit path/);
  // The narrative renders as numbered steps, in order.
  assert.match(body, /1\. reach the route/);
  assert.match(body, /3\. funds move/);
  assert.match(body, /### Suggested fix/);
  assert.match(body, /### Regression test/);
  assert.match(body, /Blast radius:\*\* funds/);
  // Deep link back to the finding, so the sponsor can get from issue → page.
  assert.match(body, /\/security\/findings\/f1\)/);
});

test("issue body carries the verifier's cited evidence for a confirmed finding", () => {
  const body = findingIssueBody(
    finding({
      verification: {
        status: "confirmed",
        evidence: [{ path: "api/app.ts", line: 40, quote: 'app.use("/v1", router)' }],
        verifiedAt: 1,
        model: "m",
        engine: "verify-v1",
      },
    })
  );
  assert.match(body, /### Verification/);
  assert.match(body, /`api\/app\.ts:40` — `app\.use\("\/v1", router\)`/);
  assert.doesNotMatch(findingIssueBody(finding()), /### Verification/);
});

test("createFindingIssue refuses a held-back finding before touching GitHub", async () => {
  await assert.rejects(
    createFindingIssue({ repo: {} as any, install: {} as any, finding: finding({ state: "unverified" }), actorLogin: "x" }),
    (e: unknown) => e instanceof IssueCreationError && e.code === "unverified"
  );
});

test("issue body omits optional sections cleanly when the finding lacks them", () => {
  const body = findingIssueBody(
    finding({
      evidence: undefined,
      exploitNarrative: undefined,
      remediation: undefined,
      regressionTest: undefined,
      blastRadius: undefined,
      invariant: undefined,
      cwe: undefined,
      line: undefined,
      symbol: undefined,
    })
  );
  assert.doesNotMatch(body, /### Evidence/);
  assert.doesNotMatch(body, /### Exploit path/);
  assert.doesNotMatch(body, /### Suggested fix/);
  assert.doesNotMatch(body, /### Regression test/);
  assert.doesNotMatch(body, /undefined/);
  // The core still renders.
  assert.match(body, /\*\*Severity:\*\* critical/);
  assert.match(body, /api\/routes\/payouts\.ts/);
  assert.match(body, /### What's wrong/);
});

test("under the proof gate the Verification section states the proof, never the AI review", () => {
  const confirmed = {
    status: "confirmed" as const,
    evidence: [{ path: "api/app.ts", line: 40, quote: 'app.use("/v1", router)' }],
    verifiedAt: 1,
    model: "m",
    engine: "verify-v1",
  };
  const proven = findingIssueBody(
    finding({
      verification: confirmed,
      detectedSha: "blob1",
      proof: {
        status: "verified",
        method: "test",
        blobSha: "blob1",
        testedSha: "0123456789abcdef",
        testPath: ".devasign/tests/payouts.proof.test.ts",
        engine: "proof-v1",
        updatedAt: 1,
      },
    }),
    { proofGate: true }
  );
  assert.match(proven, /### Verification\nReproduced by an executed test at `0123456789ab`/);
  assert.match(proven, /Test: `\.devasign\/tests\/payouts\.proof\.test\.ts`/);
  assert.doesNotMatch(proven, /Independently verified/);

  const untested = findingIssueBody(finding({ verification: confirmed }), { proofGate: true });
  assert.doesNotMatch(untested, /### Verification/);
});

test("under the proof gate createFindingIssue refuses an untested finding before touching GitHub", async () => {
  await assert.rejects(
    createFindingIssue({ repo: {} as any, install: {} as any, finding: finding(), actorLogin: "x", proofGate: true }),
    (e: unknown) => e instanceof IssueCreationError && e.code === "untested"
  );
});
