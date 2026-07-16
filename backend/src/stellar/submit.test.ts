// confirmTransaction must read the RPC's raw getTransaction status WITHOUT
// decoding resultMetaXdr — since Protocol 23 the meta is TransactionMetaV4, which
// the pinned @stellar/stellar-sdk can't parse (it threw `Bad union switch: 4` and
// wedged every funded bounty at PENDING). These drive it with a stubbed global
// fetch so no network is touched. Run:
//   node --import tsx/esm --test src/stellar/submit.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { confirmTransaction } from "./submit.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Stub the JSON-RPC endpoint with a raw getTransaction `result` payload.
function stubRpc(result: unknown, opts: { ok?: boolean } = {}): void {
  globalThis.fetch = (async () => ({
    ok: opts.ok ?? true,
    async json() {
      return { jsonrpc: "2.0", id: 1, result };
    },
  })) as unknown as typeof fetch;
}

test("SUCCESS with a (bogus) V4 resultMetaXdr present → success, meta never decoded", async () => {
  // A resultMetaXdr the SDK would choke on. Reaching `success` proves we never
  // touch it — decoding this would throw, as it does in production.
  stubRpc({
    status: "SUCCESS",
    ledger: 3633553,
    resultXdr: "AAAAAAAAAGQAAAAA",
    resultMetaXdr: "AAAABExxxNOT_REAL_V4_META",
    events: {},
  });
  const r = await confirmTransaction("b2353e9e");
  assert.deepEqual(r, { status: "success", ledger: 3633553 });
});

test("FAILED → failed, error carries the raw resultXdr string (no XDR decode)", async () => {
  stubRpc({ status: "FAILED", resultXdr: "RESULT_XDR_B64", resultMetaXdr: "AAAABAbad" });
  const r = await confirmTransaction("deadbeef");
  assert.equal(r.status, "failed");
  assert.match((r as { error: string }).error, /RESULT_XDR_B64/);
});

test("NOT_FOUND → not_found (still-pending / retryable)", async () => {
  stubRpc({ status: "NOT_FOUND" });
  assert.deepEqual(await confirmTransaction("abc"), { status: "not_found" });
});

test("network error → not_found, never throws", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await confirmTransaction("abc"), { status: "not_found" });
});

test("non-200 RPC response → not_found", async () => {
  stubRpc({ status: "SUCCESS", ledger: 1 }, { ok: false });
  assert.deepEqual(await confirmTransaction("abc"), { status: "not_found" });
});

test("malformed body (no result.status) → not_found", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    async json() {
      return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } };
    },
  })) as unknown as typeof fetch;
  assert.deepEqual(await confirmTransaction("abc"), { status: "not_found" });
});
