// Postgres-backed document store (Neon in dev/prod).
//
// Shape-compatible drop-in for the old JSON-file store: the whole dataset is
// held in memory and read synchronously through the same predicate API, while
// mutations write through to Postgres. Each collection maps to a table of
// `(id text primary key, data jsonb)` — one JSONB document per row — so the
// in-memory object shapes round-trip without a per-field column mapping.
//
// Reads are synchronous against the in-memory snapshot (populated by initDb()
// at boot). Writes mutate the snapshot synchronously and are flushed to
// Postgres in a debounced, ordered batch — mirroring the old file store's
// write-through-cache behaviour, just durably and off-box.
import { v4 as uuid } from "uuid";
import pg from "pg";
import { config } from "./config.js";
import type { DB } from "./types.js";

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const empty: DB = {
  users: [],
  installations: [],
  repositories: [],
  integrations: [],
  tasks: [],
  prReviews: [],
  reviewLogs: [],
  subscriptions: [],
  authAudit: [],
  repoIndex: [],
  notifications: [],
  linearProjectUpdates: [],
};

// Collection key -> Postgres table name. Unquoted identifiers fold to
// lowercase in Postgres, so camelCase keys get an explicit snake_case table.
const TABLES: Record<keyof DB, string> = {
  users: "users",
  installations: "installations",
  repositories: "repositories",
  integrations: "integrations",
  tasks: "tasks",
  prReviews: "pr_reviews",
  reviewLogs: "review_logs",
  subscriptions: "subscriptions",
  authAudit: "auth_audit",
  repoIndex: "repo_index",
  notifications: "notifications",
  linearProjectUpdates: "linear_project_updates",
};

const COLLECTIONS = Object.keys(TABLES) as (keyof DB)[];

let state: DB = structuredClone(empty);
let pool: PgPool | null = null;

// One-shot migration on load: assign an id (and createdAt) to any
// TaskAttachment that was persisted before the `id` field existed. Without
// this, the frontend's constraint X-click can't address the attachment by
// id and falls back to a client-only hide path. Idempotent — rows that
// already have an id are untouched. Returns true when something changed.
function backfillAttachmentIds(snapshot: DB): boolean {
  let mutated = false;
  for (const task of snapshot.tasks || []) {
    const attachments = task.attachments || [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (!a) continue;
      if (!a.id) {
        attachments[i] = { ...a, id: uuid(), createdAt: a.createdAt ?? Date.now() };
        mutated = true;
      } else if (!a.createdAt) {
        attachments[i] = { ...a, createdAt: Date.now() };
        mutated = true;
      }
    }
  }
  return mutated;
}

// One-shot normalization on load for the billing/paywall migration:
//  • plan "team" → "max" on users + subscriptions (the tier was renamed)
//  • backfill new Subscription fields (status / usage window / Stripe ids) on
//    pre-paywall rows
//  • backfill Repository.private:false (the real visibility is refreshed on the
//    next install/PR webhook or reconcile)
// Operates on loosely-typed loaded rows; idempotent.
function migrateForPaywall(snapshot: DB): boolean {
  let mutated = false;
  for (const u of snapshot.users || []) {
    if ((u as any).plan === "team") {
      (u as any).plan = "max";
      mutated = true;
    }
  }
  for (const s of snapshot.subscriptions || []) {
    const sub = s as any;
    let changed = false;
    if (sub.plan === "team") { sub.plan = "max"; changed = true; }
    if (sub.status === undefined) { sub.status = null; changed = true; }
    if (sub.stripeSubscriptionId === undefined) { sub.stripeSubscriptionId = null; changed = true; }
    if (sub.currentPeriodEnd === undefined) { sub.currentPeriodEnd = null; changed = true; }
    if (sub.cancelAtPeriodEnd === undefined) { sub.cancelAtPeriodEnd = false; changed = true; }
    if (sub.reviewsUsed === undefined) { sub.reviewsUsed = 0; changed = true; }
    if (sub.usagePeriodStart === undefined) { sub.usagePeriodStart = Date.now(); changed = true; }
    if (sub.pendingPlan === undefined) { sub.pendingPlan = null; changed = true; }
    if (sub.scheduleId === undefined) { sub.scheduleId = null; changed = true; }
    if (changed) mutated = true;
  }
  for (const r of snapshot.repositories || []) {
    if ((r as any).private === undefined) {
      (r as any).private = false;
      mutated = true;
    }
  }
  return mutated;
}

