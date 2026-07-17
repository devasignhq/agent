// Guards the Linear ticket-attachment ingestion path, which is reachable by
// anyone who can file an issue or leave a comment in a connected workspace: they
// choose the URL, and the server fetches it and feeds the bytes to the LLM.
//
// Two real vulnerabilities are locked out here. Both came from substring-testing
// a URL instead of matching its parsed hostname:
//   1. SSRF — `http://169.254.169.254/latest/meta-data/x.png` passed the "is this
//      a file?" gate (extension match, no host check) and was fetched.
//   2. Token exfiltration — `linear.app.evil.com` matched /\blinear\.app\b/, so
//      the workspace's Linear OAuth token was sent to the attacker's server.
//
// Offline: public IP literals (no DNS) + a stubbed transport (no sockets). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/linear/file-download.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadLinearFile, isLinearHost } from "./client.js";
import { isLinearFileUrl } from "../review/pipeline.js";
import { __setGuardedTransportForTests } from "../ssrf.js";

const PUB = "93.184.216.34"; // public IP literal — resolvePublicUrl pins it without DNS

test("isLinearHost matches Linear exactly, never a look-alike", () => {
  assert.equal(isLinearHost("linear.app"), true);
  assert.equal(isLinearHost("uploads.linear.app"), true);
  // The token-exfiltration case.
  assert.equal(isLinearHost("linear.app.evil.com"), false);
  assert.equal(isLinearHost("notlinear.app"), false);
});

test("isLinearFileUrl no longer treats internal URLs as ticket attachments", () => {
  // Previously accepted by the unrestricted extension match → fetched server-side.
  assert.equal(isLinearFileUrl("http://169.254.169.254/latest/meta-data/x.png"), false);
  assert.equal(isLinearFileUrl("http://127.0.0.1:8787/api/internal.pdf"), false);
  assert.equal(isLinearFileUrl("http://10.0.0.5/admin.png"), false);
  // Previously accepted because the whole URL was substring-tested for linear.app.
  assert.equal(isLinearFileUrl("http://169.254.169.254/?x=linear.app"), false);
  assert.equal(isLinearFileUrl("file:///etc/passwd"), false);
  assert.equal(isLinearFileUrl("not-a-url"), false);
});

test("isLinearFileUrl still accepts the real attachments the review needs", () => {
  assert.equal(isLinearFileUrl("https://uploads.linear.app/abc/def"), true); // no extension
  assert.equal(isLinearFileUrl("https://linear.app/acme/issue/ENG-1"), true);
  assert.equal(isLinearFileUrl("https://example.com/spec.pdf"), true);
  assert.equal(isLinearFileUrl("https://example.com/spec.pdf?v=2"), true);
  assert.equal(isLinearFileUrl("https://example.com/shot.jpeg#x"), true);
});

test("downloadLinearFile refuses to fetch the cloud-metadata endpoint", async () => {
  let called = false;
  __setGuardedTransportForTests(async () => {
    called = true;
    return { status: 200, location: null, contentType: "image/png", body: Buffer.from("secrets") };
  });
  try {
    const out = await downloadLinearFile(
      "tok",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/x.png"
    );
    assert.equal(out, null, "metadata endpoint must not be downloadable");
    assert.equal(called, false, "the guard must reject before any request is made");
  } finally {
    __setGuardedTransportForTests(null);
  }
});

test("downloadLinearFile fetches a public non-Linear file WITHOUT sending the token", async () => {
  let auth: string | undefined = "MISSING";
  __setGuardedTransportForTests(async (_url, _addrs, _signal, opts) => {
    auth = opts?.headers?.Authorization;
    return { status: 200, location: null, contentType: "image/png; charset=binary", body: Buffer.from("img") };
  });
  try {
    const out = await downloadLinearFile("super-secret-token", `http://${PUB}/spec.png`);
    assert.ok(out, "a public external file should still be ingested");
    assert.equal(out.mediaType, "image/png");
    assert.equal(out.size, 3);
    assert.equal(out.base64, Buffer.from("img").toString("base64"));
    assert.equal(auth, undefined, "a non-Linear host must never receive the Linear token");
  } finally {
    __setGuardedTransportForTests(null);
  }
});

test("downloadLinearFile returns null (not a throw) when the fetch fails", async () => {
  // Best-effort contract: the review proceeds without the file.
  __setGuardedTransportForTests(async () => ({
    status: 404,
    location: null,
    contentType: "",
    body: Buffer.alloc(0),
  }));
  try {
    assert.equal(await downloadLinearFile("tok", `http://${PUB}/gone.png`), null);
  } finally {
    __setGuardedTransportForTests(null);
  }
});
