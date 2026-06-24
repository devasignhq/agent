// Durability-barrier finalization, the failure path of the write-durability
// middleware (durability.ts). The regression this locks down: when the staged
// writes can't be persisted AND the response has already flushed its headers,
// the handler must NOT drop the buffered body — it can no longer signal 503, but
// it must still forward the body to res.end so the response ends cleanly instead
// of being truncated. Run: node --import tsx/esm --test src/durability.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { finishNotDurable, makeDurabilityBarrier } from "./durability.js";

// Minimal Express-Response stub that records exactly what reaches res.end.
function makeRes(headersSent: boolean) {
  const calls: unknown[][] = [];
  const headers = new Map<string, unknown>();
  const res = {
    headersSent,
    statusCode: 200,
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    setHeader: (name: string, val: unknown) => headers.set(name.toLowerCase(), val),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Response;
  const origEnd = (...args: unknown[]) => {
    calls.push(args);
    return res;
  };
  return { res, origEnd, calls };
}

test("notDurable (headers NOT sent): replaces the response with a 503 JSON error", () => {
  const { res, origEnd, calls } = makeRes(false);

  finishNotDurable(res, origEnd, ["original-success-body", "utf8"]);

  assert.equal(res.statusCode, 503, "failure is signalled via status");
  assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  assert.equal(calls.length, 1, "res.end called exactly once");
  assert.match(String(calls[0][0]), /not_durable/, "a fresh 503 body is sent");
});

test("notDurable (headers ALREADY sent): forwards the buffered body, never drops it", () => {
  const { res, origEnd, calls } = makeRes(true);
  const cb = () => {};

  finishNotDurable(res, origEnd, ["the-real-body", "utf8", cb]);

  // Status can't change once headers are out — but the body must NOT be dropped.
  assert.equal(res.statusCode, 200, "status left untouched (headers already flushed)");
  assert.equal(calls.length, 1, "res.end still called exactly once");
  assert.deepEqual(
    calls[0],
    ["the-real-body", "utf8", cb],
    "the original body + encoding + callback are forwarded to res.end, not discarded"
  );
});

// --- durabilityBarrier wrapper routing ------------------------------------
// finishNotDurable is covered above; these exercise the WRAPPER's decision to
// route into it, with injected deps so the flush outcome is deterministic (no
// live Postgres, no slow real flush failure).

// Response stub whose `end` is the real terminal the barrier wraps as origEnd.
function makeBarrierRes(headersSent: boolean) {
  const calls: unknown[][] = [];
  const headers = new Map<string, unknown>();
  const res = {
    headersSent,
    statusCode: 200,
    end: (...args: unknown[]) => {
      calls.push(args);
      return res;
    },
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    setHeader: (name: string, val: unknown) => headers.set(name.toLowerCase(), val),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Response;
  return { res, calls };
}

const tick = () => new Promise((r) => setImmediate(r)); // let the flush .then() run

test("durabilityBarrier: pendingWrites>0 + headers already sent → forwards body unchanged", async () => {
  // The exact equivalence the refactor relies on: when the flush resolves but
  // writes are still pending and headers have gone out, the success path routes
  // through finishNotDurable, which must forward the buffered args verbatim.
  const barrier = makeDurabilityBarrier({ flushPending: async () => {}, pendingWrites: () => 1 });
  const { res, calls } = makeBarrierRes(true);

  let nextCalled = false;
  barrier({} as Request, res, (() => (nextCalled = true)) as NextFunction);
  assert.equal(nextCalled, true, "middleware passes control on");

  const cb = () => {};
  (res.end as (...a: unknown[]) => unknown)("streamed-body", "utf8", cb);
  await tick();

  assert.equal(calls.length, 1, "res.end reached exactly once");
  assert.deepEqual(
    calls[0],
    ["streamed-body", "utf8", cb],
    "buffered args forwarded verbatim — no truncation, no 503 rewrite"
  );
  assert.equal(res.statusCode, 200, "status untouched (headers already flushed)");
});

test("durabilityBarrier: pendingWrites>0 + headers NOT sent → 503 (routes into finishNotDurable)", async () => {
  const barrier = makeDurabilityBarrier({ flushPending: async () => {}, pendingWrites: () => 1 });
  const { res, calls } = makeBarrierRes(false);
  barrier({} as Request, res, (() => {}) as NextFunction);

  (res.end as (...a: unknown[]) => unknown)("would-be-success-body");
  await tick();

  assert.equal(res.statusCode, 503, "non-durable write is not acknowledged as success");
  assert.match(String(calls[0][0]), /not_durable/, "503 JSON body sent");
});

test("durabilityBarrier: pendingWrites==0 → normal response forwarded unchanged", async () => {
  const barrier = makeDurabilityBarrier({ flushPending: async () => {}, pendingWrites: () => 0 });
  const { res, calls } = makeBarrierRes(false);
  barrier({} as Request, res, (() => {}) as NextFunction);

  (res.end as (...a: unknown[]) => unknown)("ok-body");
  await tick();

  assert.equal(res.statusCode, 200, "durable write → normal success");
  assert.deepEqual(calls[0], ["ok-body"], "body forwarded unchanged");
});
