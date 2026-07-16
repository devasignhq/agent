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

// A fake EventSource: lets a test wire the handlers and push a message.
function fakeSource() {
  const s: any = {
    onmessage: null,
    onerror: null,
    closed: false,
    close() {
      s.closed = true;
    },
    emit(data: string) {
      if (s.onmessage) s.onmessage({ data });
    },
  };
  return s as StreamSource & { closed: boolean; emit: (data: string) => void };
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
});
