// Per-request ambient context, so a write deep in the call graph can tell WHICH
// browser tab caused it without every function on the way down taking an extra
// argument.
//
// The one consumer today is live-push actor exclusion: when a contributor clicks
// "Request payout", their own tab already refetches explicitly, so pushing a
// change frame back to that same tab would just buy a second, redundant fetch.
// The tab id lets the fan-out skip exactly that ONE connection while every other
// tab — including the same user's other tabs — still gets the push.
//
// Same AsyncLocalStorage idiom as llm.ts (withModel / withUsage), including the
// important property that it NO-OPS OUTSIDE A SCOPE: the keeper, the webhook
// receivers and the review worker run without a request, so currentTabId()
// returns null there and nobody is excluded. That is exactly right — a
// background job has no "acting tab" to skip.
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

// The header the browser apps send on mutations. EventSource can't set headers,
// so the stream carries the same id as a query param instead (see the /stream
// route) — this is only for the mutating requests.
export const TAB_HEADER = "x-devasign-tab";

export type RequestContext = {
  // Which tab issued this request, or null for a non-browser caller (curl, a
  // webhook delivery, an internal fetch) — those exclude nothing.
  tabId: string | null;
};

const requestStore = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

// The acting tab for the request in flight, or null outside a request scope.
export function currentTabId(): string | null {
  return requestStore.getStore()?.tabId ?? null;
}

// Client-supplied, so treat it as untrusted input: cap the length and allow only
// the charset crypto.randomUUID() produces. A malformed value degrades to null
// (exclude nobody = one redundant fetch), never to an error.
const MAX_TAB_ID_LENGTH = 64;
const TAB_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeTabId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAB_ID_LENGTH) return null;
  return TAB_ID_SHAPE.test(trimmed) ? trimmed : null;
}

// Opens the scope for the rest of the request. next() is invoked INSIDE run() so
// every downstream handler — and everything they await — sees the same store.
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  withRequestContext({ tabId: sanitizeTabId(req.get(TAB_HEADER)) }, () => next());
}
