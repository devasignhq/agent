// Per-repo review workflow: which optional stages run, the entry-trigger policy,
// and verdict behavior. Surfaced and edited on the frontend "Workflow" screen,
// enforced by the review pipeline (stages + verdict) and the PR webhook (trigger).
//
// Tiering: `stages` (which stages run) is BASIC (free). `trigger`, `verdict`
// (policy + automation), `prompts` (per-stage agent steering) and `actions`
// (GitHub Actions workflow dispatch) are ADVANCED (Pro/Max) — the API rejects
// advanced changes from free users (see advancedChanged); the UI locks them.
import type { Repository, RepoWorkflow } from "../types.js";

// The stages that make an LLM call and can therefore carry maintainer
// instructions. Shared by normalize/effective/advancedChanged and the pipeline.
export const PROMPT_KEYS = ["criteria", "review", "holistic", "defects", "deferrals", "docs"] as const;
// Cap a single stage prompt so a pasted essay can't blow up the system prompt.
const PROMPT_CAP = 2000;
// Cap the stored workflow file name for the "Run GitHub Action" step.
const WORKFLOW_NAME_CAP = 200;

// Defaults reproduce DevAsign's behavior before workflows existed, so any repo
// whose `workflow` is undefined (every existing repo) reviews exactly as before.
//
// One exception, deliberate: `defects` defaults to true, which DOES change how
// existing repos review. The general defect pass exists because criteria-only
// review lets a PR that satisfies every requirement ship a real bug — shipping
// it default-off would leave that gap open for every repo that never visits the
// Workflow screen. Maintainers can turn it off there.
export const WORKFLOW_DEFAULTS: RepoWorkflow = {
  version: 1,
  trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
  stages: { holistic: true, defects: true, docs: true, deferrals: true },
  verdict: { blocking: true },
  prompts: {},
  actions: { enabled: false, workflow: "", runWhen: "passed" },
};

// Merge a repo's stored (possibly partial/legacy) workflow over the defaults so
// every consumer gets a fully-populated config. Read-only — never mutates.
// Accepts a minimal shape so tests can pass `{ workflow }` directly.
export function effectiveWorkflow(repo: Pick<Repository, "workflow">): RepoWorkflow {
  const w = repo.workflow;
  if (!w) return WORKFLOW_DEFAULTS;
  return {
    version: 1,
    trigger: { ...WORKFLOW_DEFAULTS.trigger, ...(w.trigger || {}) },
    stages: { ...WORKFLOW_DEFAULTS.stages, ...(w.stages || {}) },
    verdict: { ...WORKFLOW_DEFAULTS.verdict, ...(w.verdict || {}) },
    prompts: { ...(w.prompts || {}) },
    actions: { ...WORKFLOW_DEFAULTS.actions!, ...(w.actions || {}) },
  };
}

// Normalize an untrusted inbound workflow (from the PUT body) into a clean
// RepoWorkflow: coerce every field to a boolean, drop unknown keys, pin version.
export function normalizeWorkflow(input: unknown): RepoWorkflow {
  const o = (input || {}) as Record<string, any>;
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const t = o.trigger || {};
  const s = o.stages || {};
  const v = o.verdict || {};
  // Prompts: keep only known stage keys, coerce to a trimmed string, cap length,
  // and drop empties so an absent/blank prompt never lingers as "" in storage.
  const p = (o.prompts || {}) as Record<string, unknown>;
  const prompts: NonNullable<RepoWorkflow["prompts"]> = {};
  for (const k of PROMPT_KEYS) {
    const raw = p[k];
    if (typeof raw !== "string") continue;
    const text = raw.trim().slice(0, PROMPT_CAP);
    if (text) prompts[k] = text;
  }
  // GitHub Action dispatch step: coerce enabled→bool, workflow→trimmed/capped
  // string, runWhen→one of the two allowed values.
  const a = (o.actions || {}) as Record<string, any>;
  const actions: NonNullable<RepoWorkflow["actions"]> = {
    enabled: b(a.enabled, false),
    workflow: typeof a.workflow === "string" ? a.workflow.trim().slice(0, WORKFLOW_NAME_CAP) : "",
    runWhen: a.runWhen === "always" ? "always" : "passed",
  };
  return {
    version: 1,
    trigger: {
      onSynchronize: b(t.onSynchronize, WORKFLOW_DEFAULTS.trigger.onSynchronize),
      skipDrafts: b(t.skipDrafts, WORKFLOW_DEFAULTS.trigger.skipDrafts),
      skipBots: b(t.skipBots, WORKFLOW_DEFAULTS.trigger.skipBots),
    },
    stages: {
      holistic: b(s.holistic, WORKFLOW_DEFAULTS.stages.holistic),
      defects: b(s.defects, WORKFLOW_DEFAULTS.stages.defects),
      docs: b(s.docs, WORKFLOW_DEFAULTS.stages.docs),
      deferrals: b(s.deferrals, WORKFLOW_DEFAULTS.stages.deferrals),
    },
    verdict: { blocking: b(v.blocking, WORKFLOW_DEFAULTS.verdict.blocking) },
    prompts,
    actions,
  };
}

// Whether two workflows differ in their ADVANCED fields (trigger/verdict/
// prompts/actions). The API uses this to refuse advanced changes from free
// users while still allowing basic (stage) edits.
export function advancedChanged(a: RepoWorkflow, b: RepoWorkflow): boolean {
  return (
    a.trigger.onSynchronize !== b.trigger.onSynchronize ||
    a.trigger.skipDrafts !== b.trigger.skipDrafts ||
    a.trigger.skipBots !== b.trigger.skipBots ||
    a.verdict.blocking !== b.verdict.blocking ||
    PROMPT_KEYS.some((k) => (a.prompts?.[k] || "") !== (b.prompts?.[k] || "")) ||
    !!a.actions?.enabled !== !!b.actions?.enabled ||
    (a.actions?.workflow || "") !== (b.actions?.workflow || "") ||
    (a.actions?.runWhen || "passed") !== (b.actions?.runWhen || "passed")
  );
}
