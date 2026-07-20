// Unit tests for the per-request tab scope (request-context.ts): the store
// survives async hops, returns null outside a scope (the background-job case),
// and rejects malformed client-supplied tab ids rather than trusting them.
// Run: node --import tsx/esm --test src/request-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import {
  TAB_HEADER,
  currentTabId,
  requestContext,
  sanitizeTabId,
  withRequestContext,
} from "./request-context.js";

// Minimal Request stub: only req.get(header) is used by the middleware.
function fakeReq(headers: Record<string, string>): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

test("currentTabId is null outside a request scope", () => {
  // The keeper / webhook / review-worker case: no acting tab, so exclude nobody.
  assert.equal(currentTabId(), null);
});

test("the scope is visible to the whole async call graph below it", async () => {
  const seen: Array<string | null> = [];
  await withRequestContext({ tabId: "tab-a" }, async () => {
    seen.push(currentTabId());
    await Promise.resolve();
    seen.push(currentTabId()); // still in scope after an await
    await new Promise((r) => setTimeout(r, 1));
    seen.push(currentTabId()); // and after a macrotask
  });
  assert.deepEqual(seen, ["tab-a", "tab-a", "tab-a"]);
  assert.equal(currentTabId(), null, "the scope must not leak past the callback");
});

test("concurrent scopes don't bleed into each other", async () => {
  const [a, b] = await Promise.all([
    withRequestContext({ tabId: "aaa" }, async () => {
      await new Promise((r) => setTimeout(r, 5)); // finish AFTER the other one
      return currentTabId();
    }),
    withRequestContext({ tabId: "bbb" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTabId();
    }),
  ]);
  assert.deepEqual([a, b], ["aaa", "bbb"]);
});

test("sanitizeTabId accepts a randomUUID and rejects anything malformed", () => {
  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  assert.equal(sanitizeTabId(uuid), uuid);
  assert.equal(sanitizeTabId("  " + uuid + "  "), uuid, "trims surrounding space");
  assert.equal(sanitizeTabId("abc_DEF-123"), "abc_DEF-123");

  assert.equal(sanitizeTabId(""), null);
  assert.equal(sanitizeTabId("   "), null);
  assert.equal(sanitizeTabId(undefined), null);
  assert.equal(sanitizeTabId(42), null);
  assert.equal(sanitizeTabId("has space"), null);
  assert.equal(sanitizeTabId("semi;colon"), null);
  assert.equal(sanitizeTabId("x".repeat(65)), null, "length is capped");
  assert.equal(sanitizeTabId("x".repeat(64)), "x".repeat(64), "…at exactly 64");
});

test("the middleware opens a scope carrying the header's tab id", () => {
  let insideNext: string | null = "unset";
  const next = (() => {
    insideNext = currentTabId();
  }) as NextFunction;
  requestContext(fakeReq({ [TAB_HEADER]: "tab-xyz" }), {} as Response, next);
  assert.equal(insideNext, "tab-xyz");
});

test("a request with no (or a bad) tab header still runs, excluding nobody", () => {
  const run = (headers: Record<string, string>) => {
    let seen: string | null = "unset";
    requestContext(fakeReq(headers), {} as Response, (() => {
      seen = currentTabId();
    }) as NextFunction);
    return seen;
  };
  assert.equal(run({}), null, "curl / webhook: no header at all");
  assert.equal(run({ [TAB_HEADER]: "not a valid id" }), null, "malformed degrades to null");
});
