// The audit agent's learned corpus: what a maintainer ruled about a finding,
// carried forward into later scans. Pure module — no db, no network — so the
// matching rules are testable offline, same as severity.ts and fingerprint.ts.
//
// A ruling reaches the agent through two channels, and keeping them separate is
// the whole safety story of this feature:
//
//   1. HARD — a tight re-match auto-suppresses the finding before a human ever
//      sees it. Narrow by construction: same repo, same class, and same file or
//      same symbol. Never fires on an account-scoped ruling, and never on class
//      alone ("missing-authz" covers hundreds of real bugs; muting the class
//      because one instance was wrong is the catastrophic version of this).
//   2. SOFT — the ruling text is injected into the scan prompt as evidence
//      about this codebase. The model may still report if the situation here
//      genuinely differs. This is where generalization is allowed to happen,
//      because the model can overrule it and a human still sees the result.
import { v4 as uuid } from "uuid";
import type { SecurityPrecedent, SecurityRulingCode } from "../types.js";
import { normalizeSlug } from "./fingerprint.js";

// Codes that carry a lesson. The rest are still recorded on the finding (they
// are useful triage history) but never become precedent:
//   out_of_scope -> belongs in path selection, not in a prompt
//   duplicate    -> a link between two findings, not a claim about the code
//   accepted_cost-> a business decision; the agent was right and should keep saying so
export const TEACHABLE: ReadonlySet<SecurityRulingCode> = new Set<SecurityRulingCode>([
  "control_exists",
  "not_reachable",
  "misread_code",
  "by_design",
  "compensating_control",
]);

// Which suppressed state a code belongs to. "The agent was wrong" and "the
// agent was right and we accept it" are different claims and must not blur:
// only the first is a correction.
const ACCEPTED_CODES: ReadonlySet<SecurityRulingCode> = new Set<SecurityRulingCode>([
  "by_design",
  "compensating_control",
  "accepted_cost",
]);

export function actionForCode(code: SecurityRulingCode): "false_positive" | "accepted" {
  return ACCEPTED_CODES.has(code) ? "accepted" : "false_positive";
}

// Every code the API will accept, and the guard that stops a client pairing a
// code with the wrong button — "by_design" filed as a false positive would
// record the agent as having been wrong when it was right.
export const RULING_CODES: ReadonlySet<SecurityRulingCode> = new Set<SecurityRulingCode>([
  "control_exists",
  "not_reachable",
  "misread_code",
  "out_of_scope",
  "duplicate",
  "by_design",
  "compensating_control",
  "accepted_cost",
]);

export function codeFitsAction(code: SecurityRulingCode, action: "false_positive" | "accepted"): boolean {
  return actionForCode(code) === action;
}

export function isTeachable(code: SecurityRulingCode): boolean {
  return TEACHABLE.has(code);
}

// A generic symbol ("handler", "run") carries no identity, so symbol-based
// matching across files needs a floor before it is trustworthy.
const MIN_SYMBOL_LEN = 4;

// Budget for the injected block: enough rulings to be useful, never enough to
// crowd out the file content the model is actually supposed to audit.
export const MAX_INJECTED = 12;
export const MAX_INJECTED_CHARS = 2500;

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

