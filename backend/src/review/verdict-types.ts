// The review verdict shapes, split out of pipeline.ts so the pure comment/thread
// modules (items.ts, comment.ts, threads.ts) can import them without pulling in
// the 250KB pipeline — and, more importantly, without a cycle back through it.
// pipeline.ts re-exports everything here, so existing import sites are unchanged.
import { normalizeSlug } from "../security/fingerprint.js";
import type { EvidenceCode, SecuritySeverity, SuggestedChange } from "../types.js";

export type ReviewSuggestion = {
  criterionId: string;
  title: string;
  rationale: string;
  // Repo-relative file path / 1-based new-file line the suggestion anchors to,
  // for the "path/to/file.ts (Line N)" heading in the verdict comment.
  path?: string;
  line?: number;
  // Runtime-impact severity of the finding behind the suggestion. Parsed
  // leniently; absent on legacy rows and when the model omits it → "warn".
  severity?: "blocker" | "warn" | "nit";
  // Structured before/after patch — the current prompt's contract. Rendered as
  // a composed ```diff block in the verdict comment.
  patch?: SuggestedChange;
  // LEGACY: unified-diff-style snippet of the PROPOSED edit (+/- lines). The
  // current prompt requests the structured `patch` instead; kept so stored log
  // rows and old-model responses still parse/render.
  suggestedChange?: string;
  // LEGACY: complete updated function/block. The structured `patch` supersedes
  // it; kept for stored rows and old-model responses.
  codeExample?: string;
  // GitHub-flavored-markdown language identifier for `codeExample`.
  language?: string;
  // Self-contained prompt the user can paste into an external AI coding agent
  // (Cursor / Claude Code / Codex) to land the fix. Includes the relevant
  // diff hunk inline so the prompt is actionable without repo access.
  fixPrompt?: string;
};

export type ReviewVerdict = {
  summary: string;
  criteria: Array<{
    id: string;
    met: boolean;
    evidence: string;
    evidenceCode?: EvidenceCode | null;
    suggestedChange?: SuggestedChange | null;
  }>;
  comments: Array<{ path: string; line: number; body: string }>;
  suggestions: ReviewSuggestion[];
};

export type HolisticFinding = {
  path?: string;
  concern: string;
  // "nit" sits below "warn": purely advisory DEVASIGN.md findings that never
  // gate the merge and render as nitpicks. Only "blocker" gates (see the status
  // gate in runReviewJob).
  severity: "blocker" | "warn" | "nit";
  // 4-tier severity for SECURITY findings only (the Security page's model).
  // The legacy 2-tier field above is derived from it (critical → "blocker",
  // everything else → "warn") so every renderer and the verdict gate keep
  // working — and "blocker gates" now means exactly "critical gates".
  securitySeverity?: SecuritySeverity;
  // Defect pass only (reviewDiffDefects): taxonomy tag for the bug class —
  // "null-deref", "unhandled-error", "race-condition", "resource-leak",
  // "api-misuse", "data-loss", etc. Display only; nothing branches on it.
  defectClass?: string;
  // Defect pass only: concrete inputs/state -> the wrong outcome that follows.
  // REQUIRED by that pass — normaliseDefectFindings DROPS any finding without
  // one, mirroring the security agent's "no 3-step exploit narrative, no
  // finding" rule (security/agent.ts). A model that can't say what actually
  // goes wrong is speculating, and speculation must not gate a merge.
  failureScenario?: string;
  // Self-contained prompt the user can paste into an external AI coding agent
  // to land the fix. Includes the relevant diff hunk inline.
  fixPrompt?: string;
  // 1-based NEW-file line the finding anchors to, read from the diff's
  // pre-computed "N | " gutter. Absent when not tied to a single line.
  line?: number;
  // Structured before/after patch for the finding, when a single-site
  // replacement exists. Rendered as a composed ```diff block.
  suggestedChange?: SuggestedChange | null;
};

