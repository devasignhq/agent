// Write-through flush behaviour, driven by a fake pg pool (no real Postgres).
// Proves the fix for the prod incident: a single row the database rejects is
// quarantined instead of rolling back and blocking ALL persistence forever, and
// a transient blip retries and recovers without dropping writes. Run:
//   node --import tsx/esm --test src/db-flush.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbHealth, flushPending, initDb, reconcileAll } from "./db.js";

// Minimal pg-pool stand-in. `query` handles the schema/load calls (initDb) and
// the flush inserts/deletes; an id in `poisonIds` makes its INSERT throw a
// data-class SQLSTATE (what Postgres does for a value it can't store), and
// `failConnect()` simulates the DB being unreachable.
function makeFakePool(opts: { poisonIds?: Set<string>; failConnect?: () => boolean } = {}) {
  const poison = opts.poisonIds ?? new Set<string>();
  const stored = new Set<string>();

  const runQuery = (sql: string, params?: unknown[]) => {
    const text = String(sql).trim().toLowerCase();
    if (text.startsWith("insert")) {
      const ids: string[] = [];
      for (let i = 0; i < (params?.length ?? 0); i += 2) ids.push(String(params![i]));
      const bad = ids.find((id) => poison.has(id));
      if (bad) {
        const e = new Error(`duplicate/poison ${bad}`) as Error & { code?: string };
        e.code = "23505"; // integrity violation -> isUnstorableDataError === true
        throw e;
      }
      for (const id of ids) stored.add(id);
    }
    // create table / select / begin / commit / rollback / delete -> no-op
    return { rows: [] as Array<{ data: unknown }> };
  };

  const client = { query: async (sql: string, p?: unknown[]) => runQuery(sql, p), release: () => {} };
  const pool = {
    connect: async () => {
      if (opts.failConnect?.()) throw new Error("ECONNREFUSED"); // transient
      return client;
    },
    query: async (sql: string, p?: unknown[]) => runQuery(sql, p),
    end: async () => {},
  };
  return { pool, stored };
}

const row = (id: string) => ({ id }) as never; // only `id` matters to the flush

test("quarantines a poison row but still persists the rest (no infinite block)", async () => {
  const { pool, stored } = makeFakePool({ poisonIds: new Set(["poison"]) });
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", row("good-1"));
  db.insert("notifications", row("poison"));
  db.insert("notifications", row("good-2"));

  await flushPending();

  assert.equal(stored.has("good-1"), true, "clean row before the poison persisted");
  assert.equal(stored.has("good-2"), true, "clean row after the poison persisted");
  assert.equal(stored.has("poison"), false, "poison row was not stored");

  const h = dbHealth();
  assert.equal(h.quarantinedRows, 1, "poison row counted as quarantined");
  assert.equal(h.pendingWrites, 0, "nothing left stuck in the dirty set");
  assert.equal(h.writeThrough, "degraded", "a dropped write is surfaced as degraded");
});

test("reconcileAll re-persists the entire in-memory snapshot (recovers silent drift)", async () => {
  const { pool, stored } = makeFakePool();
  await initDb({ poolOverride: pool as never }); // resets the snapshot to empty

  db.insert("notifications", row("n1"));
  db.insert("repositories", row("r1"));
  await flushPending();
  assert.equal(stored.has("n1") && stored.has("r1"), true, "initial writes persisted");

  // Simulate Postgres having lost rows that are still live in the snapshot — the
  // prod failure mode: writes that never landed while reads kept serving memory.
  stored.clear();

  // The convergence sweep (fired on recovery in onFlushOk) re-stages everything.
  reconcileAll();
  await flushPending();

  assert.equal(stored.has("n1"), true, "snapshot row re-persisted by reconcileAll");
  assert.equal(stored.has("r1"), true, "snapshot row re-persisted by reconcileAll");
  assert.equal(dbHealth().pendingWrites, 0, "nothing left pending after the re-sync");
});

test("retries a transient failure and recovers without losing writes", async () => {
  let failsLeft = 2; // first two connect attempts fail, then the DB comes back
  const { pool, stored } = makeFakePool({ failConnect: () => failsLeft-- > 0 });
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", row("t1"));
  await flushPending();

  assert.equal(stored.has("t1"), true, "write landed after the blip cleared");
  const h = dbHealth();
  assert.equal(h.pendingWrites, 0, "no writes left pending after recovery");
  assert.equal(h.consecutiveFlushFailures, 0, "failure counter reset on success");
  assert.equal(h.lastFlushError, null, "error cleared on success");
});
