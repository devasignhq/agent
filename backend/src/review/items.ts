// One normalized shape for everything the review can say about a PR — every
// acceptance criterion and every finding, from every stage — so the comment
// renderer and the thread reconciler have a single list to work from instead of
// twelve hand-written per-bucket blocks.
//
// Pure — no db / network / LLM:
//   node --import tsx/esm --test src/review/items.test.ts
import { normalizeSlug } from "../security/fingerprint.js";
import { sameFinding, type FindingIdentity } from "./identity.js";
import type { Criterion, EvidenceCode, SecuritySeverity, SuggestedChange } from "../types.js";
import { splitForComment, type PriorVerdict } from "./criteria-format.js";
import type { ScoreKind } from "./score.js";
import type { HolisticFinding, HolisticVerdict, ReviewSuggestion } from "./verdict-types.js";

// Which review pass produced an item. Load-bearing for reconciliation: a thread
// whose stage did not run this time is left alone rather than being read as
// "fixed" (a toggled-off or thrown stage is not evidence of anything).
export type ReviewStage =
  | "criteria"
  | "holistic"
  | "security"
  | "defects"
  | "deferrals"
  | "docs"
  | "commitIntent"
  | "crossRepo";

export type ReviewItemCategory =
  | "criterion"
  | "regression"
  | "criticalError"
  | "defect"
  | "security"
  | "commitIntent"
  | "deferral"
  | "convention"
  | "docDrift"
  | "crossRepo"
  | "parity"
  | "lineNote";

export type ReviewItem = {
  // Stable across runs — the thread identity. See itemKey.
  key: string;
  category: ReviewItemCategory;
  stage: ReviewStage;
  // "met" items are satisfied criteria: they still get a thread (so the reader
  // can see what passed) but carry no fix prompt and cost nothing on the score.
  state: "open" | "met";
  scoreKind: ScoreKind;
  severity: "blocker" | "warn" | "nit";
  securitySeverity?: SecuritySeverity;
  // Short label for the thread heading and the card's overflow lists.
  title: string;
  concern: string;
  path?: string;
  line?: number;
  criterionId?: string;
  criterionText?: string;
  // Why a criterion isn't met / the failure a finding produces.
  reason?: string;
  defectClass?: string;
  failureScenario?: string;
  evidenceCode?: EvidenceCode | null;
  suggestedChange?: SuggestedChange | null;
  fixPrompt?: string;
  // Suggestions the review pass tied to this criterion, for the legacy
  // codeExample / unified-diff renderings the thread body still supports.
  suggestions?: ReviewSuggestion[];
};

const TITLE_CAP = 100;

function clip(text: string, cap = TITLE_CAP): string {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (t.length <= cap) return t;
  let cut = t.slice(0, cap - 1);
  // Never end inside an inline code span: an odd number of backticks leaves the
  // heading's opening backtick unclosed, and GitHub renders it literally (seen
  // on verify-demo#5, a deferral quoting a long TODO). Back up to before it.
  const ticks = (cut.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("`"));
  return `${cut.trimEnd()}…`;
}

// Thread identity. Deliberately NOT findingKey: that normalizes the path too,
// stripping separators and truncating, so two files under a deep shared prefix
// collapse to the same key — harmless when deduping, but here a collision means
// editing the wrong thread. Paths are exact strings out of the diff; there is no
// wording drift to tolerate, so they are compared raw.
//
// The category is deliberately NOT part of the key: the same bug can be
// attributed to `criticalErrors` on one run and `defects` on the next (the
// holistic stage only runs with a built index), and a key that moved with it
// would announce a phantom fix and open a duplicate thread.
export function itemKey(i: {
  criterionId?: string;
  path?: string;
  concern: string;
}): string {
  if (i.criterionId) return `criterion::${normalizeSlug(i.criterionId)}`;
  return `${i.path ?? ""}::${normalizeSlug(i.concern).slice(0, 80)}`;
}

