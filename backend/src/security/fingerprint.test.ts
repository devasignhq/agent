// Unit tests for the finding fingerprint + surface classification. The
// fingerprint is the identity that lets triage state survive re-scans, so the
// invariants under test are stability (wording/line changes don't move it) and
// separation (different issues don't collide). No db / network / LLM. Run:
//   node --import tsx/esm --test src/security/fingerprint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySurface, classifySurfaceFor, fingerprintFinding, normalizeSlug } from "./fingerprint.js";

test("fingerprint: stable across slug rewording and case", () => {
  const a = fingerprintFinding({ repoId: "r1", path: "api/pay.ts", class: "missing-authz", slug: "Payout route missing auth" });
  const b = fingerprintFinding({ repoId: "r1", path: "api/pay.ts", class: "missing-authz", slug: "payout-route-missing-auth!" });
  assert.equal(a, b);
});

test("fingerprint: symbol wins over slug when present — a retitle can't move it", () => {
  const a = fingerprintFinding({ repoId: "r1", path: "api/pay.ts", class: "missing-authz", slug: "one title", symbol: "createPayout" });
  const b = fingerprintFinding({ repoId: "r1", path: "api/pay.ts", class: "missing-authz", slug: "completely different", symbol: "createPayout" });
  assert.equal(a, b);
});

test("fingerprint: differs across repo, path, and class", () => {
  const base = { repoId: "r1", path: "api/pay.ts", class: "missing-authz", slug: "s" };
  assert.notEqual(fingerprintFinding(base), fingerprintFinding({ ...base, repoId: "r2" }));
  assert.notEqual(fingerprintFinding(base), fingerprintFinding({ ...base, path: "api/other.ts" }));
  assert.notEqual(fingerprintFinding(base), fingerprintFinding({ ...base, class: "sql-injection" }));
});

test("fingerprint: two different vulns in the same symbol stay distinct (class separates)", () => {
  const a = fingerprintFinding({ repoId: "r", path: "p", class: "sql-injection", slug: "x", symbol: "runQuery" });
  const b = fingerprintFinding({ repoId: "r", path: "p", class: "missing-authz", slug: "x", symbol: "runQuery" });
  assert.notEqual(a, b);
});

test("normalizeSlug strips everything but alphanumerics", () => {
  assert.equal(normalizeSlug("Fix: The-Thing (v2)!"), "fixthethingv2");
});

test("classifySurface: deps manifests, infra, frontend, api fallback", () => {
  assert.equal(classifySurface("package.json"), "deps");
  assert.equal(classifySurface("backend/go.mod"), "deps");
  assert.equal(classifySurface("infra/main.tf"), "infra");
  assert.equal(classifySurface(".github/workflows/ci.yml"), "infra");
  assert.equal(classifySurface("Dockerfile"), "infra");
  assert.equal(classifySurface("frontend/src/app.tsx"), "frontend");
  assert.equal(classifySurface("web/components/x.vue"), "frontend");
  assert.equal(classifySurface("backend/src/routes/api.ts"), "api");
});

test("classifySurfaceFor: a secret class overrides the structural surface", () => {
  assert.equal(classifySurfaceFor("frontend/src/app.tsx", "hardcoded-secret"), "secrets");
  assert.equal(classifySurfaceFor("frontend/src/app.tsx", "xss"), "frontend");
});
