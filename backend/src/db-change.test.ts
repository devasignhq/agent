// Unit tests for the row-change emitter (db.ts onRowChange/emitRowChange): who
// gets told about a write, and — more importantly — the guarantee that a
// listener can never break one. Offline: no pool, so writes stay in the
// in-memory snapshot and stageUpsert no-ops.
// Run: node --import tsx/esm --test src/db-change.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, onRowChange, reconcileAll } from "./db.js";
import type { User } from "./types.js";

let seq = 0;
function user(over: Partial<User> = {}): User {
  seq++;
  return {
    id: `u-${seq}`,
    githubId: 1000 + seq,
    githubLogin: `dev-${seq}`,
    email: `dev-${seq}@example.com`,
    plan: "free",
    createdAt: 1,
    ...over,
  } as User;
}

// Records every emission; returns the log plus the unsubscribe.
function record() {
  const events: Array<{ collection: string; id: string; kind: string }> = [];
  const off = onRowChange(({ collection, row, kind }) => {
    events.push({ collection: String(collection), id: (row as { id: string }).id, kind });
  });
  return { events, off };
}

test("insert emits once, with the collection, the row and kind 'insert'", () => {
  const { events, off } = record();
  const row = user();
  db.insert("users", row);
  off();
  assert.deepEqual(events, [{ collection: "users", id: row.id, kind: "insert" }]);
});

test("update emits once, carrying the MERGED row rather than the patch", () => {
  const row = user();
  db.insert("users", row);
  const seen: User[] = [];
  const off = onRowChange(({ row }) => seen.push(row as User));
  db.update("users", (u) => u.id === row.id, { githubLogin: "renamed" });
  off();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].githubLogin, "renamed", "the patch is applied");
  assert.equal(seen[0].email, row.email, "…and untouched fields are still present");
});

test("update carries the pre-write row, so a no-op rewrite is distinguishable", () => {
  // Several hot paths rewrite fields no user can see (bot comment ids,
  // single-flight guards, tx-hash rebroadcasts). Without `prev` every one of
  // them looks exactly like a real state transition to a listener.
  const row = user({ githubLogin: "before" });
  db.insert("users", row);
  const changes: Array<{ before?: string; after?: string }> = [];
  const off = onRowChange(({ row: next, prev }) => {
    changes.push({
      before: (prev as User | null)?.githubLogin,
      after: (next as User).githubLogin,
    });
  });
  db.update("users", (u) => u.id === row.id, { githubLogin: "after" });
  db.update("users", (u) => u.id === row.id, { githubLogin: "after" }); // no-op rewrite
  off();
  assert.deepEqual(changes, [
    { before: "before", after: "after" },
    { before: "after", after: "after" }, // detectable as changing nothing
  ]);
});

test("insert reports prev as null", () => {
  const seen: Array<unknown> = [];
  const off = onRowChange(({ prev }) => seen.push(prev));
  db.insert("users", user());
  off();
  assert.deepEqual(seen, [null]);
});

test("an update matching no row emits nothing", () => {
  const { events, off } = record();
  const missed = db.update("users", (u) => u.id === "does-not-exist", { githubLogin: "x" });
  off();
  assert.equal(missed, null);
  assert.deepEqual(events, []);
});

test("writes work with no listener registered", () => {
  // The hot path — the keeper writes on a 12s loop with usually nobody watching.
  const row = user();
  assert.doesNotThrow(() => db.insert("users", row));
  assert.equal(db.find("users", (u) => u.id === row.id)?.id, row.id);
});

test("a throwing listener neither fails the write nor strands the other listeners", () => {
  // Expect one "[db] change listener threw" line in the output.
  const row = user();
  let reached = 0;
  const offBad = onRowChange(() => {
    throw new Error("boom");
  });
  const offGood = onRowChange(() => {
    reached++;
  });

  const written = db.insert("users", row);

  offBad();
  offGood();
  assert.equal(written.id, row.id, "insert still returned the row");
  assert.equal(db.find("users", (u) => u.id === row.id)?.id, row.id, "row is really in the store");
  assert.equal(reached, 1, "the second listener still ran");
});

test("unsubscribe stops delivery to that listener only", () => {
  let a = 0;
  let b = 0;
  const offA = onRowChange(() => {
    a++;
  });
  const offB = onRowChange(() => {
    b++;
  });
  db.insert("users", user());
  assert.deepEqual([a, b], [1, 1]);

  offA();
  db.insert("users", user());
  offB();
  assert.deepEqual([a, b], [1, 2]);
});

test("reconcileAll does not emit — re-staging a snapshot is not a row change", () => {
  // Guards the boot-storm case: reconcileAll and the boot loader stage rows
  // straight into the dirty map and never route through insert/update, so
  // loading a snapshot can't fan out a signal per row. (Offline this is doubly
  // true — reconcileAll early-returns without a pool — so treat this as a
  // regression guard on the call path, not a full proof of the boot path.)
  db.insert("users", user());
  const { events, off } = record();
  reconcileAll();
  off();
  assert.deepEqual(events, []);
});
