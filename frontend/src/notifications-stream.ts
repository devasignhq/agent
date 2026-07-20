// The notifications live-stream controller, lifted out of the React hook
// (app.tsx useNotifications) so the connect / reconnect / fallback-poll logic is
// unit-testable under `node --test` without a DOM or a real EventSource — see
// notifications-stream.test.ts. useNotifications is a thin wrapper that binds
// these deps to a real EventSource + window timers.
//
// Behaviour: open an SSE stream to the backend; on any message, hand the raw
// frame to refresh() so the caller can route it (see live-bus.ts). The browser's
// EventSource reconnects on its own after an error, so we don't hand-roll
// backoff — we only detect the recovery, via onopen, and tell the caller to
// catch up on whatever moved while we were away. A slow fallback poll runs
// alongside as a safety net — for a wedged/blocked stream, and for the brief
// zero-downtime-deploy window where a notification may be created on a different
// backend instance than the one holding this stream.

// The slice of the browser EventSource we depend on — kept minimal so a test can
// supply a plain fake without pulling in the DOM lib.
export type StreamSource = {
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  // Fired on the first connect AND on every reconnect EventSource heals by
  // itself. Optional so a minimal fake can omit it.
  onopen?: ((ev?: unknown) => void) | null;
  close: () => void;
};

export type StreamDeps = {
  // Opens the SSE connection. Production binds
  //   () => new EventSource(`${apiBase}/api/notifications/stream`, { withCredentials: true })
  openSource: () => StreamSource;
  // Something changed — go refetch. Called with the raw SSE `data:` payload for
  // a real frame, and with NO argument for a fallback-poll tick, so the caller
  // can route a frame by type but treat a blind poll as "refresh everything".
  refresh: (data?: string) => void;
  // Schedule the recurring fallback poll. Injectable so tests drive it without a
  // real timer. The returned handle is passed back to clearFallback on stop.
  scheduleFallback: (fn: () => void, ms: number) => unknown;
  clearFallback: (handle: unknown) => void;
  fallbackMs?: number;
  // Called when the stream comes back after a drop (laptop sleep, network blip).
  // State may have moved while we were disconnected and no frame was delivered
  // for it, so the caller should refetch. Not called on the initial connect —
  // whatever mounted the stream already fetched.
  onReconnect?: () => void;
  // Gate on the fallback tick. Returning false skips that tick without
  // unscheduling — production uses it to stop polling in a hidden tab. Absent
  // means always tick.
  shouldFallbackTick?: () => boolean;
};

// Fallback poll cadence. Deliberately slow: the SSE stream is the primary path,
// so this only has to catch a dropped stream or the deploy-window gap.
export const FALLBACK_POLL_MS = 60_000;

export type StreamHandle = { stop: () => void };

export function startNotificationsStream(deps: StreamDeps): StreamHandle {
  const source = deps.openSource();
  source.onmessage = (ev) => deps.refresh(ev.data);
  // EventSource auto-reconnects after an error; there's nothing to do but let it.
  // The fallback poll below covers the window while the stream is down.
  source.onerror = () => {};
  // Detect the RECOVERY rather than the drop: onopen fires on the initial
  // connect and again on each self-healed reconnect, so anything past the first
  // means we were away and may have missed frames.
  let opens = 0;
  source.onopen = () => {
    opens++;
    if (opens > 1) deps.onReconnect?.();
  };
  const fallback = deps.scheduleFallback(() => {
    if (deps.shouldFallbackTick?.() === false) return;
    deps.refresh();
  }, deps.fallbackMs ?? FALLBACK_POLL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return; // idempotent: React cleanup + a manual stop can overlap
      stopped = true;
      try {
        // Drop the handlers before closing so no already-queued event can fire
        // refresh() after teardown; close() then stops the connection. onopen
        // included, so a reconnect landing mid-teardown can't trigger a catch-up.
        source.onmessage = null;
        source.onerror = null;
        source.onopen = null;
        source.close();
      } catch {
        // already closed — ignore
      }
      deps.clearFallback(fallback);
    },
  };
}
