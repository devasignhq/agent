// Worker-chokepoint plan gate for the security audit. runSecurityAudit must
// refuse a free/lapsed owner's repo no matter which path enqueued it (manual
// re-scan, merge webhook, nightly sweep), and must complete the run row rather
// than wedge it in "queued". The gate short-circuits before the repo-index read
// and every LLM/GitHub call, so this runs fully offline. Run:
//   node --import tsx/esm --test src/security/plan-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { runSecurityAudit } from "./audit.js";

// A repo owned by `plan`, with one security-flagged index entry that a running
// audit would otherwise scan, plus a queued run row.
function fixture(plan: string, status: string | null) {
  const userId = uuid();
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan,
    status,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
  } as any);
  const install = db.insert("installations", {
    id: uuid(),
    installationId: 4242,
    userId,
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
    private: false,
    reviewsEnabled: true,
  } as any);
  db.insert("repoIndex", {
    id: uuid(),
    repoId: repo.id,
    path: "src/api/auth.ts",
    sha: "abc123",
    securityFlags: ["auth"],
  } as any);
  const run = db.insert("securityScans", {
    id: uuid(),
    repoId: repo.id,
    trigger: "manual",
    full: true,
    status: "queued",
    startedAt: Date.now(),
    filesScanned: 0,
    cacheHits: 0,
    introduced: 0,
    resolved: 0,
    stillOpen: 0,
    log: [],
  } as any);
  return { repo, run };
}

test("runSecurityAudit no-ops for a free-plan owner", async () => {
  const { repo, run } = fixture("free", null);

  // Resolves immediately — the gate returns before withUsage/fetchBlob, so no
  // network or LLM is touched.
  await runSecurityAudit({ repoId: repo.id, scanRunId: run.id, trigger: "manual", full: true });

  const after = db.find("securityScans", (s) => s.id === run.id);
  assert.equal(after?.status, "completed"); // never left wedged in "queued"
  assert.equal(after?.filesScanned, 0);
  assert.ok(after?.log.some((l: { line: string }) => /Pro\/Max feature/.test(l.line)));
  assert.equal(db.filter("securityFindings", (f) => f.repoId === repo.id).length, 0);
});

test("runSecurityAudit no-ops for a lapsed paid sub", async () => {
  const { repo, run } = fixture("pro", "canceled");

  await runSecurityAudit({ repoId: repo.id, scanRunId: run.id, trigger: "nightly", full: true });

  const after = db.find("securityScans", (s) => s.id === run.id);
  assert.equal(after?.status, "completed");
  assert.ok(after?.log.some((l: { line: string }) => /Pro\/Max feature/.test(l.line)));
});
