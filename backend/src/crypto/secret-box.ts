// App-level encryption for secrets we hold at rest (integration tokens).
//
// AES-256-GCM with a random 96-bit IV per seal. Output is a self-describing
// envelope so the store can tell ciphertext from a legacy plaintext value, and
// so a future key rotation can bump `v` and try multiple keys. Uses only Node's
// built-in `crypto` (no new deps) — the same module the webhook HMAC verifiers
// already lean on.
//
// Threat model: this protects the bytes in Postgres (a DB compromise or a leaked
// Neon snapshot/backup). The key lives in an env var (INTEGRATION_ENCRYPTION_KEY),
// provisioned the same way SESSION_SECRET is; plaintext only ever exists in the
// in-memory snapshot at point of use, which is unavoidable to call the third-party
// APIs and is not the threat in scope.
import crypto from "node:crypto";
import { config } from "../config.js";

const ALG = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce — the GCM standard
const TAG_LEN = 16; // 128-bit auth tag
const KEY_LEN = 32; // AES-256

export type SealedSecret = {
  __enc: "aes-256-gcm";
  v: 1;
  data: string; // base64(iv ++ authTag ++ ciphertext)
};

// Resolve the configured key, validating its shape. A present-but-malformed key
// is a broken config (not a missing one), so we throw a clear error rather than
// silently degrading — that's reserved for the key being absent entirely.
function keyBuf(): Buffer {
  const hex = config.encryption.key;
  if (!hex) {
    throw new Error("seal/open called without INTEGRATION_ENCRYPTION_KEY configured");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(hex, "hex");
  } catch {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a hex string");
  }
  // Buffer.from(hex, "hex") silently stops at the first non-hex pair, so check
  // the decoded length matches the input rather than trusting it.
  if (buf.length !== KEY_LEN || hex.length !== KEY_LEN * 2) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes) for AES-256-GCM`
    );
  }
  return buf;
}

/** Narrow an arbitrary loaded value to the sealed-envelope shape. */
export function isSealed(v: unknown): v is SealedSecret {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.__enc === ALG && o.v === 1 && typeof o.data === "string";
}

/** Encrypt any JSON-serializable value into a sealed envelope. */
export function seal(value: unknown): SealedSecret {
  const key = keyBuf();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: ALG,
    v: 1,
    data: Buffer.concat([iv, tag, ciphertext]).toString("base64"),
  };
}

/** Decrypt a sealed envelope back to the original value. Throws on tamper. */
export function open(sealed: SealedSecret): unknown {
  const key = keyBuf();
  const raw = Buffer.from(sealed.data, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag); // any byte flipped in iv/tag/ciphertext fails final()
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

// Validate the key at startup if configured, so a malformed key crashes the app
// immediately rather than causing silent write failures later. (A present-but-
// invalid key would otherwise throw on the first seal/open during a DB flush,
// where persistIsolating treats it as a transient error and retries forever.)
if (config.encryption.key) {
  keyBuf();
}
