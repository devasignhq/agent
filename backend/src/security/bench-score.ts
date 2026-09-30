// Scores one audit run over the security benchmark against manifest.json.
// Pure: the eval script feeds it what the pipeline produced. Matching is on path
// plus class aliases, never line numbers — mechanicalCheck rewrites `line`, so a
// line-sensitive match would score the verifier's repair as a miss.
export type BenchCaseKind = "real" | "decoy";
export type BenchTree = "vulnerable" | "fixed";

export type BenchCase = {
  id: string;
  kind: BenchCaseKind;
  path: string;
  symbol?: string;
  classAliases: string[];
  proof: "runtime" | "reachability" | "none";
};

// One detection as the pipeline left it, after mechanicalCheck and the verifier.
export type BenchDetection = {
  path: string;
  class: string;
  symbol?: string;
  title: string;
  severity: string;
  // "confirmed" is the only status that reaches a user today.
  verification: "confirmed" | "refuted" | "unverifiable";
  holdReason?: string;
};

export type CaseOutcome =
  | "surfaced"
  | "refuted"
  | "unverifiable"
  | "evidence_not_in_file"
  | "not_detected"
  | "scan_failed";

export type CaseResult = { caseId: string; outcome: CaseOutcome; matched: BenchDetection[] };

export type RunScore = {
  tree: BenchTree;
  cases: CaseResult[];
  // Detections that matched no case at all: noise a user would have to triage.
  noise: BenchDetection[];
  scanFailedPaths: string[];
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function detectionMatchesCase(d: BenchDetection, c: BenchCase): boolean {
  if (d.path !== c.path) return false;
  const aliases = new Set(c.classAliases.map(norm));
  if (aliases.has(norm(d.class))) return true;
  // A model that invents its own class tag still matches when it names the symbol.
  return !!c.symbol && !!d.symbol && norm(d.symbol).includes(norm(c.symbol));
}

// Worst-to-best, so a case with several detections is scored by its best one:
// one surfaced finding is what the user acts on.
const RANK: CaseOutcome[] = ["not_detected", "evidence_not_in_file", "refuted", "unverifiable", "surfaced"];

function outcomeFor(d: BenchDetection): CaseOutcome {
  if (d.verification === "confirmed") return "surfaced";
  if (d.holdReason === "evidence_not_in_file") return "evidence_not_in_file";
  return d.verification === "refuted" ? "refuted" : "unverifiable";
}

export function scoreRun(args: {
  tree: BenchTree;
  cases: BenchCase[];
  detections: BenchDetection[];
  // Files whose scan call failed: not clean, just unknown.
  scanFailedPaths?: string[];
}): RunScore {
  const { tree, cases, detections } = args;
  const scanFailedPaths = args.scanFailedPaths ?? [];
  const claimed = new Set<BenchDetection>();
  const results: CaseResult[] = cases.map((c) => {
    const matched = detections.filter((d) => detectionMatchesCase(d, c));
    for (const d of matched) claimed.add(d);
    if (!matched.length) {
      return {
        caseId: c.id,
        outcome: scanFailedPaths.includes(c.path) ? "scan_failed" : "not_detected",
        matched,
      };
    }
    const best = matched.reduce<CaseOutcome>(
      (acc, d) => (RANK.indexOf(outcomeFor(d)) > RANK.indexOf(acc) ? outcomeFor(d) : acc),
      "not_detected"
    );
    return { caseId: c.id, outcome: best, matched };
  });
  return { tree, cases: results, noise: detections.filter((d) => !claimed.has(d)), scanFailedPaths };
}

export type BenchHeadline = {
  realSurfaced: number;
  realTotal: number;
  decoysSurfaced: number;
  decoyTotal: number;
  noise: number;
  scanFailed: number;
};

// On the fixed tree every surfaced case is a false report, real or decoy.
export function headline(score: RunScore, cases: BenchCase[]): BenchHeadline {
  const kindOf = new Map(cases.map((c) => [c.id, c.kind]));
  const surfaced = (kind: BenchCaseKind) =>
    score.cases.filter((r) => kindOf.get(r.caseId) === kind && r.outcome === "surfaced").length;
  return {
    realSurfaced: surfaced("real"),
    realTotal: cases.filter((c) => c.kind === "real").length,
    decoysSurfaced: surfaced("decoy"),
    decoyTotal: cases.filter((c) => c.kind === "decoy").length,
    noise: score.noise.length,
    scanFailed: score.scanFailedPaths.length,
  };
}

// Per-case surfacing rate across repeated runs; LLM output varies, so a single
// run is an anecdote.
export function rates(scores: RunScore[]): Array<{ caseId: string; runs: number; surfaced: number; rate: number }> {
  const byCase = new Map<string, { runs: number; surfaced: number }>();
  for (const s of scores) {
    for (const r of s.cases) {
      const acc = byCase.get(r.caseId) ?? { runs: 0, surfaced: 0 };
      acc.runs += 1;
      if (r.outcome === "surfaced") acc.surfaced += 1;
      byCase.set(r.caseId, acc);
    }
  }
  return [...byCase.entries()].map(([caseId, v]) => ({
    caseId,
    runs: v.runs,
    surfaced: v.surfaced,
    rate: v.runs ? v.surfaced / v.runs : 0,
  }));
}