// Match suggestions to a criterion by NORMALIZED id (trim + lowercase),
// mirroring the verdict -> criterion merge in runReviewJob. The review LLM can
// echo `criterionId` in a different case/whitespace than the criterion's id
// ("C1" vs "c1"); a strict === would drop the patch.
export function suggestionsForCriterion(
  id: unknown,
  suggestions: ReviewSuggestion[]
): ReviewSuggestion[] {
  const cid = String(id ?? "").trim().toLowerCase();
  return suggestions.filter(
    (s) => String(s.criterionId ?? "").trim().toLowerCase() === cid
  );
}

// Bucket -> (category, stage). The single source of truth for which pass owns
// which findings; every renderer and the reconciler read it from here.
//
// Deliberately absent:
//   preexistingVulns / resolvedPreexisting — not introduced by this PR; they
//     stay a pointer to the Security page and its own check run.
//   consistencyFindings — no pass populates it (see verdict-types.ts).
const FINDING_BUCKETS: Array<{
  bucket: keyof HolisticVerdict;
  category: ReviewItemCategory;
  stage: ReviewStage;
}> = [
  { bucket: "regressions", category: "regression", stage: "holistic" },
  { bucket: "criticalErrors", category: "criticalError", stage: "holistic" },
  { bucket: "defects", category: "defect", stage: "defects" },
  { bucket: "securityFindings", category: "security", stage: "security" },
  { bucket: "commitIntentFindings", category: "commitIntent", stage: "commitIntent" },
  { bucket: "deferrals", category: "deferral", stage: "deferrals" },
  { bucket: "conventionFindings", category: "convention", stage: "docs" },
  { bucket: "docDriftFindings", category: "docDrift", stage: "docs" },
  { bucket: "crossRepoImpacts", category: "crossRepo", stage: "crossRepo" },
  { bucket: "parityNotes", category: "parity", stage: "crossRepo" },
];

function findingItem(
  f: HolisticFinding,
  category: ReviewItemCategory,
  stage: ReviewStage
): ReviewItem {
  return {
    key: itemKey(f),
    category,
    stage,
    state: "open",
    scoreKind: "finding",
    severity: f.severity,
    securitySeverity: f.securitySeverity,
    title: clip(f.concern),
    concern: f.concern,
    path: f.path,
    line: f.line,
    defectClass: f.defectClass,
    failureScenario: f.failureScenario,
    suggestedChange: f.suggestedChange ?? null,
    fixPrompt: f.fixPrompt,
  };
}

// The anchor a criterion's thread should use. The criterion itself carries no
// path, so it borrows one — in the order of how precisely each source locates
// the problem: the fix the reviewer proposed, then the evidence it cited, then
// whatever a matched suggestion pointed at.
function criterionAnchor(
  c: Criterion,
  matched: ReviewSuggestion[]
): { path?: string; line?: number } {
  if (c.suggestedChange) return { path: c.suggestedChange.path, line: c.suggestedChange.startLine };
  if (c.evidenceCode) return { path: c.evidenceCode.path, line: c.evidenceCode.startLine };
  const anchor = matched.find((s) => s.path);
  return anchor ? { path: anchor.path, line: anchor.line } : {};
}

function criterionItem(
  c: Criterion,
  state: "unmet" | "regressed" | "met",
  suggestions: ReviewSuggestion[]
): ReviewItem {
  const matched = suggestionsForCriterion(c.id, suggestions);
  // met === null means the model returned no verdict for this criterion, as
  // opposed to positively judging it unmet — a weaker claim, scored lower and
  // labelled honestly by the renderer.
  const unevaluated = state === "unmet" && c.met === null;
  const scoreKind: ScoreKind =
    state === "met"
      ? "criterion-met"
      : state === "regressed"
        ? "criterion-regressed"
        : unevaluated
          ? "criterion-unevaluated"
          : "criterion-unmet";
  return {
    key: itemKey({ criterionId: c.id, concern: c.text }),
    category: "criterion",
    stage: "criteria",
    state: state === "met" ? "met" : "open",
    scoreKind,
    // Criteria never gate through the finding severity path (allMet does that),
    // so they carry the neutral weight and let scoreKind do the work.
    severity: state === "met" ? "nit" : "warn",
    title: clip(c.text),
    concern: c.text,
    criterionId: c.id,
    criterionText: c.text,
    reason: c.evidence ?? undefined,
    evidenceCode: c.evidenceCode ?? null,
    suggestedChange: c.suggestedChange ?? null,
    suggestions: matched,
    ...criterionAnchor(c, matched),
  };
}

