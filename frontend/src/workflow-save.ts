// The durability-aware "optimistic save" state machine for the Workflow screen,
// lifted out of the React component (screen-workflow.tsx) so it can be unit-tested
// without a DOM — see workflow-save.test.ts. The component's save() is a thin
// wrapper that binds these dependencies to React state setters and refs.
//
// Behaviour: paint `next` immediately. If persistence succeeds, confirm durable.
// If it fails with a TRANSIENT durability blip (HTTP 503 not_durable — the backend
// has already staged the write in memory and its heartbeat persists it within
// ~15s), KEEP the optimistic state, surface a calm "queued" notice and re-confirm
// ONCE after a short delay; if that re-confirm also 503s, leave the optimistic
// state but swap the notice for a terminal "saving in the background" note instead
// of an endless spinner. Any other failure reverts and shows the error. All
// deferred state is scoped to the save's target repo + a monotonic token, so a
// newer save — or switching repos mid-save — can't bleed into the current UI.
import type { RepoWorkflow } from "./api";

// Delay before the single re-confirm after a transient not_durable. The barrier
// only 503s after exhausting its own multi-second retry loop, so an immediate
// retry would just re-hang — wait long enough for the heartbeat / DB warm-up.
export const RETRY_DELAY_MS = 4000;

// A 503 whose body says the write was staged but isn't durable yet — a transient
// blip (e.g. a DB cold-start), NOT a hard failure.
export function isTransientNotDurable(e: any): boolean {
  return e?.status === 503 && e?.body?.error === "not_durable";
}

// User-facing message for a save that genuinely failed (and was reverted). Prefers
// the backend's friendly `body.message` over the raw error code.
export function saveErrorMessage(e: any): string {
  if (e?.message === "upgrade_required") return "That control is a Pro/Max feature.";
  return e?.body?.message || e?.message || "Couldn't save — reverted.";
}

export type SaveDeps = {
  repoId: string;
  // The currently-selected repo, read just before any deferred state is applied. A
  // save pins its target repo (repoId above); if the user switches repos while it's
  // in flight, its outcome must NOT bleed into the new repo's UI. Optional — when
  // omitted only the seq token guards currency (used by tests that ignore repos).
  activeRepoId?: () => string;
  // The current workflow at call time — restored verbatim on a hard failure.
  getPrev: () => RepoWorkflow | null;
  // Persist the workflow (production binds api.setRepoWorkflow).
  persist: (repoId: string, next: RepoWorkflow) => Promise<unknown>;
  setWf: (wf: RepoWorkflow | null) => void;
  setErr: (msg: string | null) => void;
  setPending: (pending: boolean) => void;
  // Monotonic token: each save claims the next value; a stale save/retry whose
  // claimed value is no longer current does nothing (a newer save supersedes it).
  seqRef: { current: number };
  retryTimer: { current: ReturnType<typeof setTimeout> | null };
  // Injectable so tests can drive the re-confirm without a real timer.
  scheduleRetry: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  retryDelayMs?: number;
};

export async function runSave(
  deps: SaveDeps,
  next: RepoWorkflow,
  isRetry = false
): Promise<void> {
  if (!deps.repoId) return;
  const seq = ++deps.seqRef.current; // claim latest; stale callbacks below no-op
  const prev = deps.getPrev();
  // Deferred state (success / transient / scheduled retry) may only be applied
  // while this save is STILL the relevant one: no newer save has claimed the token
  // AND the user hasn't switched away from the repo it targets. Either miss means
  // its outcome would bleed the old repo's state into whatever is on screen now.
  const stillCurrent = () =>
    seq === deps.seqRef.current &&
    (!deps.activeRepoId || deps.activeRepoId() === deps.repoId);
  deps.setWf(next);
  deps.setErr(null);
  try {
    await deps.persist(deps.repoId, next);
    if (stillCurrent()) deps.setPending(false); // confirmed durable
  } catch (e: any) {
    if (!stillCurrent()) return; // superseded by a newer save or a repo switch
    if (isTransientNotDurable(e)) {
      if (isRetry) {
        // The single re-confirm ALSO hit a transient 503. Don't sit in 'queued'
        // forever: the write is staged and the heartbeat persists it, so keep the
        // optimistic state but replace the spinner with a calm, terminal note.
        deps.setPending(false);
        deps.setErr("Still saving in the background — reload later to confirm.");
        return;
      }
      deps.setPending(true); // keep the optimistic state — do NOT revert
      if (deps.retryTimer.current) clearTimeout(deps.retryTimer.current);
      deps.retryTimer.current = deps.scheduleRetry(() => {
        if (stillCurrent()) void runSave(deps, next, true);
      }, deps.retryDelayMs ?? RETRY_DELAY_MS);
      return;
    }
    deps.setPending(false);
    deps.setWf(prev); // hard failure — revert
    deps.setErr(saveErrorMessage(e));
  }
}
