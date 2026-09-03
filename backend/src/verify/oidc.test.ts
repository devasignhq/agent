// Offline: GitHub Actions OIDC verification against a locally minted RSA key.
//   node --import tsx/esm --test src/verify/oidc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prNumberFromRef, verifyActionsToken, type Jwk } from "./oidc.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk: Jwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid: "k1", alg: "RS256", use: "sig" };
const jwks = async () => [jwk];

const CLAIMS = {
  repository: "acme/widgets",
  repository_id: "1234",
  sha: "0123456789abcdef0123456789abcdef01234567",
  ref: "refs/pull/42/merge",
  event_name: "pull_request",
  run_id: "99",
  run_attempt: "1",
  sub: "repo:acme/widgets:pull_request",
};

function mint(overrides: Record<string, unknown> = {}, opts: { key?: string | Buffer | import("node:crypto").KeyObject; kid?: string; exp?: string; aud?: string; iss?: string } = {}) {
  return jwt.sign({ ...CLAIMS, ...overrides }, (opts.key ?? privateKey) as any, {
    algorithm: "RS256",
    keyid: opts.kid ?? "k1",
    expiresIn: (opts.exp ?? "5m") as any,
    audience: opts.aud ?? config.verify.oidcAudience,
    issuer: opts.iss ?? config.verify.oidcIssuer,
  });
}

test("accepts a valid token and returns the claims", async () => {
  const r = await verifyActionsToken(mint(), { jwks });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.claims.repository, "acme/widgets");
    assert.equal(r.claims.repository_id, "1234");
    assert.equal(r.claims.event_name, "pull_request");
  }
});

test("rejects an expired token", async () => {
  const r = await verifyActionsToken(mint({}, { exp: "-1s" }), { jwks });
  assert.deepEqual(r, { ok: false, reason: "expired" });
});

test("rejects the wrong audience and the wrong issuer", async () => {
  assert.deepEqual(await verifyActionsToken(mint({}, { aud: "someone-else" }), { jwks }), { ok: false, reason: "wrong_audience" });
  assert.deepEqual(await verifyActionsToken(mint({}, { iss: "https://evil.example" }), { jwks }), { ok: false, reason: "wrong_issuer" });
});

test("rejects a token signed by a key not in the JWKS", async () => {
  const forged = mint({}, { key: other.privateKey });
  assert.deepEqual(await verifyActionsToken(forged, { jwks }), { ok: false, reason: "bad_signature" });
  const unknownKid = mint({}, { kid: "k-rotated" });
  assert.deepEqual(await verifyActionsToken(unknownKid, { jwks }), { ok: false, reason: "unknown_key" });
});

test("rejects malformed tokens, non-RS256, and tokens missing repo claims", async () => {
  assert.deepEqual(await verifyActionsToken("not-a-jwt", { jwks }), { ok: false, reason: "malformed" });
  const hs = jwt.sign({ ...CLAIMS }, "secret", { algorithm: "HS256", keyid: "k1", audience: config.verify.oidcAudience, issuer: config.verify.oidcIssuer });
  assert.deepEqual(await verifyActionsToken(hs, { jwks }), { ok: false, reason: "malformed" });
  const noRepo = mint({ repository_id: undefined });
  assert.deepEqual(await verifyActionsToken(noRepo, { jwks }), { ok: false, reason: "missing_claims" });
});

test("prNumberFromRef parses pull_request refs only", () => {
  assert.equal(prNumberFromRef("refs/pull/42/merge"), 42);
  assert.equal(prNumberFromRef("refs/pull/7/head"), 7);
  assert.equal(prNumberFromRef("refs/heads/main"), null);
  assert.equal(prNumberFromRef(""), null);
});
