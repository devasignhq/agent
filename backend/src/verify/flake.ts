// Flake tracking per test signature. A flaky test never produces a `fail`; it is
// quarantined, regenerated with a different strategy, and retired after RETIRE_AFTER.
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { TestFlakeHistory } from "../types.js";
import type { TestLevel } from "./contract.js";

export const RETIRE_AFTER = 3;

export function testSignature(criterionText: string, level: TestLevel, targetFiles: string[]): string {
  const norm = criterionText.trim().toLowerCase().replace(/\s+/g, " ");
  const files = [...new Set(targetFiles.map((f) => f.trim()))].sort().join(",");
  return createHash("sha256").update(`${norm}\n${level}\n${files}`).digest("hex").slice(0, 32);
}

export function flakeRow(repoId: string, signature: string): TestFlakeHistory | null {
  return db.find("testFlakeHistory", (r) => r.repoId === repoId && r.testSignature === signature);
}

export function isRetired(row: TestFlakeHistory | null | undefined): boolean {
  return !!row && (row.retiredAt != null || row.flakeCount >= RETIRE_AFTER);
}

export function isQuarantined(row: TestFlakeHistory | null | undefined): boolean {
  return !!row && row.quarantinedAt != null && !isRetired(row);
}

export function latestStrategyVersion(row: TestFlakeHistory | null | undefined): number {
  if (!row || !row.history.length) return 1;
  return row.history[row.history.length - 1].strategyVersion;
}

export function recordFlakeOutcome(input: {
  repoId: string;
  signature: string;
  runId: string;
  outcome: "pass" | "fail" | "flaky" | "error";
  strategyVersion: number;
  criterionText?: string;
  level?: TestLevel;
  targetFiles?: string[];
  now?: number;
}): TestFlakeHistory {
  const now = input.now ?? Date.now();
  const entry = { runId: input.runId, outcome: input.outcome, strategyVersion: input.strategyVersion, at: now };
  const existing = flakeRow(input.repoId, input.signature);
  if (!existing) {
    return db.insert("testFlakeHistory", {
      id: uuid(),
      schemaVersion: 1,
      repoId: input.repoId,
      testSignature: input.signature,
      history: [entry],
      flakeCount: input.outcome === "flaky" ? 1 : 0,
      quarantinedAt: input.outcome === "flaky" ? now : null,
      retiredAt: null,
      criterionText: input.criterionText,
      level: input.level,
      targetFiles: input.targetFiles,
      updatedAt: now,
    });
  }
  const flakeCount = existing.flakeCount + (input.outcome === "flaky" ? 1 : 0);
  const patch: Partial<TestFlakeHistory> = {
    history: [...existing.history, entry].slice(-50),
    flakeCount,
    updatedAt: now,
    ...(input.criterionText ? { criterionText: input.criterionText } : {}),
    ...(input.level ? { level: input.level } : {}),
    ...(input.targetFiles ? { targetFiles: input.targetFiles } : {}),
  };
  if (input.outcome === "flaky") patch.quarantinedAt = now;
  // A stable pass at a NEW strategy lifts the quarantine; the count is kept.
  if (input.outcome === "pass" && existing.quarantinedAt != null && input.strategyVersion > latestStrategyVersion(existing)) {
    patch.quarantinedAt = null;
  }
  if (flakeCount >= RETIRE_AFTER && existing.retiredAt == null) patch.retiredAt = now;
  return db.update("testFlakeHistory", (r) => r.id === existing.id, patch) ?? existing;
}

/** Rows whose recorded criterion text matches — what the planner reads before generating. */
export function flakeRowsForCriterion(repoId: string, criterionText: string): TestFlakeHistory[] {
  const norm = criterionText.trim().toLowerCase().replace(/\s+/g, " ");
  return db.filter(
    "testFlakeHistory",
    (r) => r.repoId === repoId && (r.criterionText || "").trim().toLowerCase().replace(/\s+/g, " ") === norm
  );
}

/** One pass for many repos (GET /api/repositories attaches this per card). */
export function repoFlakeRates(repoIds: Set<string>, lastRuns = 30): Map<string, { rate: number; flaky: number; total: number }> {
  const runsByRepo = new Map<string, string[]>();
  for (const r of db.filter("verifyRuns", (r) => repoIds.has(r.repoId) && r.status === "completed").sort((a, b) => b.createdAt - a.createdAt)) {
    const list = runsByRepo.get(r.repoId) ?? [];
    if (list.length < lastRuns) list.push(r.id);
    runsByRepo.set(r.repoId, list);
  }
  const out = new Map<string, { rate: number; flaky: number; total: number }>();
  for (const [repoId, ids] of runsByRepo) {
    const idSet = new Set(ids);
    let total = 0;
    let flaky = 0;
    for (const row of db.filter("testFlakeHistory", (t) => t.repoId === repoId)) {
      for (const h of row.history) {
        if (!idSet.has(h.runId)) continue;
        total += 1;
        if (h.outcome === "flaky") flaky += 1;
      }
    }
    out.set(repoId, { rate: total ? flaky / total : 0, flaky, total });
  }
  return out;
}

/** Repo flake rate over the last N runs: quarantined generated tests / generated tests. */
export function repoFlakeRate(repoId: string, lastRuns = 30): { rate: number; flaky: number; total: number } {
  const runIds = db
    .filter("verifyRuns", (r) => r.repoId === repoId && r.status === "completed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, lastRuns)
    .map((r) => r.id);
  const ids = new Set(runIds);
  let total = 0;
  let flaky = 0;
  for (const row of db.filter("testFlakeHistory", (r) => r.repoId === repoId)) {
    for (const h of row.history) {
      if (!ids.has(h.runId)) continue;
      total += 1;
      if (h.outcome === "flaky") flaky += 1;
    }
  }
  return { rate: total ? flaky / total : 0, flaky, total };
}
