// Locks down the read-resilience added so a brief backend blip (a deploy /
// restart / cold start that drops the API socket for a few seconds) never
// reaches the UI as an error. Idempotent reads retry over the blip; mutations
// never auto-retry (they may have applied server-side); and isTransientApiError
// classifies what the screens are allowed to swallow.
import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, isTransientApiError, NetworkError } from "./api.ts";

// Swap globalThis.fetch for a scripted queue of outcomes. Each entry is either a
// Response to resolve with or an Error to reject with (a network-level failure).
function scriptFetch(outcomes: Array<Response | Error>) {
  let i = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: (init.method || "GET").toUpperCase() });
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("isTransientApiError: network failures and upstream 5xx are transient", () => {
  assert.equal(isTransientApiError(new NetworkError("Failed to fetch")), true);
  assert.equal(isTransientApiError(new NetworkError("Load failed")), true); // Safari
  assert.equal(isTransientApiError(new ApiError(503, "Service Unavailable")), true);
  assert.equal(isTransientApiError(new ApiError(502, "Bad Gateway")), true);
  assert.equal(isTransientApiError(new ApiError(504, "Gateway Timeout")), true);
});

test("isTransientApiError: real HTTP errors and stray runtime errors are NOT transient", () => {
  assert.equal(isTransientApiError(new ApiError(401, "unauthorized")), false);
  assert.equal(isTransientApiError(new ApiError(404, "not_found")), false);
  assert.equal(isTransientApiError(new ApiError(500, "boom")), false);
  // A genuine programming bug must surface, not be swallowed as a network blip.
  assert.equal(isTransientApiError(new TypeError("x is undefined")), false);
  // not_durable rides on mutations and is inspected at the call site — it must
  // not be classed as a swallow-able read blip.
  assert.equal(isTransientApiError(new ApiError(503, "not_durable")), false);
});

test("a read rides over a transient network blip (retries, then succeeds)", async () => {
  const { calls, restore } = scriptFetch([
    new TypeError("Failed to fetch"), // server unreachable (mid-restart)
    json([{ id: "r1" }]),             // …back up on the retry
  ]);
  try {
    const reviews = await api.reviews();
    assert.deepEqual(reviews, [{ id: "r1" }]);
    assert.equal(calls.length, 2, "retried once after the blip");
    assert.equal(calls[0].method, "GET");
  } finally {
    restore();
  }
});

test("a read retries an upstream 502 then succeeds", async () => {
  const { calls, restore } = scriptFetch([
    json({ error: "bad gateway" }, 502),
    json([]),
  ]);
  try {
    const reviews = await api.reviews();
    assert.deepEqual(reviews, []);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("a persistent outage throws a NetworkError after exhausting retries", async () => {
  const { calls, restore } = scriptFetch([new TypeError("Failed to fetch")]);
  try {
    await assert.rejects(() => api.reviews(), (e: unknown) => {
      // The raw fetch TypeError is wrapped so callers can classify it safely.
      assert.ok(e instanceof NetworkError);
      assert.equal(isTransientApiError(e), true);
      return true;
    });
    assert.equal(calls.length, 3, "tried the max number of times");
  } finally {
    restore();
  }
});

test("a mutation is NEVER auto-retried on a network failure", async () => {
  const { calls, restore } = scriptFetch([new TypeError("Failed to fetch")]);
  try {
    // signOut is a POST — retrying could double-apply, so it must fail at once.
    await assert.rejects(() => api.signOut());
    assert.equal(calls.length, 1, "POST failed on the first attempt, no retry");
    assert.equal(calls[0].method, "POST");
  } finally {
    restore();
  }
});

test("a non-retryable HTTP error is not retried and surfaces as an ApiError", async () => {
  const { calls, restore } = scriptFetch([json({ error: "unauthorized" }, 401)]);
  try {
    await assert.rejects(() => api.reviews(), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, 401);
      return true;
    });
    assert.equal(calls.length, 1, "401 is a real answer — no retry");
  } finally {
    restore();
  }
});

test("an aborted request is NOT retried and propagates untouched", async () => {
  const abortError = new DOMException("The user aborted a request.", "AbortError");
  const { calls, restore } = scriptFetch([abortError]);
  try {
    await assert.rejects(() => api.reviews(), (e: unknown) => {
      // Propagated as-is — not wrapped in NetworkError, not classed transient.
      assert.ok(e instanceof DOMException);
      assert.equal((e as DOMException).name, "AbortError");
      return true;
    });
    assert.equal(calls.length, 1, "aborted request failed immediately, no retry");
  } finally {
    restore();
  }
});
