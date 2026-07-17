// hasUsdcTrustline interpolates `address` into the Horizon /accounts/{id} path,
// so a malformed value could steer the request off that path. Assert a non-G
// address is rejected BEFORE any fetch. Offline: config pinned, global fetch
// stubbed to record calls. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/stellar/trustline-guard.test.ts
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as Stellar from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { hasUsdcTrustline } from "./escrow.js";

const realFetch = globalThis.fetch;
const realIssuer = config.stellar.usdcIssuer;
let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  // A configured issuer is required for the function to reach the trustline path
  // (otherwise it short-circuits true, before the address is ever used).
  config.stellar.usdcIssuer = Stellar.Keypair.random().publicKey();
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    // 404 = account not found; if a valid address ever reaches here it's a miss.
    return { ok: false, status: 404, async json() { return {}; } };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.stellar.usdcIssuer = realIssuer;
});

test("a path-manipulating address is rejected without any fetch", async () => {
  for (const bad of [
    "GABC/../../secret",
    "not-an-address",
    "../admin",
    "G".repeat(56), // right length, wrong checksum → not a valid key
    "",
  ]) {
    const ok = await hasUsdcTrustline(bad);
    assert.equal(ok, false, `${bad} should be rejected`);
  }
  assert.deepEqual(fetched, [], "no fetch should have been issued for any invalid address");
});

test("a well-formed G-address is allowed through to the Horizon lookup", async () => {
  const addr = Stellar.Keypair.random().publicKey();
  await hasUsdcTrustline(addr);
  assert.equal(fetched.length, 1, "a valid address should reach exactly one fetch");
  assert.match(fetched[0], new RegExp(`/accounts/${addr}$`), "the address is the final path segment, unaltered");
});

test("a contract address is allowed and returns true without any fetch", async () => {
  // Contracts hold USDC via the asset contract, not a classic trustline, so the
  // Horizon /accounts gate doesn't apply — don't block, and don't probe.
  const contractAddr = Stellar.StrKey.encodeContract(Buffer.alloc(32, 1));
  const ok = await hasUsdcTrustline(contractAddr);
  assert.equal(ok, true, "contract address should be accepted");
  assert.deepEqual(fetched, [], "no fetch should have been issued for a contract address");
});
