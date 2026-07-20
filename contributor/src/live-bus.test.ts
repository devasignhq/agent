// Unit tests for the live event bus (live-bus.ts): it routes each frame type to
// the right topics, coalesces a burst into one refetch per subscriber, keeps the
// debounce window fixed rather than sliding, degrades safely on frames it can't
// route, and tears down exactly once. No DOM / real timers — createLiveBus takes
// plain injected deps.
// Run with:
//   node --test src/live-bus.test.ts   (Node >=22 strips the types)
//   npm test                            (globs all src/**/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLiveBus,
  ALL_TOPICS,
  DEBOUNCE_MS,
  type LiveBus,
  type Topic,
} from "./live-bus.ts";

// A fake timer: records how often the window was armed and with what delay, and
// lets a test fire it by hand instead of waiting DEBOUNCE_MS.
function fakeTimer() {
  const t = {
    armed: 0,
    cleared: [] as unknown[],
    ms: -1,
    fn: null as (() => void) | null,
    setTimer(fn: () => void, ms: number): unknown {
      t.armed++;
      t.fn = fn;
      t.ms = ms;
      return t.armed; // a distinguishable handle, so `cleared` is readable
    },
    clearTimer(handle: unknown): void {
      t.cleared.push(handle);
    },
    fire(): void {
      t.fn?.();
    },
  };
  return t;
}

const NONE = { notifications: 0, bounties: 0, wallet: 0 };

// Subscribe a counter to every topic so a test can assert the exact fan-out.
function counters(bus: LiveBus): Record<Topic, number> {
  const n: Record<Topic, number> = { ...NONE };
  for (const topic of ALL_TOPICS) bus.subscribe(topic, () => { n[topic]++; });
  return n;
}

function frame(type: string): string {
  return JSON.stringify({ type });
}

test("a notifications-changed frame fans out to every topic", () => {
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.deliver(frame("notifications-changed"));
  assert.deepEqual(n, NONE, "nothing should fire before the window elapses");
  timer.fire();
  assert.deepEqual(n, { notifications: 1, bounties: 1, wallet: 1 });
});

test("a bounties-changed frame routes to the bounties topic only", () => {
  // The forward-compatibility guarantee: when the backend starts emitting real
  // per-entity frames, this client narrows automatically with no rearchitecting.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.deliver(frame("bounties-changed"));
  timer.fire();
  assert.deepEqual(n, { notifications: 0, bounties: 1, wallet: 0 });
});

test("a notifications-read frame refreshes notifications only", () => {
  // markAllRead flips read-state and nothing else — refetching bounties here
  // would be pure waste on a button the user presses routinely.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.deliver(frame("notifications-read"));
  timer.fire();
  assert.deepEqual(n, { notifications: 1, bounties: 0, wallet: 0 });
});

test("a burst of frames coalesces into a single refetch per subscriber", () => {
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  for (let i = 0; i < 5; i++) bus.deliver(frame("notifications-changed"));
  timer.fire();
  assert.deepEqual(n, { notifications: 1, bounties: 1, wallet: 1 });
});

test("the debounce window is fixed, not sliding", () => {
  // A sliding debounce (clear + re-arm on every frame) can starve the refetch
  // indefinitely under a steady frame rate. Arming once bounds latency at
  // DEBOUNCE_MS regardless of how fast frames arrive.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  counters(bus);
  for (let i = 0; i < 5; i++) bus.deliver(frame("bounties-changed"));
  assert.equal(timer.armed, 1, "later frames must join the open window");
  assert.equal(timer.ms, DEBOUNCE_MS);
  assert.deepEqual(timer.cleared, [], "the window must never be re-armed mid-burst");
});

