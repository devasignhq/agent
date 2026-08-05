// Tests for the devasign/security check-run rendering. The load-bearing case is
// disclosure: check-run output on a PUBLIC repo is world-readable, so an
// unpatched finding's path/line/title must never reach it — otherwise the gate
// broadcasts the vulnerability it is blocking the fix for. Private repos keep
// full detail (anyone who can read the check already has the source).
// No network / LLM; db is the in-memory store (initDb is never called). Run:
//   node --import tsx/esm --test src/security/gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { config } from "../config.js";
import { gateOutput } from "./gate.js";
import { computeGate, DEFAULT_SECURITY_POLICY, type GateResult } from "./policy.js";
import type { Repository, SecurityFinding } from "../types.js";

// gateOutput reads exactly one collection; nothing else needs clearing.
function reset() {
  db.remove("securityFindings", () => true);
}

const repoFx = (isPrivate: boolean): Repository =>
  ({
    id: "r1",
    installationId: "i1",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
    private: isPrivate,
    defaultModel: "",
    modelOverrides: {},
    reviewsEnabled: true,
  }) as unknown as Repository;

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: "f1",
  fingerprint: "fp1",
  repoId: "r1",
  path: "api/payouts.ts",
  line: 42,
  class: "sql-injection",
  surface: "api",
  severity: "critical",
  confidence: "confirmed",
  title: "Unparameterised payout query",
  concern: "c",
  state: "open",
  firstDetectedAt: 0,
  lastSeenAt: 0,
  detectedSha: "s",
  model: "m",
  activity: [],
  ...over,
});

// The blocking-finding list is read from the db, not passed in — this is the
// first test in the suite to insert securityFindings rows (policy.test.ts
// deliberately builds them as plain objects instead).
function seedFinding(over: Partial<SecurityFinding> = {}): SecurityFinding {
  const row = finding(over);
  db.insert("securityFindings", row);
  return row;
}

// Shaped like computeGate's output under DEFAULT_SECURITY_POLICY (critical
// blocks, high warns): a failing R1 for critical, a passing R2, a warn row.
const blockedGate = (blockingFindingIds: string[]): GateResult => ({
  verdict: "fail",
  rules: [
    {
      id: "no-open-critical",
      label: "No unresolved critical findings on the default branch",
      pass: false,
      required: true,
      count: blockingFindingIds.length,
    },
    {
      id: "no-introduced-blocking",
      label: "No open PR introduces a block-gated finding",
      pass: true,
      required: true,
      count: 0,
    },
    { id: "warn-high", label: "Unresolved high findings", pass: true, required: false, count: 0 },
  ],
  blockingFindingIds,
});

const LINK = `\n\nReview and resolve on the Security page: ${config.webOrigin}/security/gate`;
const COUNTS = "✗ No unresolved critical findings on the default branch — 1 found";

test("gateOutput: a public repo's blocked summary leaks no path, line, title or severity", () => {
  reset();
  const f = seedFinding();
  const out = gateOutput(repoFx(false), blockedGate([f.id]));
  // Five separate negative assertions so a partial revert can't slip through.
  assert.doesNotMatch(out.summary, /api\/payouts\.ts/);
  assert.doesNotMatch(out.summary, /:42/);
  assert.doesNotMatch(out.summary, /Unparameterised payout query/);
  assert.doesNotMatch(out.summary, /\*\*critical\*\*/);
  assert.doesNotMatch(out.summary, /confirmed/);
});

test("gateOutput: a public repo still gets the failed-rule counts, the reason and the link", () => {
  reset();
  const f = seedFinding();
  const out = gateOutput(repoFx(false), blockedGate([f.id]));
  assert.equal(out.title, "Security gate blocked");
  // Exact-equality pins the clause wording and the blank-line structure at once.
  assert.equal(
    out.summary,
    COUNTS +
      "\n\nFinding details are withheld on public repos to avoid disclosing unpatched issues." +
      LINK
  );
});

test("gateOutput: a private repo's blocked summary is unchanged — full detail still renders", () => {
  reset();
  const f = seedFinding();
  const out = gateOutput(repoFx(true), blockedGate([f.id]));
  assert.equal(out.title, "Security gate blocked");
  assert.equal(
    out.summary,
    COUNTS + "\n\n- **critical** Unparameterised payout query (`api/payouts.ts:42`) — confirmed" + LINK
  );
});

test("gateOutput: the pass branch is identical on public and private repos", () => {
  reset();
  const passing: GateResult = { verdict: "pass", rules: [], blockingFindingIds: [] };
  const pub = gateOutput(repoFx(false), passing);
  const priv = gateOutput(repoFx(true), passing);
  assert.deepEqual(pub, priv);
  assert.equal(pub.title, "Security gate passed");
  assert.equal(
    pub.summary,
    `All required security gate rules pass.\n\nDetails: ${config.webOrigin}/security/gate`
  );
});

test("gateOutput: a failure with no blocking findings claims no redaction", () => {
  reset();
  // R2-only failure: an open PR introduces a finding, so blockingFindingIds is
  // empty and the private path had no detail block to begin with.
  const r2Only: GateResult = {
    verdict: "fail",
    rules: [
      {
        id: "no-open-critical",
        label: "No unresolved critical findings on the default branch",
        pass: true,
        required: true,
        count: 0,
      },
      {
        id: "no-introduced-blocking",
        label: "No open PR introduces a block-gated finding",
        pass: false,
        required: true,
        count: 1,
      },
    ],
    blockingFindingIds: [],
  };
  const pub = gateOutput(repoFx(false), r2Only);
  const priv = gateOutput(repoFx(true), r2Only);
  assert.deepEqual(pub, priv);
  assert.doesNotMatch(pub.summary, /withheld/);
});

test("gateOutput: a real computeGate verdict never renders a malformed summary", () => {
  reset();
  const f = seedFinding();
  // Drive the real gate rather than a hand-built fixture: `fail` is defined as
  // >= 1 failing required rule, which is what keeps `counts` non-empty.
  const gate = computeGate({
    findings: [f],
    openReviews: [],
    policy: DEFAULT_SECURITY_POLICY,
  });
  assert.equal(gate.verdict, "fail");
  assert.ok(gate.rules.filter((r) => r.required && !r.pass).length >= 1);
  for (const repo of [repoFx(false), repoFx(true)]) {
    const { summary } = gateOutput(repo, gate);
    assert.doesNotMatch(summary, /^\n/); // no leading blank line from empty counts
    assert.doesNotMatch(summary, /\n\n\n/); // no doubled separator
  }
});

test("gateOutput: a private-repo finding with no line number renders the path alone", () => {
  reset();
  const f = seedFinding({ line: undefined });
  const out = gateOutput(repoFx(true), blockedGate([f.id]));
  assert.match(out.summary, /\(`api\/payouts\.ts`\)/);
  assert.doesNotMatch(out.summary, /undefined/);
});
