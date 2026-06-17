// AES-256-GCM seal/open primitives. The key is read live from config, so tests
// drive it by mutating config.encryption.key rather than wrestling with
// import-time env ordering. Run:
//   node --import tsx/esm --test src/crypto/secret-box.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { isSealed, open, seal, type SealedSecret } from "./secret-box.js";

const KEY = "11".repeat(32); // 64 hex chars = 32 bytes

test("seal/open round-trips an object without leaking plaintext", () => {
  config.encryption.key = KEY;
  const value = { accessToken: "lin_oauth_secret", apiKey: "key-123" };
  const sealed = seal(value);
  assert.equal(isSealed(sealed), true);
  assert.deepEqual(open(sealed), value);
  assert.equal(JSON.stringify(sealed).includes("lin_oauth_secret"), false);
});

test("each seal uses a fresh IV, so ciphertext differs for the same input", () => {
  config.encryption.key = KEY;
  assert.notEqual(seal({ t: "x" }).data, seal({ t: "x" }).data);
});

test("a tampered envelope fails the GCM auth tag", () => {
  config.encryption.key = KEY;
  const sealed = seal({ t: "secret" });
  const raw = Buffer.from(sealed.data, "base64");
  raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
  const tampered: SealedSecret = { ...sealed, data: raw.toString("base64") };
  assert.throws(() => open(tampered));
});

test("a different key cannot open the envelope", () => {
  config.encryption.key = KEY;
  const sealed = seal({ t: "secret" });
  config.encryption.key = "22".repeat(32);
  assert.throws(() => open(sealed));
});

test("a present-but-malformed key throws a clear error", () => {
  config.encryption.key = "abc"; // not 64 hex chars
  assert.throws(() => seal({ t: "x" }), /64 hex chars/);
});

test("seal/open without a key configured throws", () => {
  config.encryption.key = "";
  assert.throws(() => seal({ t: "x" }), /INTEGRATION_ENCRYPTION_KEY/);
});

test("isSealed rejects plaintext objects, non-objects, and wrong versions", () => {
  assert.equal(isSealed({ accessToken: "x" }), false);
  assert.equal(isSealed(null), false);
  assert.equal(isSealed("string"), false);
  assert.equal(isSealed({ __enc: "aes-256-gcm", v: 2, data: "x" }), false);
});

// Startup validation: the module validates a *present* key at load time so a
// misconfiguration crashes the app immediately instead of failing later inside a
// DB flush. Re-import with a cache-busting query so the module body re-runs
// against the current config (the static `secret-box` import already loaded once).
test("module load throws when a present key is malformed", async () => {
  config.encryption.key = "abc"; // present but not 64 hex chars
  await assert.rejects(
    () => import(`./secret-box.js?malformed=${Date.now()}`),
    /INTEGRATION_ENCRYPTION_KEY/
  );
});

test("module load succeeds with a valid key", async () => {
  config.encryption.key = KEY;
  await assert.doesNotReject(() => import(`./secret-box.js?valid=${Date.now()}`));
});

test("module load does not validate when no key is configured", async () => {
  config.encryption.key = ""; // absent — degrades to plaintext, no validation
  await assert.doesNotReject(() => import(`./secret-box.js?absent=${Date.now()}`));
});
