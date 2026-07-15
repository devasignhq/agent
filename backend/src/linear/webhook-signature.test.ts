// HMAC gate on the Linear webhook receiver: valid lowercase-hex signatures
// pass, malformed/wrong ones are rejected, and no configured secret means
// fail closed. A syntactically valid event with an unknown organizationId is
// acknowledged with 200 and no action, so the happy path stays side-effect
// free. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/linear/webhook-signature.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../config.js";
import { handleLinearWebhook } from "./webhooks.js";

const SECRET = "test-linear-secret";
const body = () =>
  Buffer.from(JSON.stringify({ type: "Issue", action: "update", organizationId: "org-unknown" }));
const sign = (raw: Buffer, secret: string) =>
  crypto.createHmac("sha256", secret).update(raw).digest("hex");

function deliver(sig: string | undefined, raw = body()) {
  const req = { header: (n: string) => (n === "Linear-Signature" ? sig : undefined), body: raw } as any;
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  handleLinearWebhook(req, res);
  return res;
}

beforeEach(() => {
  config.linear.webhookSigningSecret = SECRET;
});

test("valid signature is accepted (unknown org → acknowledged, no action)", () => {
  const raw = body();
  assert.equal(deliver(sign(raw, SECRET), raw).statusCode, 200);
});

test("wrong-secret, missing, and malformed signatures are all rejected", () => {
  const raw = body();
  assert.equal(deliver(sign(raw, "other-secret"), raw).statusCode, 401);
  assert.equal(deliver(undefined, raw).statusCode, 401);
  assert.equal(deliver("a".repeat(63), raw).statusCode, 401, "wrong length");
  assert.equal(deliver("g".repeat(64), raw).statusCode, 401, "non-hex");
  assert.equal(deliver(sign(raw, SECRET).toUpperCase(), raw).statusCode, 401, "uppercase hex");
});

test("no secret configured → fails closed", () => {
  config.linear.webhookSigningSecret = "";
  const raw = body();
  assert.equal(deliver(undefined, raw).statusCode, 401);
  assert.equal(deliver(sign(raw, SECRET), raw).statusCode, 401);
});
