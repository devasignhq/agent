// Durability-barrier finalization, the failure path of the write-durability
// middleware (durability.ts). The regression this locks down: when the staged
// writes can't be persisted AND the response has already flushed its headers,
// the handler must NOT drop the buffered body — it can no longer signal 503, but
// it must still forward the body to res.end so the response ends cleanly instead
// of being truncated. Run: node --import tsx/esm --test src/durability.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { finishNotDurable } from "./durability.js";

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
