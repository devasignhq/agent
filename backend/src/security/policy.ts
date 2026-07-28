// Per-repo security scan policy (triggers / engines / severity gates) and the
// merge-gate computation. Pure module — callers pass rows in — so the gate
// matrix is testable offline.
import type {
  AttackSurface,
  PRReview,
  RepoSecurityPolicy,
  Repository,
  SecurityFinding,
  SecurityFindingState,
  SecuritySeverity,
  SeverityGateAction,
} from "../types.js";

export const DEFAULT_SECURITY_POLICY: RepoSecurityPolicy = {
  version: 1,
  triggers: { onMerge: true, onPrPush: true, nightly: false, advisories: false },
  engines: { api: true, frontend: true, infra: true, secrets: true, deps: true },
  gates: { critical: "block", high: "warn", medium: "track", low: "track" },
};

// States that count as "unresolved" for gating and dashboards. fix_ready still
// blocks: the fix exists on an open PR head but hasn't merged, so the default
// branch is still vulnerable. snoozed deliberately does NOT gate (that's what
// the snooze is for) but is still an active finding elsewhere.
export const GATING_STATES: SecurityFindingState[] = [
  "new",
  "open",
  "issue_created",
  "bounty",
  "fix_ready",
];

export const ACTIVE_STATES: SecurityFindingState[] = [...GATING_STATES, "snoozed"];

export function isActiveState(s: SecurityFindingState): boolean {
  return ACTIVE_STATES.includes(s);
}

// Merge defaults under whatever partial policy the row carries, so rows written
// before a field existed keep loading and new fields pick up their defaults.
export function effectiveSecurityPolicy(repo: Repository | undefined): RepoSecurityPolicy {
  const p = repo?.securityPolicy;
  if (!p) return DEFAULT_SECURITY_POLICY;
  return {
    version: 1,
    triggers: { ...DEFAULT_SECURITY_POLICY.triggers, ...(p.triggers ?? {}) },
    engines: { ...DEFAULT_SECURITY_POLICY.engines, ...(p.engines ?? {}) },
    gates: { ...DEFAULT_SECURITY_POLICY.gates, ...(p.gates ?? {}) },
  };
}

// Coerce a client-submitted policy body into a well-formed policy. Unknown keys
// are dropped; missing ones fall back to defaults. Critical stays at least
// "warn" — a policy that silently *tracks* criticals would make the page lie.
export function normalizeSecurityPolicy(body: unknown): RepoSecurityPolicy {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const gate = (v: unknown, dflt: SeverityGateAction): SeverityGateAction =>
    v === "block" || v === "warn" || v === "track" ? v : dflt;
  const t = b.triggers ?? {};
  const e = b.engines ?? {};
  const g = b.gates ?? {};
  const d = DEFAULT_SECURITY_POLICY;
  const criticalGate = gate(g.critical, d.gates.critical);
  return {
    version: 1,
    triggers: {
      onMerge: bool(t.onMerge, d.triggers.onMerge),
      onPrPush: bool(t.onPrPush, d.triggers.onPrPush),
      nightly: bool(t.nightly, d.triggers.nightly),
      advisories: bool(t.advisories, d.triggers.advisories),
    },
    engines: {
      api: bool(e.api, d.engines.api),
      frontend: bool(e.frontend, d.engines.frontend),
      infra: bool(e.infra, d.engines.infra),
      secrets: bool(e.secrets, d.engines.secrets),
      deps: bool(e.deps, d.engines.deps),
    },
    gates: {
      critical: criticalGate === "track" ? "warn" : criticalGate,
      high: gate(g.high, d.gates.high),
      medium: gate(g.medium, d.gates.medium),
      low: gate(g.low, d.gates.low),
    },
  };
}

export function engineForSurface(policy: RepoSecurityPolicy, surface: AttackSurface): boolean {
  return policy.engines[surface] ?? true;
}

export type GateRule = {
  id: string;
  label: string;
  pass: boolean;
  required: boolean; // required rules flip the verdict; others warn only
  count: number;     // findings behind this rule (0 when passing)
};

export type GateResult = {
  verdict: "pass" | "fail";
  rules: GateRule[];
  blockingFindingIds: string[];
};

const SEV_LIST: SecuritySeverity[] = ["critical", "high", "medium", "low"];

// The merge gate, computed from the repo's findings + open-PR review snapshots.
// R1: no unresolved block-gated finding on the default branch. R2: no open PR's
// latest review introduces a block-gated finding. warn-gated severities get a
// warn-only rule row (visible, never flips the verdict).
export function computeGate(args: {
  findings: SecurityFinding[];        // this repo's findings
  openReviews: PRReview[];            // open-PR reviews (latest per PR)
  policy: RepoSecurityPolicy;
}): GateResult {
  const { findings, openReviews, policy } = args;
  const rules: GateRule[] = [];
  const blockingIds = new Set<string>();

  const blockSevs = SEV_LIST.filter((s) => policy.gates[s] === "block");
  const warnSevs = SEV_LIST.filter((s) => policy.gates[s] === "warn");

  const gating = findings.filter((f) => GATING_STATES.includes(f.state));

  // R1 — per block-gated severity, unresolved findings on the default branch.
  for (const sev of blockSevs) {
    const hits = gating.filter((f) => f.severity === sev);
    for (const f of hits) blockingIds.add(f.id);
    rules.push({
      id: `no-open-${sev}`,
      label: `No unresolved ${sev} findings on the default branch`,
      pass: hits.length === 0,
      required: true,
      count: hits.length,
    });
  }

  // R2 — open PRs must not introduce a block-gated finding (from the review
  // pipeline's snapshot stamped at verdict time).
  const introduced = openReviews.flatMap((r) =>
    (r.securityFindings ?? []).filter((f) => blockSevs.includes(f.severity))
  );
  rules.push({
    id: "no-introduced-blocking",
    label: "No open PR introduces a block-gated finding",
    pass: introduced.length === 0,
    required: true,
    count: introduced.length,
  });

  // Warn-only rows for visibility.
  for (const sev of warnSevs) {
    const hits = gating.filter((f) => f.severity === sev);
    rules.push({
      id: `warn-${sev}`,
      label: `Unresolved ${sev} findings`,
      pass: hits.length === 0,
      required: false,
      count: hits.length,
    });
  }

  const verdict = rules.some((r) => r.required && !r.pass) ? "fail" : "pass";
  return { verdict, rules, blockingFindingIds: [...blockingIds] };
}
