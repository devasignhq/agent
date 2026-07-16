// Unit tests for the SSE connection registry (notifications-stream.ts): who a
// change signal reaches, keepalive frames, eviction of a dead socket, and the
// graceful-shutdown teardown. No HTTP — a plain fake Response records the bytes
// written. The registry is module-level shared state, so every test calls
// closeAllStreams() first to isolate.
// Run: node --import tsx/esm --test src/notifications-stream.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import {
  addClient,
  removeClient,
  notifyUser,
  heartbeat,
  closeAllStreams,
  activeStreamCount,
} from "./notifications-stream.js";

// Minimal Response stub: records every written frame, can be made to throw on
// write (a dead socket), and flags when it's ended.
function fakeRes() {
  const r: any = {
    writes: [] as string[],
    ended: false,
    throwOnWrite: false,
    write(s: string) {
      if (r.throwOnWrite) throw new Error("EPIPE");
      r.writes.push(s);
      return true;
    },
    end() {
      r.ended = true;
    },
  };
  return r as Response & { writes: string[]; ended: boolean; throwOnWrite: boolean };
}

const DATA = `data: {"type":"notifications-changed"}\n\n`;
const PING = `: ping\n\n`;

test("notifyUser pushes the change signal to every stream of that user only", () => {
  closeAllStreams();
  const a1 = fakeRes();
  const a2 = fakeRes();
  const b1 = fakeRes();
  addClient("user-a", a1);
  addClient("user-a", a2);
  addClient("user-b", b1);
  assert.equal(activeStreamCount(), 3);

  notifyUser("user-a");
  assert.equal(a1.writes.at(-1), DATA);
  assert.equal(a2.writes.at(-1), DATA);
  assert.equal(b1.writes.includes(DATA), false);

  closeAllStreams();
});

test("removeClient stops delivery and updates the count", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u", r);
  assert.equal(activeStreamCount(), 1);
  removeClient("u", r);
  assert.equal(activeStreamCount(), 0);
  notifyUser("u"); // no registered stream — no delivery, no throw
  assert.equal(r.writes.length, 0);
  closeAllStreams();
});

test("heartbeat writes a comment keepalive to every stream", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u", r);
  heartbeat();
  assert.equal(r.writes.at(-1), PING);
  closeAllStreams();
});

test("a stream whose write throws is evicted; the others keep receiving", () => {
  closeAllStreams();
  const dead = fakeRes();
  const live = fakeRes();
  addClient("u", dead);
  addClient("u", live);
  dead.throwOnWrite = true;

  notifyUser("u");
  assert.equal(activeStreamCount(), 1); // dead was evicted
  assert.equal(live.writes.at(-1), DATA); // live still delivered
  closeAllStreams();
});

test("closeAllStreams ends every connection and clears the registry", () => {
  closeAllStreams();
  const a = fakeRes();
  const b = fakeRes();
  addClient("x", a);
  addClient("y", b);

  closeAllStreams();
  assert.equal(a.ended, true);
  assert.equal(b.ended, true);
  assert.equal(activeStreamCount(), 0);
});