test("a malformed frame refreshes everything and reports the raw payload", () => {
  const timer = fakeTimer();
  const unrouted: string[] = [];
  const bus = createLiveBus({
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onUnroutedFrame: (raw) => { unrouted.push(raw); },
  });
  const n = counters(bus);
  bus.deliver("not json at all");
  timer.fire();
  assert.deepEqual(n, { notifications: 1, bounties: 1, wallet: 1 });
  bus.deliver(JSON.stringify({ no: "type" }));
  timer.fire();
  assert.deepEqual(n, { notifications: 2, bounties: 2, wallet: 2 });
  assert.deepEqual(unrouted, ["not json at all", '{"no":"type"}']);
});

test("an unknown frame type refreshes everything rather than being dropped", () => {
  // Keeps a backend-first deploy safe: a frame this client build has never heard
  // of still refreshes it, instead of going stale until the fallback poll.
  const timer = fakeTimer();
  const unrouted: string[] = [];
  const bus = createLiveBus({
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onUnroutedFrame: (raw) => { unrouted.push(raw); },
  });
  const n = counters(bus);
  bus.deliver(frame("some-future-thing"));
  timer.fire();
  assert.deepEqual(n, { notifications: 1, bounties: 1, wallet: 1 });
  assert.deepEqual(unrouted, ['{"type":"some-future-thing"}']);
});

test("flush() notifies dirty subscribers immediately and disarms the window", () => {
  // The path used by the reconnect catch-up and the tab-visible refresh.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.markDirty(["bounties"]);
  assert.equal(timer.armed, 1);
  bus.flush();
  assert.deepEqual(n, { notifications: 0, bounties: 1, wallet: 0 });
  assert.deepEqual(timer.cleared, [1], "the pending window must be cleared");
  timer.fire(); // a spent handle firing anyway must not double-refetch
  assert.deepEqual(n, { notifications: 0, bounties: 1, wallet: 0 });
});

test("flush() with nothing dirty notifies no one and arms nothing", () => {
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.flush();
  assert.deepEqual(n, NONE);
  assert.equal(timer.armed, 0);
});

test("every subscriber on a topic fires, and unsubscribe removes exactly one", () => {
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let a = 0;
  let b = 0;
  const offA = bus.subscribe("bounties", () => { a++; });
  bus.subscribe("bounties", () => { b++; });
  bus.markDirty(["bounties"]);
  timer.fire();
  assert.deepEqual([a, b], [1, 1]);
  offA();
  bus.markDirty(["bounties"]);
  timer.fire();
  assert.deepEqual([a, b], [1, 2], "only the unsubscribed one should stop firing");
});

test("a throwing subscriber does not strand the others", () => {
  // Expect one "[live] subscriber ... threw" warning in the test output.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let ran = 0;
  bus.subscribe("bounties", () => { throw new Error("boom"); });
  bus.subscribe("bounties", () => { ran++; });
  bus.markDirty(["bounties"]);
  timer.fire();
  assert.equal(ran, 1);
});

test("cancelPending() drops a queued refetch but keeps subscriptions alive", () => {
  // What the provider calls on sign-out: an armed refetch must not fire against
  // a dead session, but signing back in must not need a fresh subscription.
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.markDirty(["bounties"]);
  bus.cancelPending();
  assert.deepEqual(timer.cleared, [1]);
  timer.fire();
  assert.deepEqual(n, NONE, "the cancelled refetch must not fire");
  bus.markDirty(["bounties"]);
  timer.fire();
  assert.deepEqual(n, { notifications: 0, bounties: 1, wallet: 0 });
});

test("stop() clears the window exactly once and silences later frames", () => {
  const timer = fakeTimer();
  const bus = createLiveBus({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  const n = counters(bus);
  bus.markDirty(["bounties"]);
  bus.stop();
  bus.stop(); // idempotent — React cleanup and a manual stop can overlap
  assert.deepEqual(timer.cleared, [1]);
  bus.deliver(frame("notifications-changed"));
  bus.markDirty(ALL_TOPICS);
  timer.fire();
  assert.deepEqual(n, NONE, "no refetch may fire after teardown");
  assert.equal(timer.armed, 1, "no new window may be armed after teardown");
});