// ---------------------------------------------------------------------------
// Write-through batching
//
// Mutations stage their net effect in `dirty` (upserts) / `deleted` (removes),
// keyed by collection. `dirty` and `deleted` are mutually exclusive per id —
// staging one clears the other — so the last write to an id within a batch
// wins, matching the in-memory snapshot. A debounced flush drains both into a
// single transaction.
// ---------------------------------------------------------------------------
const dirty = new Map<keyof DB, Map<string, unknown>>();
const deleted = new Map<keyof DB, Set<string>>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

function rowId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

function stageUpsert(name: keyof DB, row: unknown): void {
  if (!pool) return; // ephemeral mode — nothing to persist
  const id = rowId(row);
  if (!id) return;
  let d = dirty.get(name);
  if (!d) dirty.set(name, (d = new Map()));
  d.set(id, row);
  deleted.get(name)?.delete(id);
  schedule();
}

function stageDelete(name: keyof DB, id: string): void {
  if (!pool) return;
  let s = deleted.get(name);
  if (!s) deleted.set(name, (s = new Set()));
  s.add(id);
  dirty.get(name)?.delete(id);
  schedule();
}

function hasPending(): boolean {
  for (const m of dirty.values()) if (m.size) return true;
  for (const s of deleted.values()) if (s.size) return true;
  return false;
}

function schedule(): void {
  if (!pool || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void runFlush();
  }, 50);
}

