// Artifact retention: delete expired objects and mark the rows expired (kept,
// so the UI can say "recording expired" instead of breaking). expiresAt was
// stamped from the owner's plan at sign time; the bucket lifecycle rule is the
// backstop. Same pure-selector + sweep shape as security/stale-scans.ts.
import { db } from "../db.js";
import type { VerifyArtifact } from "../types.js";
import { ARTIFACT_RETENTION_DAYS, artifactStorage } from "./storage.js";

const RETENTION = ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Rows stamped under an older, shorter retention; only ever pushes expiresAt later.
export function selectRetentionExtensions(rows: VerifyArtifact[]): VerifyArtifact[] {
  return rows.filter((a) => a.state !== "expired" && a.expiresAt < a.createdAt + RETENTION);
}

export function extendArtifactRetention(): number {
  const rows = selectRetentionExtensions(db.filter("verifyArtifacts", () => true));
  for (const a of rows) db.update("verifyArtifacts", (x) => x.id === a.id, { expiresAt: a.createdAt + RETENTION });
  if (rows.length) console.log(`[verify] retention: extended ${rows.length} artifact(s) to ${ARTIFACT_RETENTION_DAYS} days`);
  return rows.length;
}

export function selectExpiredArtifacts(rows: VerifyArtifact[], now: number): VerifyArtifact[] {
  return rows.filter((a) => a.state !== "expired" && a.expiresAt <= now);
}

export async function sweepExpiredArtifacts(now = Date.now()): Promise<number> {
  const expired = selectExpiredArtifacts(db.filter("verifyArtifacts", () => true), now);
  if (!expired.length) return 0;
  const storage = artifactStorage();
  for (const a of expired) {
    if (storage) {
      try {
        await storage.remove(a.storageKey); // a missing object is a no-op
      } catch (err) {
        console.warn(`[verify] retention: could not delete ${a.storageKey}:`, err);
        continue; // keep the row live so the next sweep retries the delete
      }
    }
    db.update("verifyArtifacts", (x) => x.id === a.id, { state: "expired", expiredAt: now });
  }
  console.log(`[verify] retention: expired ${expired.length} artifact(s)`);
  return expired.length;
}

export function startArtifactRetention(): void {
  try {
    extendArtifactRetention();
  } catch (err) {
    console.error("[verify] retention extension failed", err);
  }
  void sweepExpiredArtifacts().catch((err) => console.error("[verify] retention sweep failed", err));
  setInterval(() => void sweepExpiredArtifacts().catch((err) => console.error("[verify] retention sweep failed", err)), 60 * 60_000);
}
