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
