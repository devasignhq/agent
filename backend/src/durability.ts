// Durability barrier middleware.
//
// The store applies writes to its in-memory cache synchronously and persists
// them to Postgres on a debounce, so a response could otherwise be sent —
// telling the client a review/charge succeeded — while that write was still
// only in RAM. A redeploy or crash in that window dropped it (the recurring
// "reviewed PRs vanish after a deploy" bug). We close the window at the one
// chokepoint every response funnels through (res.end): hold the response until
// the staged writes have reached Postgres. If the writes genuinely can't be
// persisted, fail the request rather than acknowledge a write that isn't durable
// — the writes stay staged and the heartbeat keeps retrying.
//
// ONLY state-changing requests are gated. Reads (GET/HEAD/OPTIONS) bypass the
// barrier completely and are served from the in-memory cache, so a write backlog
// or an unreachable DB degrades writes alone — it can never take reads down. An
// earlier version gated every response on the GLOBAL pending-write count, which
// turned a DB hiccup into a full outage (reads + /favicon.ico all 503'd).
//
// Extracted from server.ts so the failure-finalization logic below is unit
// testable (see durability.test.ts), in particular the headers-already-sent
// branch.
import type { NextFunction, Request, Response } from "express";
import { flushPending, persistenceFailing } from "./db.js";

type EndFn = (...args: unknown[]) => unknown;

/**
 * Complete a response whose staged writes could NOT be made durable.
 *
 *  • Headers not yet sent — we can still signal failure: replace the body with a
 *    clean 503 + JSON error.
 *  • Headers already flushed — the status line and headers are gone, so we can
 *    neither switch to 503 nor rewrite the body. Forward the response's OWN
 *    buffered body (`args`, exactly what the caller passed to res.end) to the
 *    real res.end so the stream ends cleanly instead of being TRUNCATED. A
 *    truncated/empty response is strictly worse than a completed one; the write
 *    stays staged and the heartbeat keeps retrying durability either way.
 *
 * `origEnd` is the real (bound) res.end; `args` are the body/encoding/callback
 * the caller handed the wrapped res.end.
 */
export function finishNotDurable(res: Response, origEnd: EndFn, args: unknown[]): unknown {
  if (res.headersSent) {
    // Cannot signal 503 once headers are out — forward the buffered body rather
    // than dropping it (the bug this guard fixes).
    return origEnd(...args);
  }
  res.statusCode = 503;
  res.removeHeader("Content-Length");
  res.removeHeader("ETag");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Rewrite the body to a 503, but preserve any res.end(..., callback) the caller
  // passed: that callback fires only when res.end completes and may resolve a
  // promise or free a resource, so dropping it can hang the request.
  const body = JSON.stringify({ error: "not_durable", message: "write not yet persisted — please retry" });
  const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
  return cb ? origEnd(body, "utf8", cb) : origEnd(body);
}

// The store dependencies the barrier needs. Injectable purely so the wrapper's
// own routing (deciding success-forward vs. finishNotDurable) is unit testable
// without a live Postgres or a slow real flush failure — production binds them to
// the real db functions below, so runtime behaviour is unchanged.
export type DurabilityDeps = {
  flushPending: () => Promise<void>;
  // True only when writes are genuinely failing to persist (a flush errored and
  // hasn't recovered) — NOT merely a non-zero global backlog, which is normal
  // under concurrent load and drains on its own. Gating the 503 on this instead
  // of the global pending count is what stops the spurious `not_durable`.
  persistenceFailing: () => boolean;
};

// Methods that never change state. These are served from the in-memory cache and
// must NEVER be held or failed by the durability barrier: gating them meant a
// write backlog (or an unreachable DB) took the whole app down — reads, billing,
// even /favicon.ico returned 503 — instead of degrading writes alone. Durability
// only matters for requests that actually persist something.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function makeDurabilityBarrier(deps: DurabilityDeps) {
  return function durabilityBarrier(req: Request, res: Response, next: NextFunction): void {
    // Reads bypass the barrier entirely — no flush, no 503, no added latency.
    // Only state-changing requests (POST/PUT/PATCH/DELETE, incl. webhooks) need
    // their writes durable before we acknowledge success.
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();

    const origEnd = res.end.bind(res) as EndFn;
    let gated = false;
    (res as unknown as { end: EndFn }).end = (...args: unknown[]) => {
      if (gated) return origEnd(...args);
      gated = true;
      deps.flushPending().then(
        () => {
          // flushPending() has drained THIS request's writes to Postgres (its loop
          // runs until the backlog it saw is empty). Only fail the response if the
          // flush genuinely couldn't persist — a real outage, surfaced by
          // persistenceFailing(). A non-zero global backlog from a concurrent
          // keeper/worker write is NOT a failure and must not 503 this request.
          // finishNotDurable handles the already-sent case by forwarding the
          // buffered body instead of dropping it — correct either way.
          if (deps.persistenceFailing()) return finishNotDurable(res, origEnd, args);
          return origEnd(...args);
        },
        (err) => {
          console.error("[server] durability flush failed — responding 503", err);
          return finishNotDurable(res, origEnd, args);
        }
      );
      return res;
    };
    next();
  };
}

// Production middleware: the real store-backed durability barrier.
export const durabilityBarrier = makeDurabilityBarrier({
  flushPending,
  persistenceFailing,
});