async function persistBatch(
  upserts: Array<[keyof DB, unknown[]]>,
  deletes: Array<[keyof DB, string[]]>
): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query("begin");
    for (const [name, rows] of upserts) {
      const t = TABLES[name];
      // Chunk so the parameter count per statement stays well bounded.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const params: unknown[] = [];
        const tuples = slice.map((row, j) => {
          params.push(rowId(row), row);
          return `($${j * 2 + 1}, $${j * 2 + 2})`;
        });
        await client.query(
          `insert into "${t}" (id, data) values ${tuples.join(", ")} ` +
            `on conflict (id) do update set data = excluded.data`,
          params
        );
      }
    }
    for (const [name, ids] of deletes) {
      if (!ids.length) continue;
      await client.query(`delete from "${TABLES[name]}" where id = any($1::text[])`, [ids]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function runFlush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      while (pool && hasPending()) {
        // Snapshot and clear the shared maps so mutations arriving mid-flush
        // accumulate into the next batch instead of being lost.
        const upserts: Array<[keyof DB, unknown[]]> = [];
        for (const [name, m] of dirty) {
          if (m.size) {
            upserts.push([name, [...m.values()]]);
            m.clear();
          }
        }
        const deletes: Array<[keyof DB, string[]]> = [];
        for (const [name, s] of deleted) {
          if (s.size) {
            deletes.push([name, [...s]]);
            s.clear();
          }
        }
        try {
          await persistBatch(upserts, deletes);
        } catch (err) {
          // Re-stage the failed batch (without clobbering newer writes) and
          // back off before the loop retries.
          for (const [name, rows] of upserts) {
            const d = dirty.get(name) ?? (dirty.set(name, new Map()), dirty.get(name)!);
            for (const row of rows) {
              const id = rowId(row);
              if (id && !d.has(id) && !deleted.get(name)?.has(id)) d.set(id, row);
            }
          }
          for (const [name, ids] of deletes) {
            const s = deleted.get(name) ?? (deleted.set(name, new Set()), deleted.get(name)!);
            for (const id of ids) if (!dirty.get(name)?.has(id)) s.add(id);
          }
          console.error("[db] flush failed — will retry:", (err as Error).message);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Block until all staged writes are durable in Postgres. */
export async function flushPending(): Promise<void> {
  if (!pool) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Loop in case writes land between draining and the await resolving.
  do {
    await runFlush();
  } while (hasPending());
}

// node-postgres reads `ssl` straight from the config below, so the libpq-style
// query params in the URL are redundant; strip them to silence pg's
// sslmode-deprecation warning. TLS verification still happens via `ssl` below.
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ["sslmode", "channel_binding", "uselibpqcompat"]) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

async function ensureSchema(): Promise<void> {
  for (const name of COLLECTIONS) {
    await pool!.query(
      `create table if not exists "${TABLES[name]}" (id text primary key, data jsonb not null)`
    );
  }
}

async function loadAll(): Promise<void> {
  const fresh = structuredClone(empty);
  for (const name of COLLECTIONS) {
    const { rows } = await pool!.query<{ data: unknown }>(`select data from "${TABLES[name]}"`);
    (fresh[name] as unknown[]) = rows.map((r) => r.data);
  }
  state = fresh;
}

/**
 * Connect to Postgres, ensure the schema, and load the full dataset into the
 * in-memory snapshot. Must be awaited before the server starts serving so the
 * synchronous read API has data. With no DATABASE_URL configured, falls back
 * to an ephemeral in-memory store (no persistence) so the server can still boot.
 */
export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    console.warn("[db] DATABASE_URL not set — using ephemeral in-memory store (no persistence)");
    state = structuredClone(empty);
    pool = null;
    return;
  }
  pool = new Pool({
    connectionString: sanitizeUrl(config.databaseUrl),
    ssl: { rejectUnauthorized: true },
    max: 5,
  });
  await ensureSchema();
  await loadAll();

  if (backfillAttachmentIds(state)) {
    for (const task of state.tasks) stageUpsert("tasks", task);
    await flushPending();
    console.log("[db] migrated attachment ids");
  }

  if (migrateForPaywall(state)) {
    for (const u of state.users) stageUpsert("users", u);
    for (const s of state.subscriptions) stageUpsert("subscriptions", s);
    for (const r of state.repositories) stageUpsert("repositories", r);
    await flushPending();
    console.log("[db] migrated plans/subscriptions/repos for paywall");
  }

  const total = COLLECTIONS.reduce((n, k) => n + state[k].length, 0);
  console.log(`[db] connected to Postgres — loaded ${total} rows across ${COLLECTIONS.length} tables`);
}

/** Flush pending writes and close the pool. Call on graceful shutdown. */
export async function shutdownDb(): Promise<void> {
  await flushPending();
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export const db = {
  // Read primitive — return the live array; callers must not mutate without flushing
  table<K extends keyof DB>(name: K): DB[K] {
    return state[name];
  },

  insert<K extends keyof DB>(name: K, row: DB[K][number]) {
    (state[name] as DB[K][number][]).push(row);
    stageUpsert(name, row);
    return row;
  },

  update<K extends keyof DB>(
    name: K,
    predicate: (row: DB[K][number]) => boolean,
    patch: Partial<DB[K][number]>
  ): DB[K][number] | null {
    const list = state[name] as DB[K][number][];
    const idx = list.findIndex(predicate);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch };
    stageUpsert(name, list[idx]);
    return list[idx];
  },

  remove<K extends keyof DB>(name: K, predicate: (row: DB[K][number]) => boolean) {
    const list = state[name] as DB[K][number][];
    const kept: DB[K][number][] = [];
    const removed: DB[K][number][] = [];
    for (const row of list) (predicate(row) ? removed : kept).push(row);
    if (removed.length === 0) return 0;
    state[name] = kept as DB[K];
    for (const row of removed) {
      const id = rowId(row);
      if (id) stageDelete(name, id);
    }
    return removed.length;
  },

  find<K extends keyof DB>(name: K, predicate: (row: DB[K][number]) => boolean) {
    return (state[name] as DB[K][number][]).find(predicate) || null;
  },

  filter<K extends keyof DB>(name: K, predicate: (row: DB[K][number]) => boolean) {
    return (state[name] as DB[K][number][]).filter(predicate);
  },

  dump() {
    return state;
  },
};
