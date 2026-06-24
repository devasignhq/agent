// Coherence behaviour of the Postgres-as-source-of-truth store, driven by a
// store-backed fake pg pool (no real Postgres). Proves the two guarantees that
// fix the "reviewed PRs vanish / pro count rolls back after a redeploy" bug:
//   1. version guard — a stale instance's lower-version write can't clobber a
//      newer row (the whole-row last-write-wins rollback that dropped the count).
//   2. delta-sync — the cache revalidates against Postgres (no load-once
//      snapshot), pulling in rows another instance committed, while never
//      overwriting a write this instance hasn't flushed yet; and the delete sweep
//      drops rows another instance removed.
//
// CAVEAT: the fake pool reimplements the version guard in JS, so these tests
// validate db.ts's behaviour (version stamping, the delta-sync/sweep merge logic)
// but NOT the raw `upsertConflict` SQL string itself — a typo there (wrong
// comparator / column ref) is only caught by the real-Postgres end-to-end check.
// Run: node --import tsx/esm --test src/db-coherence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, flushPending, initDb, syncFromStore } from "./db.js";

// A fake pg pool that actually RETAINS rows as (data, rev) per table and honours
// the real upsert's version guard, so we can act as "another instance" via
// `external`. Mirrors only the SQL shapes db.ts issues.
function makeStorePool() {
  const tables = new Map<string, Map<string, { data: any; rev: number }>>();
  let seq = 0;
  const tableFor = (name: string) => {
    let t = tables.get(name);
    if (!t) tables.set(name, (t = new Map()));
    return t;
  };
  const versionOf = (data: any) => (typeof data?.version === "number" ? data.version : null);

  const runQuery = async (sql: string, params?: unknown[]) => {
    const s = String(sql).trim();
    const low = s.toLowerCase();
    if (
      low.startsWith("create") ||
      low.startsWith("alter") ||
      low.startsWith("begin") ||
      low.startsWith("commit") ||
      low.startsWith("rollback")
    ) {
      return { rows: [] as any[] };
    }
    if (low.startsWith("insert")) {
      const name = s.match(/insert into "([^"]+)"/i)![1];
      const t = tableFor(name);
      for (let i = 0; i + 1 < (params?.length ?? 0); i += 2) {
        const id = String(params![i]);
        const data = params![i + 1] as any;
        const existing = t.get(id);
        const newV = versionOf(data) ?? 0;
        const oldV = existing ? (versionOf(existing.data) ?? -1) : -1;
        if (!existing || newV >= oldV) t.set(id, { data, rev: ++seq }); // guard
      }
      return { rows: [] as any[] };
    }
    if (low.startsWith("select")) {
      const name = s.match(/from "([^"]+)"/i)![1];
      const t = tableFor(name);
      if (/where rev > \$1/i.test(s)) {
        const wm = Number(params?.[0] ?? 0);
        const rows = [...t.entries()]
          .filter(([, v]) => v.rev > wm)
          .sort((a, b) => a[1].rev - b[1].rev)
          .map(([id, v]) => ({ id, data: v.data, rev: String(v.rev) }));
        return { rows };
      }
      if (/^select id from/i.test(s)) {
        return { rows: [...t.keys()].map((id) => ({ id })) };
      }
      // loadAll: select data, rev from "t"
      return { rows: [...t.values()].map((v) => ({ data: v.data, rev: String(v.rev) })) };
    }
    if (low.startsWith("delete")) {
      const name = s.match(/from "([^"]+)"/i)![1];
      const t = tableFor(name);
      const arg = params?.[0];
      const ids = Array.isArray(arg) ? arg.map(String) : [String(arg)];
      for (const id of ids) t.delete(id);
      return { rows: [] as any[] };
    }
    return { rows: [] as any[] };
  };

  const client = { query: runQuery, release: () => {} };
  const pool = { connect: async () => client, query: runQuery, end: async () => {} };
  // Act as a second instance writing straight to Postgres.
  const external = {
    upsert(name: string, id: string, data: any) {
      tableFor(name).set(id, { data, rev: ++seq });
    },
    remove(name: string, id: string) {
      tableFor(name).delete(id);
    },
    get(name: string, id: string) {
      return tableFor(name).get(id);
    },
  };
  return { pool, external };
}

const find = (id: string) => db.find("notifications", (r) => (r as any).id === id) as any;

test("version guard: a stale (lower-version) write can't clobber a newer row", async () => {
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", { id: "n", body: "ours-v1" } as never); // version 1
  await flushPending();

  // Another instance commits a NEWER version of the same row.
  external.upsert("notifications", "n", { id: "n", body: "external-v5", version: 5 });

  // Our instance, unaware, edits from its stale base. The bump must actually
  // increment (1 -> 2): if it didn't, the guard would still reject (1 < 5) and
  // mask the bug, so assert the version directly — this is what makes a stale
  // instance's writes *lose*.
  db.update("notifications", (r) => (r as any).id === "n", { body: "ours-v2" } as never);
  assert.equal(find("n").version, 2, "db.update incremented version from the local (stale) base");
  await flushPending();

  // The guard rejected our v2 (< v5): Postgres still holds the external row.
  const stored = external.get("notifications", "n")!;
  assert.equal(stored.data.body, "external-v5", "newer row survived the stale write");
  assert.equal(stored.data.version, 5);
});

