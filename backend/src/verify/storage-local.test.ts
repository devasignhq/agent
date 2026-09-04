// Offline: the dev-only local artifact store's signed URLs and path guard.
//   DATABASE_URL= node --import tsx/esm --test src/verify/storage-local.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { localArtifactPath, localArtifactStorage, localStoreEnabled, verifyLocalSignature } from "./storage-local.js";

test("disabled unless ARTIFACT_LOCAL_DIR is set; signed URLs verify by method+key+expiry; traversal is refused", async () => {
  const prev = config.artifacts.localDir;
  config.artifacts.localDir = "";
  assert.equal(localStoreEnabled(), false);
  assert.equal(localArtifactStorage(), null);
  config.artifacts.localDir = "/tmp/devasign-artifacts-test";
  try {
    assert.equal(localStoreEnabled(), true);
    const s = localArtifactStorage()!;
    const { url, headers } = await s.signPut("repo/run/art.webm", "video/webm", 60);
    assert.equal(headers["Content-Type"], "video/webm");
    const u = new URL(url);
    assert.equal(u.pathname, "/v1/artifacts/local/" + encodeURIComponent("repo/run/art.webm"));
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig")!;
    assert.equal(verifyLocalSignature("PUT", "repo/run/art.webm", exp, sig), true);
    assert.equal(verifyLocalSignature("GET", "repo/run/art.webm", exp, sig), false, "method is part of the signature");
    assert.equal(verifyLocalSignature("PUT", "repo/run/other.webm", exp, sig), false);
    assert.equal(verifyLocalSignature("PUT", "repo/run/art.webm", exp, sig, exp + 1), false, "expired");
    assert.ok(localArtifactPath("repo/run/art.webm")!.startsWith("/tmp/devasign-artifacts-test/"));
    assert.equal(localArtifactPath("../../etc/passwd"), null);
    assert.equal(localArtifactPath("repo/../../x"), null);
  } finally {
    config.artifacts.localDir = prev;
  }
});

// timingSafeEqual throws when the buffers differ in length, so the guard has to
// compare BYTES: a 64-character signature of multi-byte chars is 64 chars but
// well over 64 bytes, and the string-length guard let it through to the throw.
test("a multi-byte signature of the right character length is refused, not a throw", () => {
  const exp = Date.now() + 60_000;
  const hex = 64;
  assert.equal(verifyLocalSignature("GET", "k", exp, "é".repeat(hex)), false);
  assert.equal(verifyLocalSignature("GET", "k", exp, "\u{1F600}".repeat(hex)), false);
  assert.equal(verifyLocalSignature("GET", "k", exp, ""), false);
});
