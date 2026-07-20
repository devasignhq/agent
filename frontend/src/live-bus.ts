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
//
// This is a port of contributor/src/live-bus.ts. The apps are separate packages
// with no shared module, so the file is copied rather than imported — the same
// arrangement notifications-stream.ts already has. Keep the two in step.

// What a consumer can subscribe to. One topic per independently-refetchable
// slice of app data, NOT one per page.
export type Topic = "notifications" | "reviews" | "bounties" | "wallet";
export const ALL_TOPICS: readonly Topic[] = ["notifications", "reviews", "bounties", "wallet"];

// Frame `type` values the backend may send (backend/src/notifications-stream.ts).
export type FrameType =
  | "notifications-changed"
  | "notifications-read"
  | "bounties-changed"
  | "wallet-changed";

// The whole routing policy, in one readable object — "what does frame X
// refresh?" is answered by reading this rather than by tracing control flow.
export const TOPIC_ROUTES: Record<FrameType, readonly Topic[]> = {
  // A notification for a sponsor is nearly always about a review: notifyForReview
  // fires when a PR joins the queue and again when it reaches a terminal verdict,
  // which are exactly the two moments the queue must reflect. So this frame also
  // refreshes the review list — that is what lets the Agent page stop polling.
  "notifications-changed": ["notifications", "reviews"],
  // Emitted by markAllRead only: read-state flipped, no entity moved.
  "notifications-read": ["notifications"],
  "bounties-changed": ["bounties"],
  // A payout confirming changes the ledger AND the bounty's status/paidAt.
  "wallet-changed": ["wallet", "bounties"],
};

// How long to collect frames before refetching. The dominant cost control on
// the client: one logical server action can emit several frames, and without a
// window each one would cost a full round of refetches.
export const DEBOUNCE_MS = 250;

// The reviews topic gets a deliberately LONGER window. It replaces a 3s poll, so
// a 250ms window could in the worst case refetch ~12x more often than the thing
// it replaced — the opposite of the point. This screen has a documented
// refetch-storm history (see the pickedId note in screen-agent.tsx), so the
// window is sized to stay comfortably under the old cadence.
export const REVIEWS_DEBOUNCE_MS = 1_000;

export function windowFor(topics: Iterable<Topic>, base: number): number {
  for (const t of topics) if (t === "reviews") return Math.max(base, REVIEWS_DEBOUNCE_MS);
  return base;
}

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
    const ms = windowFor(dirty, deps.debounceMs ?? DEBOUNCE_MS);
    timer = deps.setTimer(() => {
      // The timer has fired, so there is nothing left to clear — null it BEFORE
      // flushing so flush's disarm is a no-op and clearTimer isn't called on a
      // spent handle.
      timer = null;
      flush();
    }, ms);
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
      // Most of this app's screens carry `// @ts-nocheck`, so a mistyped topic
      // would not be caught at build time the way it is elsewhere — it would
      // just silently never fire. Surface it loudly at subscribe time instead.
      if (!ALL_TOPICS.includes(topic)) {
        console.error(
          `[live] unknown topic "${topic}" — subscription will never fire. Expected one of: ${ALL_TOPICS.join(", ")}`
        );
      }
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
