// HMAC gate on the GitHub webhook receiver. Load-bearing guarantees: with no
// secret configured the receiver FAILS CLOSED (no forged installs/PR events —
// handleAppAuthorization can purge accounts), the dev bypass needs BOTH
// ALLOW_UNSIGNED_WEBHOOKS=1 and a non-https origin, and malformed signature
// headers are rejected before any comparison. In-memory, no network: a "ping"
// event exercises only the signature gate. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/github/webhook-signature.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../config.js";
import { handleWebhook } from "./webhooks.js";

const SECRET = "test-webhook-secret";
const body = (obj: unknown) => Buffer.from(JSON.stringify(obj));
const sign = (raw: Buffer, secret: string) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

// A fresh delivery GUID per request so the receiver's dedupe never interferes.
function fakeReq(raw: Buffer, sig: string | undefined) {
  const headers: Record<string, string | undefined> = {
    "X-Hub-Signature-256": sig,
    "X-GitHub-Delivery": crypto.randomUUID(),
    "X-GitHub-Event": "ping",
  };
  return { header: (n: string) => headers[n], body: raw } as any;
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  return res;
}

function deliver(sig: string | undefined, raw = body({ zen: "ping" })) {
  const res = fakeRes();
  handleWebhook(fakeReq(raw, sig), res);
  return res;
}

beforeEach(() => {
  config.github.webhookSecret = SECRET;
  config.github.allowUnsignedWebhooks = false;
  config.secureCookies = false;
});

test("valid signature is accepted", () => {
  const raw = body({ zen: "ping" });
  const res = deliver(sign(raw, SECRET), raw);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("wrong-secret, missing, and malformed signatures are all rejected", () => {
  const raw = body({ zen: "ping" });
  assert.equal(deliver(sign(raw, "other-secret"), raw).statusCode, 401);
  assert.equal(deliver(undefined, raw).statusCode, 401);
  // Shape violations: bad prefix, wrong length, non-hex, uppercase hex.
  assert.equal(deliver("sha1=" + "a".repeat(40), raw).statusCode, 401);
  assert.equal(deliver("sha256=" + "a".repeat(63), raw).statusCode, 401);
  assert.equal(deliver("sha256=" + "g".repeat(64), raw).statusCode, 401);
  assert.equal(deliver(sign(raw, SECRET).toUpperCase(), raw).statusCode, 401);
});

test("no secret configured → fails closed, even for unsigned requests", () => {
  config.github.webhookSecret = "";
  assert.equal(deliver(undefined).statusCode, 401);
  const raw = body({ zen: "ping" });
  assert.equal(deliver(sign(raw, SECRET), raw).statusCode, 401, "a stale signature doesn't help");
});

test("ALLOW_UNSIGNED_WEBHOOKS bypass works only without a secret AND off https", () => {
  config.github.webhookSecret = "";
  config.github.allowUnsignedWebhooks = true;
  assert.equal(deliver(undefined).statusCode, 200, "explicit dev opt-in accepts unsigned");
  config.secureCookies = true;
  assert.equal(deliver(undefined).statusCode, 401, "never honored on an https origin");
  config.secureCookies = false;
  config.github.webhookSecret = SECRET;
  assert.equal(deliver(undefined).statusCode, 401, "flag is ignored once a secret exists");
});
