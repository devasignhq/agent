// The notifications live-stream controller, lifted out of the React hook
// (app.tsx useNotifications) so the connect / reconnect / fallback-poll logic is
// unit-testable under `node --test` without a DOM or a real EventSource — see
// notifications-stream.test.ts. useNotifications is a thin wrapper that binds
// these deps to a real EventSource + window timers.
//
// Behaviour: open an SSE stream to the backend; on any message, call refresh()
// (which refetches /api/notifications). The browser's EventSource reconnects on
// its own after an error, so we don't hand-roll backoff. A slow fallback poll
// runs alongside as a safety net — for a wedged/blocked stream, and for the brief
// zero-downtime-deploy window where a notification may be created on a different
// backend instance than the one holding this stream.

// The slice of the browser EventSource we depend on — kept minimal so a test can
// supply a plain fake without pulling in the DOM lib.
export type StreamSource = {
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close: () => void;
};

export type StreamDeps = {
  // Opens the SSE connection. Production binds
  //   () => new EventSource(`${apiBase}/api/notifications/stream`, { withCredentials: true })
  openSource: () => StreamSource;
  // Refetch notifications. Production binds the hook's refresh().
  refresh: () => void;
  // Schedule the recurring fallback poll. Injectable so tests drive it without a
  // real timer. The returned handle is passed back to clearFallback on stop.
  scheduleFallback: (fn: () => void, ms: number) => unknown;
  clearFallback: (handle: unknown) => void;
  fallbackMs?: number;
};

// Fallback poll cadence. Deliberately slow: the SSE stream is the primary path,
// so this only has to catch a dropped stream or the deploy-window gap.
export const FALLBACK_POLL_MS = 60_000;

export type StreamHandle = { stop: () => void };

export function startNotificationsStream(deps: StreamDeps): StreamHandle {
  const source = deps.openSource();
  source.onmessage = () => deps.refresh();
  // EventSource auto-reconnects after an error; there's nothing to do but let it.
  // The fallback poll below covers the window while the stream is down.
  source.onerror = () => {};
  const fallback = deps.scheduleFallback(
    () => deps.refresh(),
    deps.fallbackMs ?? FALLBACK_POLL_MS
  );
  let stopped = false;
  return {
    stop() {
      if (stopped) return; // idempotent: React cleanup + a manual stop can overlap
      stopped = true;
      try {
        // Drop the handlers before closing so no already-queued event can fire
        // refresh() after teardown; close() then stops the connection.
        source.onmessage = null;
        source.onerror = null;
        source.close();
      } catch {
        // already closed — ignore
      }
      deps.clearFallback(fallback);
    },
  };
}
