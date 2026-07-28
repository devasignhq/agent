// Unit tests for buildFindingRows — the hardening layer between the audit
// model's JSON and stored rows. The load-bearing rule under test: no 3-step
// exploit narrative → not a finding (the audit contract's precision rule).
// No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/agent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFindingRows } from "./agent.js";

const item = (over: Record<string, unknown> = {}) => ({
  stable_key: "payout-missing-auth",
  class: "missing-authz",
  cwe: "CWE-306",
  severity: "critical",
  confidence: "confirmed",
  title: "Payout route reachable without authentication",
  concern: "The route registration lost requireAuth.",
  evidence: 'line 88: app.post("/v1/payouts", createPayout)',
  line: 88,
  symbol: "registerRoutes",
  exploit_narrative: ["reach the route", "post a payout", "funds move"],
  blast_radius: "funds",
  invariant: "every payout call is authenticated",
  remediation: "restore requireAuth on the payouts group",
  regression_test: "expect 401 without auth",
  ...over,
});

test("a well-formed finding round-trips with clamped enums and surface", () => {
  const out = buildFindingRows({ findings: [item()] }, "api/routes/payouts.ts");
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.severity, "critical");
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.cwe, "CWE-306");
  assert.equal(f.surface, "api");
  assert.deepEqual(f.exploitNarrative, ["reach the route", "post a payout", "funds move"]);
  assert.equal(f.line, 88);
});

test("no 3-step exploit narrative → dropped (the contract's core precision rule)", () => {
  const out = buildFindingRows(
    {
      findings: [
        item({ exploit_narrative: ["only", "two"] }),
        item({ exploit_narrative: undefined }),
        item({ exploit_narrative: ["a", "", "  "] }), // blanks don't count
      ],
    },
    "api/x.ts"
  );
  assert.equal(out.length, 0);
});

test("unknown severity/confidence clamp to medium / needs_human", () => {
  const out = buildFindingRows(
    { findings: [item({ severity: "catastrophic", confidence: "certain" })] },
    "api/x.ts"
  );
  assert.equal(out[0].severity, "medium");
  assert.equal(out[0].confidence, "needs_human");
});

test("a malformed cwe is dropped, a valid one is uppercased", () => {
  const bad = buildFindingRows({ findings: [item({ cwe: "not-a-cwe" })] }, "api/x.ts");
  assert.equal(bad[0].cwe, undefined);
  const ok = buildFindingRows({ findings: [item({ cwe: "cwe-89" })] }, "api/x.ts");
  assert.equal(ok[0].cwe, "CWE-89");
});

test("missing title or concern drops the item; non-array input yields nothing", () => {
  assert.equal(buildFindingRows({ findings: [item({ title: "" })] }, "p").length, 0);
  assert.equal(buildFindingRows({ findings: [item({ concern: "" })] }, "p").length, 0);
  assert.equal(buildFindingRows({ findings: "nope" }, "p").length, 0);
  assert.equal(buildFindingRows(null, "p").length, 0);
});

test("per-file cap holds at 15", () => {
  const many = Array.from({ length: 30 }, (_, i) => item({ stable_key: `k${i}`, title: `t${i}` }));
  assert.equal(buildFindingRows({ findings: many }, "p").length, 15);
});

test("a secret-class finding lands on the secrets surface wherever the file lives", () => {
  const out = buildFindingRows(
    { findings: [item({ class: "hardcoded-secret" })] },
    "frontend/src/app.tsx"
  );
  assert.equal(out[0].surface, "secrets");
});
