// Routing + coalescing layer between the SSE stream and the app's data fetches.
// notifications-stream.ts owns the connection; this owns the question "given a
// frame, what needs refetching, and how often are we willing to do it".
//
// Why a bus rather than wiring the stream straight to a refetch: the frame is a
// SIGNAL, not a payload — the server only says something changed, and each
// consumer refetches through its normal REST endpoint. That keeps the stream
// from duplicating the API's shaping or its authorization, but it means one
// frame can fan out to several independent fetches, and a burst of frames must
// not fan out several times over. Hence the dirty set + one debounce window.
//
// Deliberately dependency-free: no React, no DOM, no EventSource, no api client.
// All timers are injected, so live-bus.test.ts drives the whole thing under
// `node --test` with a fake — the house pattern (see notifications-stream.ts).

// What a consumer can subscribe to. One topic per independently-refetchable
// slice of app data, NOT one per page — the dashboard, the bounties page and the
// sidebar all read the same list, so they share the "bounties" topic and one
// refetch serves all three.
export type Topic = "notifications" | "bounties" | "wallet";
export const ALL_TOPICS: readonly Topic[] = ["notifications", "bounties", "wallet"];

// Frame `type` values the backend may send. Today it emits only the two
// notifications-* variants (backend/src/notifications-stream.ts); the other two
// are forward declarations so that when the backend starts emitting real
// per-entity frames, the client already routes them correctly with no change
// here beyond deleting the interim comment below.
export type FrameType =
  | "notifications-changed"
  | "notifications-read"
  | "bounties-changed"
  | "wallet-changed"
  | "security-changed";

// The whole routing policy, in one readable object — "what does frame X
// refresh?" is answered by reading this rather than by tracing control flow.
// Exported so the tests assert against it directly.
export const TOPIC_ROUTES: Record<FrameType, readonly Topic[]> = {
  // Interim over-fetch, on purpose. Today a "notifications-changed" frame is the
  // ONLY signal a contributor's state moved, and all four backend sites that
  // push one to a contributor (application approved, submission rejected, bounty
  // paid, review complete) also change that contributor's bounty — one of them,
  // paid, moves the wallet ledger too. So the safe reading of this frame is
  // "something happened to you". Narrows to ["notifications"] once the backend
  // emits real bounties-changed / wallet-changed frames.
  "notifications-changed": ALL_TOPICS,
  // Emitted by markAllRead only: read-state flipped, no entity moved.
  "notifications-read": ["notifications"],
  "bounties-changed": ["bounties"],
  // A payout confirming changes the ledger AND the bounty's status/paidAt.
  "wallet-changed": ["wallet", "bounties"],
  // Sponsor-app-only signal (the Security page). Contributors never receive it
  // — the backend audience is sponsor userIds — but knowing the type keeps a
  // stray frame from tripping the unknown-frame refresh-everything fallback.
  "security-changed": [],
};

// How long to collect frames before refetching. The dominant cost control on
// the client: one logical server action can emit several frames, and without a
// window each one would cost a full round of refetches.
export const DEBOUNCE_MS = 250;

export type BusDeps = {
  // Injected so tests drive the window with a fake instead of a real timer.
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  debounceMs?: number;
  // Called with the raw payload for a frame we couldn't parse or whose type we
  // don't know. Diagnostics only — the bus still refreshes (see deliver).
  onUnroutedFrame?: (raw: string) => void;
};

export type LiveBus = {
  // Feed in one raw SSE `data:` payload. Parses, routes, arms the window.
  deliver: (raw: string) => void;
  // Mark topics dirty with no frame to route. The reconnect catch-up, the
  // tab-visible refresh and the fallback-poll tick all enter here.
  markDirty: (topics: readonly Topic[]) => void;
  // Run every dirty topic's subscribers now and disarm the window.
  flush: () => void;
  // Returns an unsubscribe. Several subscribers per topic is fine.
  subscribe: (topic: Topic, fn: () => void) => () => void;
  // Disarm a pending flush and drop the dirty set, keeping subscriptions — so a
  // queued refetch can't fire against a session that just ended.
  cancelPending: () => void;
  // cancelPending + drop subscribers + latch closed: later deliver/markDirty are
  // no-ops. Idempotent, mirroring startNotificationsStream's stop().
  stop: () => void;
};

export function createLiveBus(deps: BusDeps): LiveBus {
  const subscribers = new Map<Topic, Set<() => void>>();
  const dirty = new Set<Topic>();
  let timer: unknown = null;
  let stopped = false;

  // Fixed window, NOT sliding: the first dirty mark after an idle period arms
  // the timer and later marks join the existing window without re-arming it. A
  // sliding debounce (clear + re-arm on every frame) can starve the refetch
  // indefinitely under a steady frame rate; this bounds refresh latency at
  // debounceMs no matter how fast frames arrive.
  function arm(): void {
    if (timer !== null) return;
    timer = deps.setTimer(() => {
      // The timer has fired, so there is nothing left to clear — null it BEFORE
      // flushing so flush's disarm is a no-op and clearTimer isn't called on a
      // spent handle.
      timer = null;
      flush();
    }, deps.debounceMs ?? DEBOUNCE_MS);
  }

  function disarm(): void {
    if (timer === null) return;
    deps.clearTimer(timer);
    timer = null;
  }

  function flush(): void {
    disarm();
    if (dirty.size === 0) return;
    // Snapshot then clear before invoking anyone: a subscriber that marks a
    // topic dirty re-entrantly should arm a NEW window, not mutate the set we're
    // iterating.
    const topics = [...dirty];
    dirty.clear();
    for (const topic of topics) {
      const set = subscribers.get(topic);
      if (!set) continue;
      // Copy — a subscriber may unsubscribe itself while being notified.
      for (const fn of [...set]) {
        try {
          fn();
        } catch (err) {
          // One bad handler must not strand the other topics' refetches.
          console.warn(`[live] subscriber for "${topic}" threw:`, err);
        }
      }
    }
  }

  function markDirty(topics: readonly Topic[]): void {
    if (stopped || topics.length === 0) return;
    for (const t of topics) dirty.add(t);
    arm();
  }

  function deliver(raw: string): void {
    if (stopped) return;
    const type = frameType(raw);
    if (type === null) {
      // Unparseable, or a type we don't know yet. Refresh EVERYTHING rather than
      // ignore it: the pre-bus client refreshed on any message at all, so this
      // preserves that floor and keeps a backend-first deploy safe — a new frame
      // type still refreshes an old client instead of silently going stale until
      // the fallback poll. The debounce bounds what that costs.
      deps.onUnroutedFrame?.(raw);
      markDirty(ALL_TOPICS);
      return;
    }
    markDirty(TOPIC_ROUTES[type]);
  }

  return {
    deliver,
    markDirty,
    flush,
    subscribe(topic, fn) {
      let set = subscribers.get(topic);
      if (!set) {
        set = new Set();
        subscribers.set(topic, set);
      }
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) subscribers.delete(topic);
      };
    },
    cancelPending() {
      disarm();
      dirty.clear();
    },
    stop() {
      if (stopped) return; // idempotent: React cleanup and a manual stop overlap
      stopped = true;
      disarm();
      dirty.clear();
      subscribers.clear();
    },
  };
}

// The frame's `type` if it's one we route, else null (caller falls back to a
// full refresh). Tolerates anything on the wire — a truncated frame during a
// deploy must not throw inside an SSE handler.
function frameType(raw: string): FrameType | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  return Object.prototype.hasOwnProperty.call(TOPIC_ROUTES, type)
    ? (type as FrameType)
    : null;
}
