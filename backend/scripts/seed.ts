// One-time importer: load an existing db.json snapshot into Postgres (Neon).
//
//   npx tsx scripts/seed.ts                # reads ./data/db.json
//   SEED_FROM=/path/to/db.json npx tsx scripts/seed.ts
//
// Idempotent: rows are upserted by id through the normal db write path, so
// re-running reconciles rather than duplicating. Requires DATABASE_URL.
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { db, initDb, flushPending, shutdownDb } from "../src/db.js";
import type { DB } from "../src/types.js";

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is not set — nothing to seed into. Set it in backend/.env.");
    process.exit(1);
  }

  const jsonPath = process.env.SEED_FROM
    ? path.resolve(process.env.SEED_FROM)
    : path.resolve(process.cwd(), "data/db.json");
  if (!fs.existsSync(jsonPath)) {
    console.error(`No snapshot found at ${jsonPath}. Pass SEED_FROM=/path/to/db.json.`);
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Partial<DB>;

  // Connect + create schema + load whatever is already in Postgres so the
  // upsert-by-id below is a true reconcile.
  await initDb();

  let total = 0;
  for (const key of Object.keys(snapshot) as (keyof DB)[]) {
    const rows = snapshot[key];
    if (!Array.isArray(rows)) continue;
    let n = 0;
    for (const row of rows as Array<{ id?: string }>) {
      if (!row || typeof row.id !== "string") continue;
      // Drop any existing copy from the in-memory snapshot, then insert — this
      // resolves to a single upsert-by-id in Postgres.
      db.remove(key, (r: { id?: string }) => r.id === row.id);
      db.insert(key, row as DB[typeof key][number]);
      n++;
      total++;
    }
    console.log(`  ${key}: ${n} rows`);
  }

  await flushPending();
  console.log(`Seeded ${total} rows into Postgres from ${jsonPath}.`);
  await shutdownDb();
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
