// The durability-aware "optimistic save" state machine for the Workflow screen,
// lifted out of the React component (screen-workflow.tsx) so it can be unit-tested
// without a DOM — see workflow-save.test.ts. The component's save() is a thin
// wrapper that binds these dependencies to React state setters and refs.
//
// Behaviour: paint `next` immediately. If persistence succeeds, confirm durable.
// If it fails with a TRANSIENT durability blip (HTTP 503 not_durable — the backend
// has already staged the write in memory and its heartbeat persists it within
// ~15s), KEEP the optimistic state, surface a calm "queued" notice and re-confirm
// ONCE after a short delay. Any other failure reverts and shows the error.
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
  deps.setWf(next);
  deps.setErr(null);
  try {
    await deps.persist(deps.repoId, next);
    if (seq === deps.seqRef.current) deps.setPending(false); // confirmed durable
  } catch (e: any) {
    if (seq !== deps.seqRef.current) return; // a newer save superseded this one
    if (isTransientNotDurable(e)) {
      deps.setPending(true); // keep the optimistic state — do NOT revert
      if (!isRetry) {
        if (deps.retryTimer.current) clearTimeout(deps.retryTimer.current);
        deps.retryTimer.current = deps.scheduleRetry(() => {
          if (seq === deps.seqRef.current) void runSave(deps, next, true);
        }, deps.retryDelayMs ?? RETRY_DELAY_MS);
      }
      return;
    }
    deps.setPending(false);
    deps.setWf(prev); // hard failure — revert
    deps.setErr(saveErrorMessage(e));
  }
}
