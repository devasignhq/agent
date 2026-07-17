// Tests for the shared SSRF guard. Offline: no DNS, no sockets — every case
// uses a public IP literal (which resolvePublicUrl pins without a lookup) and a
// stubbed transport. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/ssrf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __setGuardedTransportForTests,
  fetchGuarded,
  hostMatches,
  isPrivateIp,
  resolvePublicUrl,
} from "./ssrf.js";

// Two public IP literals, so nothing here touches DNS.
const PUB_A = "93.184.216.34";
const PUB_B = "93.184.216.35";
const signal = () => new AbortController().signal;

// The bug this whole module exists to prevent from recurring: a substring test
// for "is this host theirs?" matches attacker-controlled positions.
test("hostMatches accepts the apex and real subdomains, rejects look-alikes", () => {
  assert.equal(hostMatches("linear.app", "linear.app"), true);
  assert.equal(hostMatches("uploads.linear.app", "linear.app"), true);
  assert.equal(hostMatches("LINEAR.APP", "linear.app"), true);
  // The exfiltration case: /\blinear\.app\b/ matched this, hostMatches must not.
  assert.equal(hostMatches("linear.app.evil.com", "linear.app"), false);
  assert.equal(hostMatches("notlinear.app", "linear.app"), false);
  assert.equal(hostMatches("evil.com", "linear.app"), false);
});

test("isPrivateIp covers the ranges an SSRF actually targets", () => {
  for (const ip of [
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  assert.equal(isPrivateIp(PUB_A), false);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("resolvePublicUrl rejects private/metadata/scheme abuse, pins a public literal", async () => {
  for (const u of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://[::1]/",
    "http://localhost/",
    "file:///etc/passwd",
    "not-a-url",
  ]) {
    await assert.rejects(resolvePublicUrl(u), new RegExp("."), `expected ${u} to be rejected`);
  }
  const ok = await resolvePublicUrl(`http://${PUB_A}/`);
  assert.deepEqual(ok.addrs, [{ address: PUB_A, family: 4 }]);
});

// The control that stops a credential from leaking on a redirect. headersFor is
// recomputed against the URL actually being requested, so a 302 off our host
// cannot carry the Authorization header with it.
test("fetchGuarded recomputes headers per hop — credentials do not follow a redirect", async () => {
  const seen: Array<{ host: string; auth?: string }> = [];
  __setGuardedTransportForTests(async (url, _addrs, _signal, opts) => {
    seen.push({ host: url.hostname, auth: opts?.headers?.Authorization });
    return url.hostname === PUB_A
      ? { status: 302, location: `http://${PUB_B}/next.png`, contentType: "", body: Buffer.alloc(0) }
      : { status: 200, location: null, contentType: "image/png", body: Buffer.from("payload") };
  });
  try {
    const out = await fetchGuarded(`http://${PUB_A}/start.png`, {
      signal: signal(),
      headersFor: (u): Record<string, string> =>
        u.hostname === PUB_A ? { Authorization: "Bearer secret" } : {},
    });
    assert.equal(out.buf.toString(), "payload");
    assert.deepEqual(
      seen.map((s) => s.host),
      [PUB_A, PUB_B]
    );
    assert.equal(seen[0].auth, "Bearer secret", "the trusted host should get the credential");
    assert.equal(seen[1].auth, undefined, "the redirect target must NOT receive the credential");
  } finally {
    __setGuardedTransportForTests(null);
  }
});

test("fetchGuarded re-validates every hop — a public host cannot redirect us to metadata", async () => {
  __setGuardedTransportForTests(async () => ({
    status: 302,
    location: "http://169.254.169.254/latest/meta-data/",
    contentType: "",
    body: Buffer.alloc(0),
  }));
  try {
    await assert.rejects(
      fetchGuarded(`http://${PUB_A}/`, { signal: signal() }),
      /private/i,
      "a redirect to the metadata endpoint must be blocked"
    );
  } finally {
    __setGuardedTransportForTests(null);
  }
});

test("fetchGuarded gives up rather than following a redirect chain forever", async () => {
  __setGuardedTransportForTests(async (url) => ({
    status: 302,
    location: `http://${url.hostname === PUB_A ? PUB_B : PUB_A}/`,
    contentType: "",
    body: Buffer.alloc(0),
  }));
  try {
    await assert.rejects(
      fetchGuarded(`http://${PUB_A}/`, { signal: signal(), maxRedirects: 2 }),
      /too many redirects/i
    );
  } finally {
    __setGuardedTransportForTests(null);
  }
});