export function buildReviewItems(args: {
  criteria: Criterion[];
  prior: Map<string, PriorVerdict>;
  suggestions: ReviewSuggestion[];
  holistic: HolisticVerdict;
  lineNotes?: Array<{ path: string; line: number; body: string }>;
}): ReviewItem[] {
  const { criteria, prior, suggestions, holistic } = args;
  const items: ReviewItem[] = [];

  const { regressed, unmet, met } = splitForComment(criteria, prior);
  for (const c of regressed) items.push(criterionItem(c, "regressed", suggestions));
  for (const c of unmet) items.push(criterionItem(c, "unmet", suggestions));
  for (const c of met) items.push(criterionItem(c, "met", suggestions));

  for (const { bucket, category, stage } of FINDING_BUCKETS) {
    const findings = holistic[bucket];
    if (!Array.isArray(findings)) continue;
    for (const f of findings as HolisticFinding[]) items.push(findingItem(f, category, stage));
  }

  for (const n of args.lineNotes ?? []) {
    items.push({
      key: itemKey({ path: n.path, concern: n.body }),
      category: "lineNote",
      stage: "criteria",
      state: "open",
      scoreKind: "finding",
      severity: "nit",
      title: clip(n.body),
      concern: n.body,
      path: n.path,
      line: n.line,
    });
  }

  // Two stages can surface the same bug under different buckets and in different
  // words. The exact key catches the identical-wording case cheaply; identity.ts
  // catches the rest. Merging is by CLUSTER, not pairwise against the survivor:
  // on verify-demo#5 the regression and the nit on line 45 didn't share enough
  // vocabulary to match each other, but both matched the bug between them.
  // First member wins, which is the FINDING_BUCKETS order — most severe first.
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  const clusters: ReviewItem[][] = [];
  const out: ReviewItem[] = [];
  for (const item of unique) {
    if (item.category === "criterion") {
      out.push(item);
      continue;
    }
    const id = identityOf(item);
    const cluster = clusters.find((c) => c.some((m) => sameFinding(identityOf(m), id)));
    if (cluster) {
      cluster.push(item);
      continue;
    }
    clusters.push([item]);
    out.push(item);
  }
  return out;
}

/** The wording-independent view of an item that identity.ts matches on. */
export function identityOf(
  i: Pick<ReviewItem, "path" | "line" | "concern" | "suggestedChange" | "defectClass">
): FindingIdentity {
  return {
    path: i.path,
    line: i.line,
    concern: i.concern,
    original: i.suggestedChange?.original || undefined,
    defectClass: i.defectClass,
  };
}

// Chips on the summary card. Order is display order; a category maps to exactly
// one chip so the counts always sum to the open item total.
export const CHIP_GROUPS: Array<{
  label: string;
  icon: string;
  categories: ReviewItemCategory[];
}> = [
  { label: "Criteria not met", icon: "📋", categories: ["criterion"] },
  { label: "Bugs", icon: "🐞", categories: ["defect", "criticalError", "regression"] },
  { label: "Security", icon: "🔒", categories: ["security"] },
  { label: "Intent", icon: "🧭", categories: ["commitIntent"] },
  { label: "Deferred work", icon: "🚧", categories: ["deferral"] },
  { label: "Cross-repo", icon: "🔗", categories: ["crossRepo", "parity"] },
  { label: "Nitpicks", icon: "📝", categories: ["convention", "docDrift", "lineNote"] },
];

/** The minimum a thing needs to be counted on the card: what it is, and whether it's still open. */
export type Chippable = Pick<ReviewItem, "category" | "state">;

// Open counts per chip group, in display order; zero-count groups are included so
// the caller decides what to hide. Takes the structural minimum so a thread
// carried over from an earlier run — whose stage did not re-run, so it produced
// no item this time — still counts. Dropping those would tell the reader a bug
// went away when all that happened is nobody looked.
export function countByChip(open: Chippable[]): Array<{ label: string; icon: string; count: number }> {
  return CHIP_GROUPS.map((g) => ({
    label: g.label,
    icon: g.icon,
    count: open.filter((i) => i.state === "open" && g.categories.includes(i.category)).length,
  }));
}
