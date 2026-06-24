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
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pool whose INSERT hangs forever the FIRST time, then behaves normally — models a
// flush query stuck on a half-open socket. Proves the watchdog bounds the hang and
// the loop recovers (via row-by-row isolation) instead of wedging `flushing`.
function makeHangOncePool() {
  const stored = new Set<string>();
  let armed = true;
  const runQuery = async (sql: string, params?: unknown[]) => {
    if (String(sql).trim().toLowerCase().startsWith("insert")) {
      if (armed) {
        armed = false;
        await new Promise(() => {}); // hang this one query forever
      }
      for (let i = 0; i < (params?.length ?? 0); i += 2) stored.add(String(params![i]));
    }
    return { rows: [] as Array<{ data: unknown }> };
  };
  const client = { query: runQuery, release: () => {} };
  return { pool: { connect: async () => client, query: runQuery, end: async () => {} }, stored };
}

// Pool whose every INSERT hangs forever — nothing ever persists, and crucially
// nothing ever ERRORS. Models the silent wedge the stall signal must catch.
function makeHangForeverPool() {
  const runQuery = async (sql: string) => {
    if (String(sql).trim().toLowerCase().startsWith("insert")) await new Promise(() => {});
    return { rows: [] as Array<{ data: unknown }> };
  };
  const client = { query: runQuery, release: () => {} };
  return { pool: { connect: async () => client, query: runQuery, end: async () => {} } };
}

// Pool whose INSERT resolves after a delay — a slow but healthy DB. Lets a test
// keep the flush loop busy under continuous load (writes arrive faster than a
// batch drains) so hasPending() is true at every onFlushOk: the condition that
// used to pin the stall clock to the first-ever stage.
function makeSlowPool(insertDelayMs: number) {
  const stored = new Set<string>();
  const runQuery = async (sql: string, params?: unknown[]) => {
    if (String(sql).trim().toLowerCase().startsWith("insert")) {
      await delay(insertDelayMs);
      for (let i = 0; i < (params?.length ?? 0); i += 2) stored.add(String(params![i]));
    }
    return { rows: [] as Array<{ data: unknown }> };
  };
  const client = { query: runQuery, release: () => {} };
  return { pool: { connect: async () => client, query: runQuery, end: async () => {} }, stored };
}

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

test("a hung flush query is bounded and recovers instead of wedging the flusher", async () => {
  const { pool, stored } = makeHangOncePool();
  // Short watchdog so the test doesn't wait the production 45s for the hang to trip.
  await initDb({ poolOverride: pool as never, flushWatchdogMs: 50 });

  db.insert("notifications", row("h1"));
  // The batched INSERT hangs; the watchdog must reject it, fall to row-by-row
  // isolation, and land the write — all WITHOUT flushPending() hanging forever.
  await flushPending();

  assert.equal(stored.has("h1"), true, "write persisted after the hung batch was bounded");
  assert.equal(dbHealth().pendingWrites, 0, "nothing left pending — flusher did not wedge");
});

test("a non-draining backlog surfaces as writeThrough 'stalled' (not a false ok)", async () => {
  const { pool } = makeHangForeverPool();
  // Big watchdog so the in-flight flush stays pending across the test; tiny stall
  // threshold so the parked write crosses it quickly.
  await initDb({ poolOverride: pool as never, flushWatchdogMs: 60_000, stallThresholdMs: 30 });

  db.insert("notifications", row("a")); // first flush drains this into the hung op
  await delay(90); // let the scheduled flush start and hang on the INSERT
  db.insert("notifications", row("b")); // parks in `dirty`: flush is in-flight, can't drain
  await delay(60); // age the backlog past stallThresholdMs

  const h = dbHealth();
  assert.equal(h.writeThrough, "stalled", "un-draining backlog reported, not a silent ok");
  assert.equal(h.consecutiveFlushFailures, 0, "surfaced even though nothing errored");
  assert.ok(h.pendingWrites >= 1, "the parked write is still pending");
  assert.ok(h.oldestPendingAgeMs >= 30, "backlog age reflects how long it's been stuck");
});

test("a draining backlog under continuous load is NOT falsely 'stalled' (c7)", async () => {
  // Healthy DB, just slow: each batch takes 20ms. Stage faster than that so the
  // flush loop stays busy and hasPending() is true at every onFlushOk — the case
  // where the stall clock used to stay pinned to the first stage and the age
  // crept past the threshold even though every flush succeeded.
  const { pool, stored } = makeSlowPool(20);
  await initDb({ poolOverride: pool as never, flushWatchdogMs: 60_000, stallThresholdMs: 100 });

  let i = 0;
  const loader = setInterval(() => db.insert("notifications", row(`c${i++}`)), 2);
  try {
    // Run well past stallThresholdMs (100ms) while every flush is SUCCEEDING.
    await delay(260);
    const h = dbHealth();
    assert.equal(h.consecutiveFlushFailures, 0, "flushes are succeeding, not failing");
    assert.ok(stored.size > 0, "writes are actually persisting — the backlog is draining");
    // The point: wall time (>260ms) far exceeds stallThresholdMs, but a draining
    // backlog must read "ok". A successful flush advances the stall clock, so the
    // age tracks the CURRENT undrained backlog, not total elapsed time.
    assert.equal(h.writeThrough, "ok", "a healthy, draining backlog must not read 'stalled'");
    assert.ok(
      h.oldestPendingAgeMs < 100,
      "stall age reflects time since the last successful drain, not since the first stage"
    );
  } finally {
    clearInterval(loader);
    await flushPending();
  }
});
