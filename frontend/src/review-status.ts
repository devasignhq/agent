// Pure view logic for PR review status: backend status + PR lifecycle → the pill
// the UI renders, and whether the review agent still takes messages. Extracted
// from screen-agent.tsx (which is @ts-nocheck) so it is type-checked and
// `node --test` can drive it offline — no React, no DOM. Cf. verify-view.ts.
import type { PRReviewStatus, PRState } from "./api.ts";

// `cls` is a .pill modifier in styles.css; "" is the bare gray outline.
export type PillSpec = { cls: string; label: string; pulse: boolean };

// Lifecycle beats verdict: merged and closed read gray, whatever the review
// concluded. Verdict tiers: passed green, changes_requested amber, blocked and
// errored red — errored is red but says so, rather than posing as a verdict.
const VERDICT_PILL: Record<PRReviewStatus, PillSpec> = {
  queued: { cls: "", label: "queued", pulse: false },
  reviewing: { cls: "info", label: "running", pulse: true },
  passed: { cls: "ok", label: "approved", pulse: false },
  changes_requested: { cls: "warn", label: "change requested", pulse: false },
  blocked: { cls: "danger", label: "blocked", pulse: false },
  errored: { cls: "danger", label: "errored", pulse: false },
};

const MERGED: PillSpec = { cls: "nit", label: "merged", pulse: false };
const CLOSED: PillSpec = { cls: "nit", label: "closed", pulse: false };

// Total over unknown input: the queue renders this straight into `s.cls`, so an
// unmapped status must degrade to a pill rather than throw and blank the list.
export function verdictBadge(status: PRReviewStatus): PillSpec {
  return VERDICT_PILL[status] ?? VERDICT_PILL.queued;
}

export function queueBadge(status: PRReviewStatus, prState?: PRState): PillSpec {
  if (prState === "merged") return MERGED;
  if (prState === "closed") return CLOSED;
  return verdictBadge(status);
}

export function isTerminalPrState(prState?: PRState): boolean {
  return prState === "merged" || prState === "closed";
}

export function canMessageAgent(prState?: PRState): boolean {
  return !isTerminalPrState(prState);
}

export function composerLockReason(prState?: PRState): string | null {
  if (prState === "merged") return "PR merged — messaging closed";
  if (prState === "closed") return "PR closed — messaging closed";
  return null;
}

export function composerLockPlaceholder(prState?: PRState): string | null {
  if (!isTerminalPrState(prState)) return null;
  const what = prState === "merged" ? "merged" : "closed";
  return `This pull request is ${what} — the review agent is no longer taking messages.`;
}

// The sidebar dot's 3-value union, persisted in localStorage — deliberately not
// widened. A finished PR is "ok" however it ended; only red tiers are blockers.
export function recentFlag(status: PRReviewStatus, prState?: PRState): "blocker" | "review" | "ok" {
  if (isTerminalPrState(prState)) return "ok";
  if (status === "blocked" || status === "errored") return "blocker";
  return status === "changes_requested" ? "review" : "ok";
}
