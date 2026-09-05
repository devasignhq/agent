// Pins the toml override (CVE-2026-63376, CVE-2026-77465), which moves the parser
// stellar-sdk's stellartoml module requires from 3.x to 4.x.
//   node --import tsx/esm --test src/stellar/toml-override.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { StellarToml } from "@stellar/stellar-sdk";

const require_ = createRequire(import.meta.url);
const toml = require_("toml") as { parse(s: string): any };

const SAMPLE = `VERSION = "2.0.0"
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"

[[CURRENCIES]]
code = "USDC"
issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
`;

async function serve(body: string): Promise<{ domain: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url !== "/.well-known/stellar.toml") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { domain: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

test("the override holds toml at or above the patched 4.2.0", () => {
  const { version } = require_("toml/package.json") as { version: string };
  const [major, minor] = version.split(".").map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 2), `toml ${version} is below the patched 4.2.0`);
});

test("parse still returns the stellar.toml shape stellartoml reads", () => {
  const doc = toml.parse(SAMPLE);
  assert.equal(doc.VERSION, "2.0.0");
  assert.equal(doc.CURRENCIES[0].code, "USDC");
});

test("Resolver.resolve parses a served stellar.toml end to end", async () => {
  const s = await serve(SAMPLE);
  try {
    const doc = await StellarToml.Resolver.resolve(s.domain, { allowHttp: true });
    assert.equal(doc.VERSION, "2.0.0");
    assert.equal(doc.CURRENCIES?.[0]?.code, "USDC");
  } finally {
    await s.close();
  }
});

test("an invalid stellar.toml still rejects, and 4.x carries the position on .location", async () => {
  const s = await serve("a = = 1\n");
  try {
    await assert.rejects(
      () => StellarToml.Resolver.resolve(s.domain, { allowHttp: true }),
      /stellar\.toml is invalid/,
    );
  } finally {
    await s.close();
  }
  // 4.x dropped the top-level e.line/e.column that stellartoml interpolates, so its
  // message reads "line undefined"; the position moved here and the throw still happens.
  assert.throws(
    () => toml.parse("a = = 1\n"),
    (e: any) => e.location.start.line === 1 && e.location.start.column === 5,
  );
});
