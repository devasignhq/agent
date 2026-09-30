// The boot backfill that tags every stored finding with a proof record. In-memory db. Run:
//   DATABASE_URL= node --import tsx/esm --test src/security/migrate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { backfillProofRecords } from "./migrate.js";
import type { SecurityFinding } from "../types.js";

const row = (id: string, over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id,
  fingerprint: `fp-${id}`,
  repoId: "r1",
  path: "api/pay.ts",
  class: "missing-authz",
  surface: "api",
  severity: "high",
  confidence: "needs_human",
  title: "t",
  concern: "c",
  state: "open",
  firstDetectedAt: 1,
  lastSeenAt: 1,
  detectedSha: "blob1",
  model: "m",
  activity: [],
  ...over,
});

test("backfillProofRecords tags untagged findings once and never touches tagged ones", () => {
  const verified = {
    status: "verified" as const,
    method: "test" as const,
    blobSha: "blob1",
    engine: "proof-v1",
    updatedAt: 5,
  };
  db.insert("securityFindings", row("a"));
  db.insert("securityFindings", row("b", { proof: verified }));

  assert.equal(backfillProofRecords(42), 1);
  assert.deepEqual(db.find("securityFindings", (f) => f.id === "a")?.proof, {
    status: "untested",
    method: "test",
    engine: "proof-v1",
    updatedAt: 42,
  });
  assert.deepEqual(db.find("securityFindings", (f) => f.id === "b")?.proof, verified);
  assert.equal(backfillProofRecords(43), 0);
});
