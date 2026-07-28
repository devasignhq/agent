// One-shot backfill of the legacy index-embedded Vulnerability rows into the
// first-class securityFindings collection. Runs at boot (after initDb) and is
// idempotent: an already-present fingerprint is skipped, so restarts are free.
//
// Severity mapping is deliberately conservative — blocker→high, warn→medium —
// because legacy findings were never human-triaged and mapping blockers to
// "critical" would fail merge gates on every repo the moment the feature
// ships. The first real audit run re-derives severity on matched fingerprints.
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { SecurityFinding } from "../types.js";
import { classifySurfaceFor, fingerprintFinding } from "./fingerprint.js";

export function backfillLegacyVulnerabilities(): number {
  const existing = new Set(db.table("securityFindings").map((f) => f.fingerprint));
  let migrated = 0;
  for (const entry of db.table("repoIndex")) {
    for (const v of entry.vulnerabilities ?? []) {
      const fingerprint = fingerprintFinding({
        repoId: entry.repoId,
        path: v.path,
        class: v.class,
        slug: v.concern,
        symbol: v.symbol,
      });
      if (existing.has(fingerprint)) continue;
      existing.add(fingerprint);
      const row: SecurityFinding = {
        id: uuid(),
        fingerprint,
        repoId: entry.repoId,
        path: v.path,
        ...(v.line != null ? { line: v.line } : {}),
        ...(v.symbol ? { symbol: v.symbol } : {}),
        class: v.class,
        surface: classifySurfaceFor(v.path, v.class),
        severity: v.severity === "blocker" ? "high" : "medium",
        confidence: "needs_human",
        title: `[${v.class}] ${v.path.split("/").pop() || v.path}`,
        concern: v.concern,
        ...(v.fixPrompt ? { remediation: v.fixPrompt } : {}),
        state: "open",
        firstDetectedAt: v.detectedAt,
        lastSeenAt: v.detectedAt,
        detectedSha: v.detectedSha,
        model: v.model,
        activity: [
          {
            at: v.detectedAt,
            kind: "detected",
            detail: "Migrated from the index-time security scan",
            actor: "audit-agent",
          },
        ],
      };
      db.insert("securityFindings", row);
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[security] migrated ${migrated} legacy vulnerabilities into securityFindings`);
  }
  return migrated;
}
