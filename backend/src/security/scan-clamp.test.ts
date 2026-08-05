// Offline end-to-end for the confidence→severity clamp through the REAL
// scanFile path: the LLM mock's SECURITY_SAMPLE finding deliberately carries
// the forbidden pair (severity "high" + confidence "needs_human"), and
// buildFindingRows must cap it to "medium" before it can reach the DB or the
// gate. This is the regression test for the "high severity while admitting it
// wasn't verified" pattern. Uses the LLM mock (empty ANTHROPIC_API_KEY); no
// db, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= \
//     node --import tsx/esm --test src/security/scan-clamp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFile } from "./agent.js";
import { DEFAULT_SECURITY_POLICY } from "./policy.js";

// node --test runs each file in its own process, so the flag can't leak into
// other suites (where a surprise finding on every mocked scan would fail them).
process.env.SECURITY_SAMPLE = "1";

test("scanFile clamps the mock's high+needs_human sample to medium", async () => {
  const findings = await scanFile({
    path: "api/routes/payouts.ts",
    content: "export async function payoutHandler(req, res) {}\n",
    engines: DEFAULT_SECURITY_POLICY.engines,
  });
  assert.ok(findings, "mocked scan must parse, not fail");
  assert.equal(findings.length, 1);
  const f = findings[0];
  // The mock emitted severity "high" — the clamp is what made it medium.
  assert.equal(f.confidence, "needs_human");
  assert.equal(f.severity, "medium");
  assert.equal(f.slug, "mock-payout-route-missing-auth");
  assert.equal(f.exploitNarrative?.length, 3);
});