test("version guard: a legitimate newer write DOES win the upsert", async () => {
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", { id: "n", body: "v1" } as never); // version 1
  await flushPending();
  assert.equal(external.get("notifications", "n")!.data.version, 1, "v1 persisted");

  // A normal in-process update bumps 1 -> 2 and must overwrite the stored v1
  // (guard: 2 >= 1). Proves the guard isn't so strict it drops real updates.
  db.update("notifications", (r) => (r as any).id === "n", { body: "v2" } as never);
  await flushPending();

  const stored = external.get("notifications", "n")!;
  assert.equal(stored.data.body, "v2", "newer write applied");
  assert.equal(stored.data.version, 2);
});

test("delta-sync: pulls rows committed elsewhere, never clobbering a locally-pending write", async () => {
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", { id: "x", body: "x-v1" } as never);
  db.insert("notifications", { id: "z", body: "z-v1" } as never);
  await flushPending();

  // Another instance: a brand-new row y, an update to z, and a write to x.
  external.upsert("notifications", "y", { id: "y", body: "y-external", version: 1 });
  external.upsert("notifications", "z", { id: "z", body: "z-external", version: 2 });
  external.upsert("notifications", "x", { id: "x", body: "x-external-skip", version: 1 });

  // We have an un-flushed local edit to x (still in the dirty set).
  db.update("notifications", (r) => (r as any).id === "x", { body: "x-local-v2" } as never);

  await syncFromStore(); // force a coherence pass before the 50ms flush timer

  assert.equal(find("y")?.body, "y-external", "new row from another instance merged in");
  assert.equal(find("z")?.body, "z-external", "external update to an untouched row merged in");
  assert.equal(find("x")?.body, "x-local-v2", "our un-flushed edit was NOT clobbered by delta-sync");
});

test("delete sweep: a row deleted by another instance is dropped from the cache", async () => {
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", { id: "d", body: "to-delete" } as never);
  await flushPending();
  assert.ok(find("d"), "row present before the external delete");

  external.remove("notifications", "d");
  await syncFromStore(); // full pass includes the delete sweep

  assert.equal(find("d"), null, "row deleted elsewhere was swept from the cache");
});

test("watermark hold-back: a low-rev pending row holds the watermark but the cache still converges", async () => {
  // The reviewer's scenario: a pending-skipped row ("lo") has a LOWER rev than an
  // already-merged row ("hi"). The watermark is held just below "lo"'s rev (so
  // "hi" gets re-pulled each pass), but (a) the pending local row is never
  // clobbered, (b) the watermark never regresses, and (c) once the pending write
  // resolves the cache converges to Postgres' newer row and re-pulls stop.
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  // Postgres (another instance) holds lo@rev1 (newer, version 2) and hi@rev2.
  external.upsert("notifications", "lo", { id: "lo", body: "lo-external-v2", version: 2 });
  external.upsert("notifications", "hi", { id: "hi", body: "hi-external", version: 1 });

  // Our instance has an un-flushed insert of "lo" (version 1) — lower than PG's.
  db.insert("notifications", { id: "lo", body: "lo-local-v1" } as never);

  // Pass 1: lo is pending → skipped (held), hi is merged. Watermark held at 0
  // (just below lo@rev1), NOT advanced past hi@rev2.
  await syncFromStore();
  assert.equal(find("lo")?.body, "lo-local-v1", "pending local row not clobbered while pending");
  assert.equal(find("hi")?.body, "hi-external", "higher-rev row merged even though watermark held");

  // Our stale write flushes and LOSES the version guard (v1 < PG's v2) — so it is
  // dropped from persistence, leaving cache (v1) behind Postgres (v2).
  await flushPending();
  assert.equal(
    external.get("notifications", "lo")!.data.body,
    "lo-external-v2",
    "stale local write did not clobber Postgres' newer row"
  );

  // Pass 2: lo no longer pending → re-pulled and merged (v2 >= v1). Cache converges.
  await syncFromStore();
  assert.equal(find("lo")?.body, "lo-external-v2", "cache converged to Postgres' newer row");

  // Pass 3: stable — nothing changes, no stale re-application.
  await syncFromStore();
  assert.equal(find("lo")?.body, "lo-external-v2", "converged state is stable across further passes");
  assert.equal(find("hi")?.body, "hi-external", "hi unchanged");
});

test("delta-sync guard: a re-pulled row with a LOWER version never overwrites a newer cached row", async () => {
  // Defense in depth: even if Postgres somehow surfaces an older row at a fresh
  // rev (the version guard at the upsert should prevent it, but delta-sync must
  // not trust that), the merge's `incomingV >= localV` check must reject it.
  const { pool, external } = makeStorePool();
  await initDb({ poolOverride: pool as never });

  db.insert("notifications", { id: "z", body: "z-v1" } as never); // version 1
  await flushPending();
  db.update("notifications", (r) => (r as any).id === "z", { body: "z-v2" } as never); // -> 2
  db.update("notifications", (r) => (r as any).id === "z", { body: "z-v3" } as never); // -> 3
  await flushPending();
  assert.equal(find("z")?.version, 3, "cache holds the newest version");

  // Another instance writes a STALE version 1 at a brand-new (higher) rev.
  external.upsert("notifications", "z", { id: "z", body: "z-stale", version: 1 });

  await syncFromStore();
  assert.equal(find("z")?.body, "z-v3", "stale lower-version row was NOT applied");
  assert.equal(find("z")?.version, 3, "cache kept its newer version");
});
