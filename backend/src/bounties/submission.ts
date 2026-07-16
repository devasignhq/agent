// Pure validation for the contributor app's explicit "submit work" flow: the
// PR-URL parse, the state/identity preconditions, and supporting-link
// sanitization. No I/O — the route layer owns the GitHub verification call and
// the state transition, so all of this unit-tests offline (house style).
import type { Bounty, SupportingLink } from "../types.js";

// Only a canonical GitHub PR URL is accepted — the contributor pastes the link
// straight from the PR page. Owner/repo per GitHub's naming rules; the number
// must be all digits. Trailing slash tolerated; query/fragment rejected.
const PR_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/;

export function parsePrUrl(raw: unknown): { repo: string; prNumber: number } | null {
  if (typeof raw !== "string") return null;
  const m = PR_URL_RE.exec(raw.trim());
  if (!m) return null;
  const prNumber = Number(m[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { repo: `${m[1]}/${m[2]}`, prNumber };
}

export type SubmissionCheck = { ok: true } | { ok: false; reason: string };

/**
 * State + identity preconditions for a submission. The caller (route) has
 * already resolved the session user; GitHub-side verification (PR exists,
 * author is the assignee) happens after this passes.
 */
export function validateSubmission(
  bounty: Bounty,
  user: { githubId: number | null },
  parsed: { repo: string; prNumber: number }
): SubmissionCheck {
  if (bounty.status !== "DELEGATED" && bounty.status !== "IN_REVIEW") {
    return { ok: false, reason: `bad_status_${bounty.status.toLowerCase()}` };
  }
  if (user.githubId == null || bounty.assigneeGithubId !== user.githubId) {
    return { ok: false, reason: "not_assignee" };
  }
  if (parsed.repo.toLowerCase() !== bounty.repo.toLowerCase()) {
    return { ok: false, reason: "wrong_repo" };
  }
  return { ok: true };
}

// Supporting links: http(s) only, capped in count and length, labels trimmed to
// a short display string. Silently drops invalid entries rather than failing
// the whole submission — links are supplementary evidence, not the deliverable.
export const MAX_LINKS = 8;
export const MAX_URL_LENGTH = 2000;
export const MAX_TYPE_LENGTH = 40;

export function sanitizeLinks(raw: unknown, now: number = Date.now()): SupportingLink[] {
  if (!Array.isArray(raw)) return [];
  const out: SupportingLink[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_LINKS) break;
    if (!entry || typeof entry !== "object") continue;
    const url = typeof (entry as any).url === "string" ? (entry as any).url.trim() : "";
    if (!url || url.length > MAX_URL_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const type =
      (typeof (entry as any).type === "string" ? (entry as any).type.trim() : "").slice(0, MAX_TYPE_LENGTH) ||
      "Link";
    out.push({ type, url, addedAt: now });
  }
  return out;
}
