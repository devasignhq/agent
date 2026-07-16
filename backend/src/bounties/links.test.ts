// Signed bounty links round-trip and are scoped to (bounty, purpose).
// Run: node --import tsx/esm --test src/bounties/links.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUrl, mintBountyLinkToken, verifyBountyLinkToken, fundingUrl, cancelUrl } from "./links.js";
import { config } from "../config.js";

test("token verifies only for the matching bounty + purpose", () => {
  const tok = mintBountyLinkToken("bounty-123", "fund");
  assert.equal(verifyBountyLinkToken(tok, "fund"), "bounty-123");
  // Wrong purpose is rejected even though the signature is valid.
  assert.equal(verifyBountyLinkToken(tok, "cancel"), null);
  assert.equal(verifyBountyLinkToken(tok, "approve"), null);
});

test("tampered / garbage tokens are rejected", () => {
  assert.equal(verifyBountyLinkToken("not.a.jwt", "fund"), null);
  const tok = mintBountyLinkToken("b1", "cancel");
  assert.equal(verifyBountyLinkToken(tok + "x", "cancel"), null);
});

test("expired token is rejected", async () => {
  const tok = mintBountyLinkToken("b1", "fund", -1); // already expired
  assert.equal(verifyBountyLinkToken(tok, "fund"), null);
});

test("URLs embed the bounty id + a verifying token", () => {
  const fu = new URL(fundingUrl("abc"));
  assert.match(fu.pathname, /\/bounties\/abc\/fund$/);
  assert.equal(verifyBountyLinkToken(fu.searchParams.get("token")!, "fund"), "abc");

  const cu = new URL(cancelUrl("abc"));
  assert.match(cu.pathname, /\/bounties\/abc\/cancel$/);
  assert.equal(verifyBountyLinkToken(cu.searchParams.get("token")!, "cancel"), "abc");
});

test("apply URL is tokenless and points at the contributor app's discovery page", () => {
  const au = new URL(applyUrl("abc"));
  assert.match(au.pathname, /\/bounties\/abc$/);
  assert.equal(au.search, "");
  assert.equal(au.origin, new URL(config.contributorOrigin).origin);
  // Fund/cancel links stay on the sponsor dashboard.
  assert.equal(new URL(fundingUrl("abc")).origin, new URL(config.webOrigin).origin);
});
