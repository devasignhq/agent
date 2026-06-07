// Per-repo review workflow: which optional stages run, the entry-trigger policy,
// and verdict behavior. Surfaced and edited on the frontend "Workflow" screen,
// enforced by the review pipeline (stages + verdict) and the PR webhook (trigger).
//
// Tiering: `stages` (which stages run) is BASIC (free). `trigger` and `verdict`
// (policy + automation) are ADVANCED (Pro/Max) — the API rejects advanced changes
// from free users (see advancedChanged); the UI locks them behind an upgrade nudge.
import type { Repository, RepoWorkflow } from "../types.js";

// Defaults reproduce DevAsign's behavior before workflows existed, so any repo
// whose `workflow` is undefined (every existing repo) reviews exactly as before.
export const WORKFLOW_DEFAULTS: RepoWorkflow = {
  version: 1,
  trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
  stages: { holistic: true, docs: true, deferrals: true },
  verdict: { blocking: true },
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
  };
}

// Whether two workflows differ in their ADVANCED fields (trigger/verdict). The
// API uses this to refuse advanced changes from free users while still allowing
// basic (stage) edits.
export function advancedChanged(a: RepoWorkflow, b: RepoWorkflow): boolean {
  return (
    a.trigger.onSynchronize !== b.trigger.onSynchronize ||
    a.trigger.skipDrafts !== b.trigger.skipDrafts ||
    a.trigger.skipBots !== b.trigger.skipBots ||
    a.verdict.blocking !== b.verdict.blocking
  );
}