export type HolisticVerdict = {
  regressions: HolisticFinding[];
  criticalErrors: HolisticFinding[];
  securityFindings: HolisticFinding[];
  // General correctness/robustness bugs the diff introduces (reviewDiffDefects).
  // Runs on EVERY review, independent of the repo index and of whether the PR
  // has acceptance criteria — the criteria pass only judges what was asked for,
  // and a diff that satisfies every requirement can still be wrong. Gating:
  // blocker-severity defects feed hasBlocker exactly like regressions and
  // criticalErrors do (and so respect the repo's advisory-verdict mode).
  defects: HolisticFinding[];
  // Legacy advisory bucket for codebase-consistency deviations. No pass
  // currently populates it (the former spec-less pass was removed); kept so the
  // verdict shape and its renderers stay stable. Always empty today.
  consistencyFindings: HolisticFinding[];
  // Self-admitted "deferred / incomplete work" the diff's own comments concede
  // — TODOs, stubs, "for now", "deferred to a follow-up", NotImplemented, etc.
  // Detected by a separate regex-gated pass (detectDeferredWork) on both the
  // spec'd and spec-less paths. Advisory — surfaced prominently but never
  // blocks a merge (forced severity "warn"), like consistencyFindings.
  deferrals: HolisticFinding[];
  // DEVASIGN.md guidance pass (reviewAgainstDevasignDocs). `conventionFindings`
  // are rules the diff newly violates; `docDriftFindings` are DEVASIGN.md
  // statements the diff makes outdated (docs need updating). Both advisory —
  // forced severity "nit", never gate a merge. Empty when the repo has no
  // applicable DEVASIGN.md.
  conventionFindings: HolisticFinding[];
  docDriftFindings: HolisticFinding[];
  // Vulnerabilities that ALREADY exist in files this PR touches or depends on,
  // read from the repo index's stored security audit (not introduced by this
  // diff). Advisory — forced severity "warn", never gate the merge. Surfaced so
  // the author sees latent risk in the code they're working near.
  preexistingVulns: HolisticFinding[];
  // Pre-existing vulnerabilities this PR RESOLVED: stored vulns in files the PR
  // modifies that re-verification against the PR head confirmed are gone. Positive
  // confirmation that the agent saw the fix — advisory, never gates, no fixPrompt.
  // Empty when nothing was re-verified or nothing was fixed.
  resolvedPreexisting: HolisticFinding[];
  // New-commit intent review (reviewNewCommits, re-reviews only): per-commit
  // notes on whether the delta diff matches each new commit's stated intent.
  // Advisory (forced "warn") — gating happens via criteria synthesized from that
  // intent. `commitIntentSummary` is the narrative shown even when no criteria
  // changed and no findings surfaced. Empty/"" on first reviews and same-sha reruns.
  commitIntentFindings: HolisticFinding[];
  commitIntentSummary: string;
  // Cross-repo stage (Pro/Max, off by default). `crossRepoImpacts` are sibling
  // repositories this change breaks; `parityNotes` are capabilities it adds that
  // siblings lack. Both advisory — severity is forced at normalisation, and
  // neither feeds hasBlocker.
  crossRepoImpacts: HolisticFinding[];
  parityNotes: HolisticFinding[];
  summary: string;
};

export const EMPTY_HOLISTIC: HolisticVerdict = {
  regressions: [],
  criticalErrors: [],
  securityFindings: [],
  defects: [],
  consistencyFindings: [],
  deferrals: [],
  conventionFindings: [],
  docDriftFindings: [],
  preexistingVulns: [],
  resolvedPreexisting: [],
  commitIntentFindings: [],
  commitIntentSummary: "",
  crossRepoImpacts: [],
  parityNotes: [],
  summary: "",
};

// Wording-tolerant identity for a finding: same file, same substance. Two
// passes that spot the same bug phrase it differently ("returns before the
// write lands" vs "Returns before the write lands."), so raw string equality
// under-dedupes. normalizeSlug drops case and punctuation; the prefix keeps a
// shared opening clause from collapsing genuinely different findings.
//
// NOT a thread identity — normalizeSlug also strips separators and truncates,
// so deep paths can collide. items.ts keys threads on the raw path instead.
export function findingKey(f: Pick<HolisticFinding, "path" | "concern">): string {
  return `${normalizeSlug(f.path ?? "")}::${normalizeSlug(f.concern).slice(0, 80)}`;
}

// Dedupe HolisticFindings by normalized path+concern and cap the count. Two
// callers: merging the re-verified touched-file vulns with the index-driven
// dependent-file ones (reproducing collectPreexistingVulns' single-source
// dedupe+cap), and dropping defect-pass findings the holistic pass already
// reported. `against` seeds the seen-set with findings that are already being
// rendered elsewhere, so the returned list only contains what's genuinely new.
export function dedupeAndCapFindings(
  findings: HolisticFinding[],
  cap: number,
  against: HolisticFinding[] = []
): HolisticFinding[] {
  const out: HolisticFinding[] = [];
  const seen = new Set<string>(against.map(findingKey));
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= cap) break;
  }
  return out;
}
