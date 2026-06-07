// Per-repo review workflow: which optional stages run, the entry-trigger policy,
// and verdict behavior. Surfaced and edited on the frontend "Workflow" screen,
// enforced by the review pipeline (stages + verdict) and the PR webhook (trigger).
//
// Tiering: `stages` (which stages run) is BASIC (free). `trigger`, `verdict`
// (policy + automation) and `prompts` (per-stage agent steering) are ADVANCED
// (Pro/Max) — the API rejects advanced changes from free users (see
// advancedChanged); the UI locks them behind an upgrade nudge.
import type { Repository, RepoWorkflow } from "../types.js";

// The stages that make an LLM call and can therefore carry maintainer
// instructions. Shared by normalize/effective/advancedChanged and the pipeline.
export const PROMPT_KEYS = ["criteria", "review", "holistic", "deferrals", "docs"] as const;
// Cap a single stage prompt so a pasted essay can't blow up the system prompt.
const PROMPT_CAP = 2000;

// Defaults reproduce DevAsign's behavior before workflows existed, so any repo
// whose `workflow` is undefined (every existing repo) reviews exactly as before.
export const WORKFLOW_DEFAULTS: RepoWorkflow = {
  version: 1,
  trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
  stages: { holistic: true, docs: true, deferrals: true },
  verdict: { blocking: true },
  prompts: {},
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
  return {
    version: 1,
    trigger: {
      onSynchronize: b(t.onSynchronize, WORKFLOW_DEFAULTS.trigger.onSynchronize),
      skipDrafts: b(t.skipDrafts, WORKFLOW_DEFAULTS.trigger.skipDrafts),
      skipBots: b(t.skipBots, WORKFLOW_DEFAULTS.trigger.skipBots),
    },
    stages: {
      holistic: b(s.holistic, WORKFLOW_DEFAULTS.stages.holistic),
      docs: b(s.docs, WORKFLOW_DEFAULTS.stages.docs),
      deferrals: b(s.deferrals, WORKFLOW_DEFAULTS.stages.deferrals),
    },
    verdict: { blocking: b(v.blocking, WORKFLOW_DEFAULTS.verdict.blocking) },
    prompts,
  };
}

// Whether two workflows differ in their ADVANCED fields (trigger/verdict/
// prompts). The API uses this to refuse advanced changes from free users while
// still allowing basic (stage) edits.
export function advancedChanged(a: RepoWorkflow, b: RepoWorkflow): boolean {
  return (
    a.trigger.onSynchronize !== b.trigger.onSynchronize ||
    a.trigger.skipDrafts !== b.trigger.skipDrafts ||
    a.trigger.skipBots !== b.trigger.skipBots ||
    a.verdict.blocking !== b.verdict.blocking ||
    PROMPT_KEYS.some((k) => (a.prompts?.[k] || "") !== (b.prompts?.[k] || ""))
  );
}
