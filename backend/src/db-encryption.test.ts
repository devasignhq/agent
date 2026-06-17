// At-rest encryption of integration tokens, driven by a fake pg pool (no real
// Postgres). Proves the persistence boundary seals on write and opens on load,
// the in-memory snapshot stays plaintext, legacy rows migrate, and the whole
// thing degrades to plaintext (with a health signal) when no key is set. Run:
//   node --import tsx/esm --test src/db-encryption.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { db, dbHealth, flushPending, initDb } from "./db.js";
import { seal } from "./crypto/secret-box.js";

const KEY = "11".repeat(32);

// pg-pool stand-in: serves seeded rows on SELECT (for load tests) and records
// every (table, id, data) it's asked to INSERT (to inspect what hits Postgres).
function makeFakePool(opts: { seed?: Record<string, Array<{ data: unknown }>> } = {}) {
  const seed = opts.seed ?? {};
  const inserts: Array<{ table: string; id: string; data: unknown }> = [];

  const runQuery = (sql: string, params?: unknown[]) => {
    const text = String(sql).trim().toLowerCase();
    if (text.startsWith("select")) {
      const table = /from\s+"([^"]+)"/.exec(text)?.[1] ?? "";
      return { rows: seed[table] ?? [] };
    }
    if (text.startsWith("insert")) {
      const table = /into\s+"([^"]+)"/.exec(text)?.[1] ?? "";
      for (let i = 0; i + 1 < (params?.length ?? 0); i += 2) {
        inserts.push({ table, id: String(params![i]), data: params![i + 1] });
      }
    }
    return { rows: [] as Array<{ data: unknown }> };
  };

  const client = { query: async (s: string, p?: unknown[]) => runQuery(s, p), release: () => {} };
  const pool = {
    connect: async () => client,
    query: async (s: string, p?: unknown[]) => runQuery(s, p),
    end: async () => {},
  };
  return { pool, inserts };
}

const integration = (id: string, tokens: unknown) =>
  ({ id, userId: `u-${id}`, type: "linear", tokens, workspaceMeta: {}, createdAt: 1 }) as never;

test("seals integration tokens on the way to Postgres, keeps memory plaintext", async () => {
  config.encryption.key = KEY;
  const { pool, inserts } = makeFakePool();
  await initDb({ poolOverride: pool as never });

  db.insert("integrations", integration("int-1", { accessToken: "secret-token" }));
  await flushPending();

  const stored = inserts.find((i) => i.table === "integrations" && i.id === "int-1");
  assert.ok(stored, "integration row was written to Postgres");
  assert.equal((stored!.data as any).tokens.__enc, "aes-256-gcm", "tokens field is sealed at rest");
  assert.equal(
    JSON.stringify(stored!.data).includes("secret-token"),
    false,
    "plaintext token never appears in the stored bytes"
  );

  const live = db.find("integrations", (i) => i.id === "int-1");
  assert.equal((live as any).tokens.accessToken, "secret-token", "in-memory read stays plaintext");
});

test("decrypts sealed integration rows on load", async () => {
  config.encryption.key = KEY;
  const sealedRow = integration("int-2", seal({ accessToken: "xoxb-secret" }));
  const { pool } = makeFakePool({ seed: { integrations: [{ data: sealedRow }] } });
  await initDb({ poolOverride: pool as never });

  const live = db.find("integrations", (i) => i.id === "int-2");
  assert.equal((live as any).tokens.accessToken, "xoxb-secret");
});

test("migrates legacy plaintext rows by re-encrypting them on boot", async () => {
  config.encryption.key = KEY;
  const legacyRow = integration("int-3", { accessToken: "legacy-plain" });
  const { pool, inserts } = makeFakePool({ seed: { integrations: [{ data: legacyRow }] } });
  await initDb({ poolOverride: pool as never });

  // Usable immediately from the in-memory plaintext snapshot...
  const live = db.find("integrations", (i) => i.id === "int-3");
  assert.equal((live as any).tokens.accessToken, "legacy-plain");

  // ...and the boot migration re-staged + flushed it as ciphertext.
  const stored = inserts.find((i) => i.table === "integrations" && i.id === "int-3");
  assert.ok(stored, "legacy row was re-staged for encryption on boot");
  assert.equal((stored!.data as any).tokens.__enc, "aes-256-gcm");
  assert.equal(JSON.stringify(stored!.data).includes("legacy-plain"), false);
});

test("a sealed row that fails to decrypt loads blanked, not as the envelope", async () => {
  config.encryption.key = KEY;
  // Seal a real token, then flip a ciphertext byte so open() fails the GCM auth
  // tag on load (mimics on-disk corruption or a since-rotated key).
  const sealed = seal({ accessToken: "will-corrupt" });
  const raw = Buffer.from(sealed.data, "base64");
  raw[raw.length - 1] ^= 0xff;
  const corrupt = integration("int-5", { ...sealed, data: raw.toString("base64") });
  const { pool } = makeFakePool({ seed: { integrations: [{ data: corrupt }] } });

  // Capture console.error to assert the failure is logged, not swallowed.
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void logged.push(String(args[0]));
  try {
    await initDb({ poolOverride: pool as never });
  } finally {
    console.error = origError;
  }

  const live = db.find("integrations", (i) => i.id === "int-5");
  assert.ok(live, "row still loaded — boot did not crash on the corrupt secret");
  assert.deepEqual((live as any).tokens, {}, "undecryptable secret is blanked to an empty record");
  assert.equal(
    (live as any).tokens.accessToken,
    undefined,
    "no token (and no envelope) surfaces to consumers"
  );
  assert.ok(
    logged.some((m) => m.includes("Failed to decrypt")),
    "logged the decrypt failure"
  );
});

test("without a key, tokens round-trip as plaintext and health reports unconfigured", async () => {
  config.encryption.key = "";
  const { pool, inserts } = makeFakePool();
  await initDb({ poolOverride: pool as never });

  db.insert("integrations", integration("int-4", { accessToken: "plain-when-off" }));
  await flushPending();

  const stored = inserts.find((i) => i.table === "integrations" && i.id === "int-4");
  assert.ok(stored);
  assert.equal(
    (stored!.data as any).tokens.accessToken,
    "plain-when-off",
    "stores plaintext when no key is configured (back-compat)"
  );
  assert.equal(dbHealth().encryption, "unconfigured");
});
