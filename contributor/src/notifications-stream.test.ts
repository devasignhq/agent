// Unit tests for the notifications live-stream controller (notifications-stream.ts):
// it refreshes on each SSE message, schedules the fallback poll at the default
// cadence, and tears both down exactly once on stop(). No DOM / real EventSource —
// startNotificationsStream takes plain injected deps (fake source + fake timer).
// Run with:
//   node --test src/notifications-stream.test.ts   (Node >=22 strips the types)
//   npm test                                        (globs all src/**/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startNotificationsStream,
  FALLBACK_POLL_MS,
  type StreamSource,
} from "./notifications-stream.ts";

// A fake EventSource: lets a test wire the handlers, push a message, and
// simulate the connect/reconnect that a real EventSource signals via onopen.
function fakeSource() {
  const s: any = {
    onmessage: null,
    onerror: null,
    onopen: null,
    closed: false,
    close() {
      s.closed = true;
    },
    emit(data: string) {
      if (s.onmessage) s.onmessage({ data });
    },
    open() {
      if (s.onopen) s.onopen();
    },
  };
  return s as StreamSource & {
    closed: boolean;
    emit: (data: string) => void;
    open: () => void;
  };
}

test("opens the stream and refreshes on each message", () => {
  const source = fakeSource();
  let refreshes = 0;
  const handle = startNotificationsStream({
    openSource: () => source,
    refresh: () => {
      refreshes++;
    },
    scheduleFallback: () => 0,
    clearFallback: () => {},
  });
  assert.equal(typeof source.onmessage, "function");
  source.emit("{}");
  source.emit("{}");
  assert.equal(refreshes, 2);
  handle.stop();
});

test("schedules the fallback poll at the default cadence and it refreshes", () => {
  const source = fakeSource();
  let refreshes = 0;
  let scheduledMs = -1;
  let scheduledFn: (() => void) | null = null;
  startNotificationsStream({
    openSource: () => source,
    refresh: () => {
      refreshes++;
    },
    scheduleFallback: (fn, ms) => {
      scheduledFn = fn;
      scheduledMs = ms;
      return 7;
    },
    clearFallback: () => {},
  });
  assert.equal(scheduledMs, FALLBACK_POLL_MS);
  scheduledFn!(); // drive one fallback tick
  assert.equal(refreshes, 1);
});

test("stop() closes the source and clears the fallback exactly once, and silences late events", () => {
  const source = fakeSource();
  let refreshes = 0;
  const cleared: unknown[] = [];
  const handle = startNotificationsStream({
    openSource: () => source,
    refresh: () => {
      refreshes++;
    },
    scheduleFallback: () => 42,
    clearFallback: (h) => {
      cleared.push(h);
    },
  });
  handle.stop();
  handle.stop(); // idempotent — a manual stop and React cleanup can overlap
  assert.equal(source.closed, true);
  assert.deepEqual(cleared, [42]);
  source.emit("{}"); // a message queued after teardown must not trigger a refresh
  assert.equal(refreshes, 0);
  assert.equal(source.onopen, null); // nor may a reconnect landing mid-teardown
});

test("refresh receives the raw frame payload, and the fallback tick receives nothing", () => {
  // This is how the caller tells a routable frame from a blind poll: a frame
  // carries data, a poll doesn't.
  const source = fakeSource();
  const seen: Array<string | undefined> = [];
  let scheduledFn: (() => void) | null = null;
  startNotificationsStream({
    openSource: () => source,
    refresh: (data) => {
      seen.push(data);
    },
    scheduleFallback: (fn) => {
      scheduledFn = fn;
      return 0;
    },
    clearFallback: () => {},
  });
  source.emit('{"type":"bounties-changed"}');
  scheduledFn!();
  assert.deepEqual(seen, ['{"type":"bounties-changed"}', undefined]);
});

test("onReconnect fires on a re-open but not on the first connect", () => {
  const source = fakeSource();
  let reconnects = 0;
  startNotificationsStream({
    openSource: () => source,
    refresh: () => {},
    scheduleFallback: () => 0,
    clearFallback: () => {},
    onReconnect: () => {
      reconnects++;
    },
  });
  source.open(); // initial connect — whatever mounted the stream already fetched
  assert.equal(reconnects, 0);
  source.open(); // healed after a drop — we may have missed frames
  assert.equal(reconnects, 1);
  source.open();
  assert.equal(reconnects, 2);
});

test("shouldFallbackTick gates the poll without unscheduling it", () => {
  const source = fakeSource();
  let refreshes = 0;
  let allow = false;
  let scheduledFn: (() => void) | null = null;
  startNotificationsStream({
    openSource: () => source,
    refresh: () => {
      refreshes++;
    },
    scheduleFallback: (fn) => {
      scheduledFn = fn;
      return 0;
    },
    clearFallback: () => {},
    shouldFallbackTick: () => allow,
  });
  scheduledFn!();
  assert.equal(refreshes, 0, "a gated-off tick must not refresh");
  allow = true;
  scheduledFn!();
  assert.equal(refreshes, 1, "the same schedule must still tick once re-allowed");
});
