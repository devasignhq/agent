// The one place the app opens a live connection. Binds the transport
// (notifications-stream.ts) to the router (live-bus.ts) with real browser deps,
// gates the connection on the session, and hands consumers a subscribe hook.
//
// Deliberately thin: no decisions live here. Routing policy is TOPIC_ROUTES and
// coalescing is the bus's fixed window, both of which are covered by
// live-bus.test.ts — this file is the untestable-by-design seam (no jsdom in
// `node --test`), so it is kept mechanical enough to verify by reading.
//
// One connection per tab is the invariant. Here the provider mounts in App(),
// OUTSIDE AppContent — that component early-returns for loading / auth /
// unavailable / onboarding, so mounting inside it would drop and re-open the
// connection on every stage flip (including onboarding→app, the worst moment).
// It is also why useNotifications no longer opens a stream of its own.
//
// Ported from contributor/src/live-context.tsx. The apps are separate packages
// with no shared module, so this is a copy — keep the two in step.
import React from "react";
import { apiBase, tabId } from "./api";
import { useAuth } from "./auth-context";
import { startNotificationsStream } from "./notifications-stream";
import { createLiveBus, ALL_TOPICS, type LiveBus, type Topic } from "./live-bus";

const Ctx = React.createContext<LiveBus | null>(null);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const enabled = auth.status === "signed_in";

  // The bus outlives the connection: consumers subscribe on mount and stay
  // subscribed across sign-in/sign-out flips, so only the socket is auth-gated.
  // Held in a ref (not state) so the context value never changes identity and
  // the provider can't re-render the tree beneath it.
  const busRef = React.useRef<LiveBus | null>(null);
  if (!busRef.current) {
    busRef.current = createLiveBus({
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onUnroutedFrame: (raw) => console.debug("[live] unrouted frame:", raw),
    });
  }

  React.useEffect(() => {
    const bus = busRef.current!;
    if (!enabled) return;
    const stream = startNotificationsStream({
      openSource: () =>
        // The tab id rides the URL because EventSource can't set headers. It
        // identifies this connection so a write THIS tab caused doesn't push
        // back to it (see api.ts).
        new EventSource(`${apiBase}/api/notifications/stream?tab=${encodeURIComponent(tabId)}`, {
          withCredentials: true,
        }),
      // A frame carries data and can be routed by type; a fallback tick can't
      // know what moved, so it conservatively refreshes everything.
      refresh: (data) => (data === undefined ? bus.markDirty(ALL_TOPICS) : bus.deliver(data)),
      scheduleFallback: (fn, ms) => setInterval(fn, ms),
      clearFallback: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      // Frames sent while we were disconnected are gone — catch up wholesale.
      onReconnect: () => bus.markDirty(ALL_TOPICS),
      // A hidden tab still receives pushes over the open stream, so polling it
      // buys nothing; the visibilitychange handler below covers the return.
      shouldFallbackTick: () => document.visibilityState !== "hidden",
    });
    const onVis = () => {
      if (document.visibilityState === "visible") bus.markDirty(ALL_TOPICS);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stream.stop();
      document.removeEventListener("visibilitychange", onVis);
      // Never leave a refetch armed across a sign-out — it would fire against a
      // dead session and log a 401. Subscriptions survive for the next sign-in.
      bus.cancelPending();
    };
  }, [enabled]);

  // Note there is no bus.stop() here. Under <React.StrictMode> (main.tsx) an
  // effect runs mount → unmount → mount, so a stop-on-unmount cleanup would
  // latch the bus permanently dead in dev after the first cycle. The bus holds
  // at most one 250ms timer, and the provider only unmounts at page teardown.
  return <Ctx.Provider value={busRef.current}>{children}</Ctx.Provider>;
}

export function useLiveBus(): LiveBus {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useLiveBus must be used inside <LiveProvider>");
  return v;
}

// Refetch `fn` whenever the server signals this topic changed. The subscription
// is scoped to the calling component, so a page that isn't mounted costs nothing.
export function useLiveTopic(topic: Topic, fn: () => void): void {
  const bus = useLiveBus();
  // Route through a ref so an inline arrow (a new identity every render) doesn't
  // churn the subscription — the effect depends only on the bus and the topic.
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => bus.subscribe(topic, () => ref.current()), [bus, topic]);
}
