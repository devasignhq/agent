// Offline: retention selects by expiresAt (plan-stamped), deletes objects, marks rows expired.
//   DATABASE_URL= node --import tsx/esm --test src/verify/retention.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { selectExpiredArtifacts, sweepExpiredArtifacts } from "./retention.js";
import { RETENTION_MS, retentionExpiresAt, setArtifactStorageForTests, type ArtifactStorage } from "./storage.js";
import type { VerifyArtifact } from "../types.js";

const DAY = 24 * 60 * 60 * 1000;
const row = (over: Partial<VerifyArtifact>): VerifyArtifact =>
  ({ id: uuid(), schemaVersion: 1, runId: "r", repoId: "p", criterionIds: [], kind: "video", path: "v.webm", storageKey: `k/${uuid()}`, bytes: 1, contentType: "video/webm", state: "uploaded", expiresAt: 0, createdAt: 0, ...over });

test("free rows expire after 1 day, pro/max after 3; already-expired rows are not reselected; stranded pending rows expire too", () => {
  const signedAt = 1_700_000_000_000;
  const free = row({ expiresAt: retentionExpiresAt("free", signedAt) });
  const pro = row({ expiresAt: retentionExpiresAt("pro", signedAt) });
  const max = row({ expiresAt: retentionExpiresAt("max", signedAt) });
  const done = row({ expiresAt: signedAt, state: "expired" });
  const stranded = row({ expiresAt: retentionExpiresAt("free", signedAt), state: "pending_upload" });
  assert.equal(RETENTION_MS.free, DAY);
  assert.equal(RETENTION_MS.pro, 3 * DAY);
  const rows = [free, pro, max, done, stranded];
  assert.deepEqual(selectExpiredArtifacts(rows, signedAt + DAY - 1).map((a) => a.id), []);
  assert.deepEqual(selectExpiredArtifacts(rows, signedAt + DAY).map((a) => a.id), [free.id, stranded.id]);
  assert.deepEqual(selectExpiredArtifacts(rows, signedAt + 3 * DAY).map((a) => a.id), [free.id, pro.id, max.id, stranded.id]);
});

test("sweep deletes the object then marks the row; a failed delete keeps the row for the next sweep; no storage still marks", async () => {
  const removed: string[] = [];
  const fake: ArtifactStorage = {
    signPut: async () => ({ url: "", headers: {} }),
    signGet: async () => "",
    head: async () => null,
    remove: async (key) => {
      if (key.endsWith("/boom")) throw new Error("bucket down");
      removed.push(key);
    },
  };
  const now = Date.now();
  const ok = db.insert("verifyArtifacts", row({ storageKey: "x/ok", expiresAt: now - 1 }));
  const bad = db.insert("verifyArtifacts", row({ storageKey: "x/boom", expiresAt: now - 1 }));
  const fresh = db.insert("verifyArtifacts", row({ storageKey: "x/fresh", expiresAt: now + DAY }));
  try {
    setArtifactStorageForTests(fake);
    assert.equal(await sweepExpiredArtifacts(now), 2);
    assert.deepEqual(removed, ["x/ok"]);
    assert.equal(db.find("verifyArtifacts", (a) => a.id === ok.id)?.state, "expired");
    assert.ok(db.find("verifyArtifacts", (a) => a.id === ok.id)?.expiredAt);
    assert.equal(db.find("verifyArtifacts", (a) => a.id === bad.id)?.state, "uploaded", "kept for retry");
    assert.equal(db.find("verifyArtifacts", (a) => a.id === fresh.id)?.state, "uploaded");
    setArtifactStorageForTests(null);
    assert.equal(await sweepExpiredArtifacts(now), 1, "with no storage the row is still settled");
    assert.equal(db.find("verifyArtifacts", (a) => a.id === bad.id)?.state, "expired");
  } finally {
    setArtifactStorageForTests(undefined);
    db.remove("verifyArtifacts", (a) => [ok.id, bad.id, fresh.id].includes(a.id));
  }
});
