// Severity model for the security audit agent (4-tier, ranked by blast
// radius per the audit contract) plus the mapping onto the review pipeline's
// legacy 2-tier gate. Pure module — no imports beyond types — so it is
// testable offline and safe to use from both the pipeline and the agent.
import type { SecurityConfidence, SecuritySeverity } from "../types.js";

// Highest first. Used for sorting and for "worst of" reductions.
export const SEVERITY_ORDER: SecuritySeverity[] = ["critical", "high", "medium", "low"];

const RANK: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function severityRank(sev: SecuritySeverity): number {
  return RANK[sev] ?? RANK.medium;
}

// Coerce arbitrary model/legacy output into the 4-tier enum. Legacy 2-tier
// values map conservatively: "blocker" was only ever emitted for directly
// exploitable, diff-introduced issues → "critical"; "warn" → "medium".
// Unknown input defaults to "medium" (visible but not gate-flipping).
export function normalizeSeverity(input: unknown): SecuritySeverity {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  if (s === "blocker" || s === "crit") return "critical";
  if (s === "warn" || s === "warning" || s === "med" || s === "moderate") return "medium";
  return "medium";
}

// The review pipeline's holistic findings keep their 2-tier severity (every
// renderer and the verdict gate key off it). Only "critical" gates — so the
// existing `severity === "blocker"` checks become exactly "critical gates".
export function severityToLegacy(sev: SecuritySeverity): "blocker" | "warn" {
  return sev === "critical" ? "blocker" : "warn";
}

export function normalizeConfidence(input: unknown): SecurityConfidence {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "confirmed") return "confirmed";
  if (s === "probable") return "probable";
  return "needs_human";
}