// Mint a precedent from a maintainer's ruling, or null when the ruling isn't
// one. Two gates: the code must be teachable, and the note must be non-empty.
// A correction with no rationale gives the model nothing to reason with — it
// would read as "stay quiet about this", which is exactly what we're avoiding.
export function precedentFromRuling(args: {
  code: SecurityRulingCode;
  note: string;
  scope: "repo" | "account";
  ownerUserId: string;
  repoId: string;
  createdBy: string;
  now: number;
  engine: string;
  finding: {
    id: string;
    class: string;
    path: string;
    symbol?: string;
    evidence?: string;
    detectedSha: string;
    // The model's stable_key isn't stored separately on the row; the title is
    // the same fallback fingerprintFinding() uses.
    title: string;
  };
}): SecurityPrecedent | null {
  if (!isTeachable(args.code)) return null;
  const note = String(args.note || "").trim().slice(0, 500);
  if (!note) return null;
  const f = args.finding;
  return {
    id: uuid(),
    ownerUserId: args.ownerUserId,
    repoId: args.repoId,
    scope: args.scope,
    code: args.code,
    action: actionForCode(args.code),
    note,
    class: f.class,
    slug: f.title.slice(0, 120),
    path: f.path,
    ...(f.symbol ? { symbol: f.symbol } : {}),
    originFindingId: f.id,
    anchorSha: f.detectedSha,
    ...(f.evidence ? { anchorEvidence: f.evidence.slice(0, 1000) } : {}),
    engineAtCreation: args.engine,
    createdAt: args.now,
    createdBy: args.createdBy,
    status: "active",
    statusReason: null,
    suppressedCount: 0,
    lastAppliedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

// Strip the line-number gutter the agent quotes with ("42: const x = 1") and
// collapse inner whitespace, so a reindent doesn't read as the code having
// moved. Line breaks are preserved: matching is done a line at a time.
function normalizeLine(line: string): string {
  return line.replace(/^\s*\d+\s*[:|]\s?/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeBlock(text: string): string {
  return text.split("\n").map(normalizeLine).join("\n");
}

// Does the code this ruling was made against still look the same?
//
// A ruling is only as true as the lines it was made about. When the agent had
// quoted evidence we check for that text directly, which tolerates edits
// elsewhere in the file — the common case, and the reason a bare sha compare
// would retire almost every precedent on the next unrelated commit. Without
// evidence we can only fall back to the sha.
export function anchorHolds(
  p: Pick<SecurityPrecedent, "anchorEvidence" | "anchorSha">,
  file: { sha: string; content: string }
): boolean {
  if (!p.anchorEvidence) return file.sha === p.anchorSha;
  const haystack = normalizeBlock(file.content);
  // Any one substantive quoted line surviving is enough: the agent often quotes
  // a line or two of context around the decisive one. Short lines ("});") are
  // dropped — they match everywhere and would keep a dead ruling alive.
  const lines = normalizeBlock(p.anchorEvidence)
    .split("\n")
    .filter((s) => s.length >= 12);
  if (!lines.length) return file.sha === p.anchorSha;
  return lines.some((l) => haystack.includes(l));
}

// ---------------------------------------------------------------------------
// Matching — the HARD channel
// ---------------------------------------------------------------------------

export type MatchTarget = { class: string; slug?: string; symbol?: string };

// Find the ruling that authorises auto-suppressing this detection, if any.
//
// Deliberately narrow. Everything here is an AND:
//   - the ruling is live (a needs_reconfirm ruling informs but never mutes);
//   - it is repo-scoped and belongs to THIS repo — account rulings are prompt
//     -only, so an architectural fact can never silently mute an unrelated repo;
//   - the vulnerability class is the same;
//   - and it is the same file, or the same named symbol.
export function matchPrecedent(
  target: MatchTarget,
  corpus: SecurityPrecedent[],
  where: { repoId: string; path: string }
): SecurityPrecedent | null {
  const cls = normalizeSlug(target.class);
  if (!cls) return null;
  const sym = target.symbol ? normalizeSlug(target.symbol) : "";
  for (const p of corpus) {
    if (p.status !== "active") continue;
    if (p.scope !== "repo") continue;
    if (p.repoId !== where.repoId) continue;
    if (normalizeSlug(p.class) !== cls) continue;
    if (p.path === where.path) return p;
    const pSym = p.symbol ? normalizeSlug(p.symbol) : "";
    if (pSym && sym && pSym.length >= MIN_SYMBOL_LEN && pSym === sym) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection + rendering — the SOFT channel
// ---------------------------------------------------------------------------

// Relevance of a ruling to the file about to be scanned. Chosen pre-scan, so
// the finding's class isn't known yet — only location and scope can rank.
function relevance(p: SecurityPrecedent, path: string): number {
  if (p.path === path) return 100;
  if (dirOf(p.path) === dirOf(path)) return 60;
  if (p.scope === "account") return 40; // promoted as architectural — travels by design
  return 10;
}

// The rulings worth showing the model for this file, most relevant first.
// needs_reconfirm rulings are still included: the context ("we believed auth
// was in middleware here") remains useful even once it stops auto-suppressing.
export function selectPrecedents(
  corpus: SecurityPrecedent[],
  where: { repoId: string; path: string }
): SecurityPrecedent[] {
  const eligible = corpus.filter(
    (p) => p.status !== "revoked" && (p.repoId === where.repoId || p.scope === "account")
  );
  return eligible
    .map((p) => ({ p, score: relevance(p, where.path) }))
    .sort((a, b) => b.score - a.score || b.p.createdAt - a.p.createdAt)
    .slice(0, MAX_INJECTED)
    .map((x) => x.p);
}

const CODE_PHRASE: Record<SecurityRulingCode, string> = {
  control_exists: "the control exists elsewhere",
  not_reachable: "not reachable by untrusted input",
  misread_code: "the agent misread the code",
  out_of_scope: "out of scope (vendored/generated)",
  duplicate: "duplicate of another finding",
  by_design: "intentional, by design",
  compensating_control: "mitigated outside the code",
  accepted_cost: "accepted risk",
};

// Render the rulings as a labelled block for the scan prompt's USER message.
// It must not go in the system prompt: that is sent with cacheSystem:true and
// has to stay one global constant, or the prompt cache keys per account.
export function renderPrecedentBlock(list: SecurityPrecedent[]): string {
  if (!list.length) return "";
  const lines: string[] = [];
  let budget = MAX_INJECTED_CHARS;
  for (const p of list) {
    const verdict = p.action === "accepted" ? "accepted the risk" : "ruled this a false positive";
    const stale = p.status === "needs_reconfirm" ? " [the code has since changed — weigh with care]" : "";
    const where = p.scope === "account" ? "elsewhere in this account" : p.path;
    const line =
      `- In ${where}, a maintainer ${verdict} for "${p.class}" ` +
      `(${CODE_PHRASE[p.code]}): ${p.note}${stale}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return `Prior maintainer rulings on this codebase:\n${lines.join("\n")}`;
}
