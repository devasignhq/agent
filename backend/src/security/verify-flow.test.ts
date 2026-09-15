// The audit's per-file loop re-staged offline: real scanFile (LLM mock with
// SECURITY_SAMPLE=1) → mechanicalCheck → buildEvidenceBundle → real
// verifyFindings (mock, steered by SECURITY_VERIFY_SAMPLE) → applyVerdict →
// reconcileFile. node --test gives this file its own process, so the flags
// cannot leak. Run:
//   node --import tsx/esm --test src/security/verify-flow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFile } from "./agent.js";
import { DEFAULT_SECURITY_POLICY } from "./policy.js";
import { reconcileFile, type DetectedFinding, type ReconcileCtx } from "./reconcile.js";
import { applyVerdict, buildEvidenceBundle, holdVerification, mechanicalCheck, verifyFindings } from "./verify.js";
import type { RepoIndexEntry, SecurityFinding } from "../types.js";

process.env.SECURITY_SAMPLE = "1";

const PATH = "api/routes/payouts.ts";
const CONTENT = `export function payoutHandler(req, res) {\n  const accountId = req.body.accountId;\n}\n`;
const entry: RepoIndexEntry = {
  id: "e1", repoId: "r1", path: PATH, sha: "s1", size: 1, language: "ts", summary: "",
  exports: ["payoutHandler"], imports: [], securityFlags: [], indexedAt: 0, model: "m",
};
const ctx: ReconcileCtx = { repoId: "r1", path: PATH, sha: "s1", now: 5, model: "m", origin: {} };

async function pass(existing: SecurityFinding[] = []) {
  const detected = await scanFile({ path: PATH, content: CONTENT, engines: DEFAULT_SECURITY_POLICY.engines });
  assert.ok(detected && detected.length === 1);
  const valid: DetectedFinding[] = [];
  for (const d of detected) {
    const m = mechanicalCheck(d, CONTENT);
    if (!m.ok) valid.push(applyVerdict(d, holdVerification(m.reason, m.detail, 5)));
    else {
      const bundle = await buildEvidenceBundle({ entry, allEntries: [entry], fetch: async () => "" });
      const verdicts = await verifyFindings({ path: PATH, content: CONTENT, findings: [m.finding], bundle });
      assert.ok(verdicts);
      valid.push(applyVerdict(m.finding, verdicts[0]));
    }
  }
  return reconcileFile({ existing, detected: valid, ctx });
}

test("confirmed: the finding surfaces as 'new' with the verifier's citation and its claimed severity", async () => {
  process.env.SECURITY_VERIFY_SAMPLE = "confirmed";
  const out = await pass();
  const row = out.insert[0];
  assert.equal(out.introduced, 1);
  assert.equal(row.state, "new");
  assert.equal(row.confidence, "confirmed");
  assert.equal(row.scannerConfidence, "needs_human");
  assert.equal(row.severity, "high");
  assert.equal(row.line, 2); // the mock claims line 42; the evidence is on line 2
  assert.deepEqual(row.verification?.evidence, [{ path: PATH, line: 1, quote: "export function payoutHandler(req, res) {" }]);
});

test("refuted: the finding is held back with the refuting control on record", async () => {
  process.env.SECURITY_VERIFY_SAMPLE = "refuted";
  const out = await pass();
  assert.equal(out.introduced, 0);
  assert.equal(out.heldBack, 1);
  assert.equal(out.insert[0].state, "unverified");
  assert.equal(out.insert[0].severity, "medium");
  assert.match(out.insert[0].stateReason ?? "", /^refuted — api\/routes\/payouts\.ts:1/);
});

test("unverifiable, and a silent verifier, both hold the finding back", async () => {
  process.env.SECURITY_VERIFY_SAMPLE = "unverifiable";
  assert.equal((await pass()).insert[0].verification?.reason, "unverifiable");
  delete process.env.SECURITY_VERIFY_SAMPLE;
  const out = await pass();
  assert.equal(out.insert[0].state, "unverified");
  assert.equal(out.insert[0].verification?.reason, "no_verdict");
});

test("a held-back row surfaces once a later pass confirms it", async () => {
  process.env.SECURITY_VERIFY_SAMPLE = "refuted";
  const first = await pass();
  process.env.SECURITY_VERIFY_SAMPLE = "confirmed";
  const second = await pass(first.insert);
  assert.equal(second.insert.length, 0);
  assert.equal(second.update[0].patch.state, "new");
  assert.equal(second.introduced, 1);
});
