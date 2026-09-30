// How the Security page presents a finding once only test-proven findings count.
// The server sends `presentation` per finding (and `proofGate` per repo); when it
// is absent the gate is off and the page keeps its previous behaviour exactly.
// Mirrors backend/src/security/proof.ts, the way OPEN_STATES mirrors the backend.
import type { FindingPresentation, SecurityFinding, SecurityProof, SecurityRepoView } from "./api";
import { isHeldBack, isSuppressedByRuling } from "./security-triage.ts";

export function proofGateOn(repos: SecurityRepoView[]): boolean {
  return repos.some((r) => r.proofGate === true);
}

export function presentationFor(f: SecurityFinding): FindingPresentation | null {
  return f.presentation ?? null;
}

export function isProven(f: SecurityFinding): boolean {
  return f.presentation === "main";
}

// A finding a human already acted on: it keeps its place and its triage, but
// carries an "untested" badge and no longer gates.
export function needsUntestedBadge(f: SecurityFinding): boolean {
  return f.presentation === "kept";
}

export function isUntested(f: SecurityFinding): boolean {
  return f.presentation === "untested";
}

export type FindingPartition = {
  /** What feeds the chips, search, table, KPI tiles and surface chart. */
  pool: SecurityFinding[];
  /** The collapsed untested ledger. */
  untested: SecurityFinding[];
  /** Auto-suppressed by a maintainer ruling — its own existing ledger. */
  suppressed: SecurityFinding[];
};

// The gate removes untested rows from the pool and nothing else: resolved and
// dismissed rows keep their chips, so only the unproven claims move. With the
// gate off the pool is every finding, exactly as before.
export function partitionFindings(findings: SecurityFinding[], gateOn: boolean): FindingPartition {
  const suppressed = findings.filter(isSuppressedByRuling);
  if (!gateOn) {
    return { pool: findings, untested: findings.filter(isHeldBack), suppressed };
  }
  return {
    pool: findings.filter((f) => !isUntested(f)),
    untested: findings.filter(isUntested).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    suppressed,
  };
}

const REASON_TEXT: Record<string, string> = {
  stale: "the code changed since the test ran",
  control_failed: "the test itself did not work",
  test_errored: "the test could not run",
  flaky: "the test gave inconsistent results",
  single_attempt: "the test ran only once",
  not_reachable: "not reachable from the running app",
  deployment_dependent: "depends on deployment, not on the code",
  nondeterministic: "the behaviour is not repeatable",
  no_test_written: "no test has been written yet",
  unsupported_runner: "this project's test setup is not supported yet",
};

export type ProofTag = { label: string; detail: string | null; tone: "ok" | "plain" };

// The grey chip and its one-line reason. Deliberately plain language: this is
// read by someone deciding whether to care.
export function proofTag(proof: SecurityProof | undefined): ProofTag {
  if (!proof) return { label: "untested", detail: "no test has been written yet", tone: "plain" };
  switch (proof.status) {
    case "verified":
      return {
        label: proof.method === "rule" ? "verified by rule" : "verified by test",
        detail: null,
        tone: "ok",
      };
    case "testing":
      return { label: "testing…", detail: "a test is running", tone: "plain" };
    case "not_reproduced":
      return { label: "not reproduced", detail: "the attack was blocked when tested", tone: "plain" };
    case "untestable":
      return { label: "untested", detail: REASON_TEXT[proof.reason ?? ""] ?? "cannot be tested", tone: "plain" };
    case "inconclusive":
      return { label: "untested", detail: REASON_TEXT[proof.reason ?? ""] ?? "the test was inconclusive", tone: "plain" };
    default:
      return {
        label: "untested",
        detail: REASON_TEXT[proof.reason ?? ""] ?? "no test has been written yet",
        tone: "plain",
      };
  }
}

export type ReadinessBanner = {
  repoId: string;
  repo: string;
  kind: "needs_setup" | "needs_opt_in";
  message: string;
  actionLabel: string;
  href: string | null;
};

// One banner per repo that has findings waiting on something the maintainer
// controls. Repos that are ready, or have nothing waiting, produce nothing.
export function readinessBanners(
  repos: SecurityRepoView[],
  findings: SecurityFinding[],
  repoFilter: string | "all" = "all"
): ReadinessBanner[] {
  const waitingByRepo = new Map<string, number>();
  for (const f of findings) {
    if (f.presentation !== "untested" && f.presentation !== "kept") continue;
    waitingByRepo.set(f.repoId, (waitingByRepo.get(f.repoId) ?? 0) + 1);
  }
  const out: ReadinessBanner[] = [];
  for (const repo of repos) {
    if (!repo.proofGate) continue;
    if (repoFilter !== "all" && repo.id !== repoFilter) continue;
    const n = waitingByRepo.get(repo.id) ?? 0;
    if (!n) continue;
    const name = `${repo.owner}/${repo.name}`;
    if (repo.proofReadiness === "needs_setup") {
      out.push({
        repoId: repo.id,
        repo: name,
        kind: "needs_setup",
        message: `${n} finding${n === 1 ? "" : "s"} in ${name} ${n === 1 ? "is" : "are"} waiting for a test — enable verification to prove them.`,
        actionLabel: "Enable verification",
        href: `/workflow?repo=${encodeURIComponent(repo.id)}&setup=browser`,
      });
    } else if (repo.proofReadiness === "needs_opt_in") {
      out.push({
        repoId: repo.id,
        repo: name,
        kind: "needs_opt_in",
        message: `Security tests are off for ${name} because it is public. Turn them on to prove its ${n} waiting finding${n === 1 ? "" : "s"}.`,
        actionLabel: "Open security settings",
        href: null,
      });
    }
  }
  return out;
}

// Counts for the untested ledger's header, so the reasons are visible before it
// is expanded.
export function untestedSummary(findings: SecurityFinding[]): { total: number; byLabel: Array<{ label: string; count: number }> } {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const tag = proofTag(f.proof);
    const key = tag.detail ? `${tag.label} — ${tag.detail}` : tag.label;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    total: findings.length,
    byLabel: [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  };
}
