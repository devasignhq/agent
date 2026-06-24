// Durability barrier middleware.
//
// The store applies writes to its in-memory cache synchronously and persists
// them to Postgres on a debounce, so a response could otherwise be sent —
// telling the client a review/charge succeeded — while that write was still
// only in RAM. A redeploy or crash in that window dropped it (the recurring
// "reviewed PRs vanish after a deploy" bug). We close the window at the one
// chokepoint every response funnels through (res.end): hold the response until
// the staged writes have reached Postgres. flushPending() is bounded and a no-op
// when nothing is staged (and in ephemeral mode), so read-heavy GET traffic pays
// ~nothing. If the writes genuinely can't be persisted, fail the request rather
// than acknowledge a write that isn't durable — the writes stay staged and the
// heartbeat keeps retrying.
//
// Extracted from server.ts so the failure-finalization logic below is unit
// testable (see durability.test.ts), in particular the headers-already-sent
// branch.
import type { NextFunction, Request, Response } from "express";
import { dbHealth, flushPending } from "./db.js";

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
  pendingWrites: () => number;
};

export function makeDurabilityBarrier(deps: DurabilityDeps) {
  return function durabilityBarrier(_req: Request, res: Response, next: NextFunction): void {
    const origEnd = res.end.bind(res) as EndFn;
    let gated = false;
    (res as unknown as { end: EndFn }).end = (...args: unknown[]) => {
      if (gated) return origEnd(...args);
      gated = true;
      deps.flushPending().then(
        () => {
          // Writes that genuinely couldn't be persisted (DB unreachable) must not
          // be acknowledged as success. finishNotDurable handles the already-sent
          // case by forwarding the buffered body instead of dropping it — so this
          // branch is correct whether or not headers have gone out.
          if (deps.pendingWrites() > 0) return finishNotDurable(res, origEnd, args);
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
  pendingWrites: () => dbHealth().pendingWrites,
});
