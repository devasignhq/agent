// Unit tests for the 4-tier severity model and its mapping onto the review
// pipeline's legacy 2-tier gate ("blocker gates" ⇔ "critical gates"). Also
// covers normaliseSecurityFindings, the pipeline-side shaper. Run:
//   node --import tsx/esm --test src/security/severity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfidence, normalizeSeverity, severityRank, severityToLegacy } from "./severity.js";
import { normaliseSecurityFindings } from "../review/pipeline.js";

test("normalizeSeverity: 4-tier passthrough, legacy mapping, junk → medium", () => {
  assert.equal(normalizeSeverity("critical"), "critical");
  assert.equal(normalizeSeverity("HIGH"), "high");
  assert.equal(normalizeSeverity("blocker"), "critical"); // legacy blockers were direct-exploit only
  assert.equal(normalizeSeverity("warn"), "medium");
  assert.equal(normalizeSeverity("banana"), "medium");
  assert.equal(normalizeSeverity(undefined), "medium");
});

test("severityToLegacy: only critical maps to the gating 'blocker'", () => {
  assert.equal(severityToLegacy("critical"), "blocker");
  assert.equal(severityToLegacy("high"), "warn");
  assert.equal(severityToLegacy("medium"), "warn");
  assert.equal(severityToLegacy("low"), "warn");
});

test("severityRank orders critical → low", () => {
  assert.ok(severityRank("critical") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("low"));
});

test("normalizeConfidence clamps to the enum with needs_human default", () => {
  assert.equal(normalizeConfidence("confirmed"), "confirmed");
  assert.equal(normalizeConfidence("probable"), "probable");
  assert.equal(normalizeConfidence("definitely"), "needs_human");
});

test("normaliseSecurityFindings: 4-tier severity derives the legacy field; only critical gates", () => {
  const out = normaliseSecurityFindings([
    { concern: "auth bypass", severity: "critical", path: "a.ts", fixPrompt: "fix" },
    { concern: "weak header", severity: "low" },
    { concern: "legacy blocker", severity: "blocker" },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].severity, "blocker");
  assert.equal(out[0].securitySeverity, "critical");
  assert.equal(out[1].severity, "warn");
  assert.equal(out[1].securitySeverity, "low");
  // Legacy "blocker" from an old prompt still gates.
  assert.equal(out[2].severity, "blocker");
  assert.equal(out[2].securitySeverity, "critical");
});

test("normaliseSecurityFindings drops empty concerns and tolerates junk", () => {
  assert.equal(normaliseSecurityFindings([{ concern: "" }, null, 42]).length, 0);
  assert.equal(normaliseSecurityFindings("nope").length, 0);
});
