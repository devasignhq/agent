// Resolve a pull request to the bounty it delivers. A PR targets a bounty when it
// uses a GitHub closing keyword ("closes #7", "fixes #7", …) referencing the
// bounty's issue number in the same repo. Pure + synchronous.
import { db } from "../db.js";
import type { Bounty } from "../types.js";

const ACTIVE = new Set(["OPEN", "DELEGATED", "IN_REVIEW"]);

// GitHub's closing keywords: close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+#(\d+)/gi;

/** Issue numbers a PR body says it closes. */
export function closingIssueNumbers(prBody: string): number[] {
  const out: number[] = [];
  for (const m of (prBody || "").matchAll(CLOSING)) {
    const n = Number(m[1]);
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

/** The active bounty a PR delivers (by repo + closing-keyword issue ref), or null. */
export function resolveBountyForPR(
  repoFullName: string,
  prBody: string,
  explicitIssueNumber?: number
): Bounty | null {
  const active = db.filter(
    "bounties",
    (b) => b.repo === repoFullName && ACTIVE.has(b.status)
  );
  if (!active.length) return null;
  const refs = new Set(closingIssueNumbers(prBody));
  if (typeof explicitIssueNumber === "number") refs.add(explicitIssueNumber);
  return active.find((b) => refs.has(b.issueNumber)) ?? null;
}
