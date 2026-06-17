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
import { config, isEncryptionConfigured } from "./config.js";
import { isUnstorableDataError, sanitizeForJsonb } from "./db-sanitize.js";
import { isSealed, open, seal } from "./crypto/secret-box.js";
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

// ---------------------------------------------------------------------------
// At-rest secret encryption
//
// The store is otherwise schema-agnostic (every collection is a `(id, jsonb)`
// row), so this registry is the one place that knows a field holds secrets we
// must not write in plaintext. Encryption is applied transparently at the
// persistence boundary: rows are sealed on the way to Postgres and opened on
// load, so the in-memory snapshot — and every read site — keeps seeing
// plaintext, and nothing else in the codebase needs to change.
// ---------------------------------------------------------------------------
const ENCRYPTED_FIELDS: Partial<Record<keyof DB, string>> = { integrations: "tokens" };

// Ids of rows that loaded with their secret field still in legacy plaintext
// form (pre-encryption). initDb() re-stages exactly these so the one-shot
// migration only rewrites what's actually unencrypted. Reset each loadAll().
let legacyPlaintextIds = new Map<keyof DB, Set<string>>();
let warnedSealedNoKey = false;

// Shallow-copy `row` with its secret field sealed for storage. Never mutates the
// in-memory row (read sites depend on plaintext). No-op when encryption is off,
// the collection has no secret field, the value is absent, or it's already sealed.
function encodeForStore<T>(name: keyof DB, row: T): T {
  const field = ENCRYPTED_FIELDS[name];
  if (!field || !isEncryptionConfigured() || !row || typeof row !== "object") return row;
  const r = row as Record<string, unknown>;
  const val = r[field];
  if (val == null || isSealed(val)) return row;
  return { ...r, [field]: seal(val) } as T;
}

// Shallow-copy loaded `data` with its secret field opened back to plaintext.
// Legacy plaintext rows pass through unchanged (and are recorded for migration).
// A sealed row with no key configured can't be opened — warn once and leave the
// envelope in place (the integration is inert but no token leaks either way).
function decodeFromLoad<T>(name: keyof DB, data: T): T {
  const field = ENCRYPTED_FIELDS[name];
  if (!field || !data || typeof data !== "object") return data;
  const r = data as Record<string, unknown>;
  const val = r[field];
  if (!isSealed(val)) {
    if (val != null) {
      const id = rowId(data);
      if (id) {
        let s = legacyPlaintextIds.get(name);
        if (!s) legacyPlaintextIds.set(name, (s = new Set()));
        s.add(id);
      }
    }
    return data; // legacy plaintext (or empty) — used as-is, migrated on boot
  }
  if (!isEncryptionConfigured()) {
    if (!warnedSealedNoKey) {
      warnedSealedNoKey = true;
      console.warn(
        "[db] encrypted secrets found but INTEGRATION_ENCRYPTION_KEY is not set — " +
          "affected integrations will not work until the key is restored."
      );
    }
    return data;
  }
  try {
    return { ...r, [field]: open(val) } as T;
  } catch (err) {
    console.error(
      `[db] Failed to decrypt '${field}' for ${name} row ${rowId(data) || "unknown"} — keeping sealed envelope:`,
      err
    );
    return data;
  }
}

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

// --- Write-through health (surfaced via dbHealth() -> /api/health) ----------
// The old flush re-staged a failed batch and retried it forever; because the
// whole dataset went in one transaction, a single row Postgres refused to store
// (e.g. a NUL byte in jsonb) froze ALL persistence while reads kept coming from
// the in-memory snapshot — so the app looked fine until a redeploy reloaded the
// stale DB. We now (a) scrub values that jsonb rejects before writing, (b) on a
// batch failure fall back to row-by-row and QUARANTINE any row the DB still
// rejects (dropped from persistence + counted, never re-staged) so it can't
// block the batch, and (c) bound transient retries so we never hot-spin.
let consecutiveFlushFailures = 0;
let lastFlushError: string | null = null;
let lastFlushErrorAt: number | null = null;
let quarantinedRows = 0;
// 0.5s, 1s, 2s, 4s, 5s — capped low so a clean shutdown (Render SIGKILLs after
// ~30s) and boot can't hang on an unreachable DB. Transient work left after a
// give-up is retried when the next mutation reschedules a flush.
const MAX_TRANSIENT_RETRIES = 5;
const backoffMs = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 5_000);

function pendingCount(): number {
  let n = 0;
  for (const m of dirty.values()) n += m.size;
  for (const s of deleted.values()) n += s.size;
  return n;
}

function onFlushOk(): void {
  consecutiveFlushFailures = 0;
  lastFlushError = null;
}

function recordFlushFailure(message: string): void {
  consecutiveFlushFailures++;
  lastFlushError = message;
  lastFlushErrorAt = Date.now();
  console.error(`[db] flush failed — ${message}`);
}

function quarantineRow(name: keyof DB, row: unknown, err: unknown): void {
  quarantinedRows++;
  const id = rowId(row);
  console.error(
    `[db] QUARANTINED unstorable row ${String(name)}/${id ?? "?"}: ` +
      `${(err as Error)?.message || String(err)}. The row stays in memory this ` +
      `session but will NOT survive a restart — it is dropped from persistence so ` +
      `it can't block other writes. Investigate this row; it is a data bug.`
  );
}

/**
 * Write-through health snapshot for /api/health. `writeThrough` reads "degraded"
 * while flushes are failing or after any row was quarantined (a dropped write =
 * latent data loss worth surfacing until the next clean restart).
 */
export function dbHealth() {
  return {
    mode: pool ? "postgres" : "ephemeral",
    writeThrough:
      !pool || (consecutiveFlushFailures === 0 && quarantinedRows === 0) ? "ok" : "degraded",
    // "unconfigured" once a real DB is connected but no encryption key is set —
    // integration tokens are being written in plaintext until the key is added.
    encryption: pool && !isEncryptionConfigured() ? "unconfigured" : "ok",
    pendingWrites: pendingCount(),
    consecutiveFlushFailures,
    quarantinedRows,
    lastFlushError,
    lastFlushErrorAt,
  };
}

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
          // Seal secret fields, then scrub NUL / lone surrogates that jsonb would
          // reject (see db-sanitize). The sealed blob is clean base64, so the
          // scrub is a no-op on it — encode before sanitize is safe.
          params.push(rowId(row), sanitizeForJsonb(encodeForStore(name, row)));
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

type Batch = {
  upserts: Array<[keyof DB, unknown[]]>;
  deletes: Array<[keyof DB, string[]]>;
};

// Drain the staged maps into batch arrays, clearing them so mutations arriving
// mid-flush accumulate into the next batch instead of being lost.
function drainStaged(): Batch {
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
  return { upserts, deletes };
}

// Re-stage unpersisted work without clobbering newer writes to the same id.
function restage(upserts: Array<[keyof DB, unknown[]]>, deletes: Array<[keyof DB, string[]]>): void {
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
}

// Fallback when the atomic batch fails: persist row-by-row so a single row the
// database rejects is QUARANTINED (dropped + counted) rather than rolling back
// and blocking every other write. Returns "ok" when every row was stored or
// quarantined; otherwise the unprocessed remainder — a transient/connection
// failure — for the caller to re-stage and retry with backoff.
async function persistIsolating(
  upserts: Array<[keyof DB, unknown[]]>,
  deletes: Array<[keyof DB, string[]]>
): Promise<"ok" | Batch> {
  const client = await pool!.connect().catch(() => null);
  if (!client) return { upserts, deletes }; // can't even connect -> all transient
  try {
    for (let ui = 0; ui < upserts.length; ui++) {
      const [name, rows] = upserts[ui];
      const t = TABLES[name];
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        try {
          await client.query(
            `insert into "${t}" (id, data) values ($1, $2) ` +
              `on conflict (id) do update set data = excluded.data`,
            [rowId(row), sanitizeForJsonb(encodeForStore(name, row))]
          );
        } catch (err) {
          if (isUnstorableDataError(err)) {
            quarantineRow(name, row, err);
            continue;
          }
          // Transient mid-stream: re-stage this row and everything after it.
          return { upserts: [[name, rows.slice(ri)], ...upserts.slice(ui + 1)], deletes };
        }
      }
    }
    for (let di = 0; di < deletes.length; di++) {
      const [name, ids] = deletes[di];
      const t = TABLES[name];
      for (let ii = 0; ii < ids.length; ii++) {
        try {
          await client.query(`delete from "${t}" where id = $1`, [ids[ii]]);
        } catch (err) {
          if (isUnstorableDataError(err)) continue; // implausible for a delete; drop
          return { upserts: [], deletes: [[name, ids.slice(ii)], ...deletes.slice(di + 1)] };
        }
      }
    }
    return "ok";
  } finally {
    client.release();
  }
}

async function runFlush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    let transientRetries = 0;
    try {
      while (pool && hasPending()) {
        const { upserts, deletes } = drainStaged();
        // Fast path: the whole batch in one transaction.
        try {
          await persistBatch(upserts, deletes);
          onFlushOk();
          transientRetries = 0;
          continue;
        } catch {
          // Atomic batch failed — fall through to row-by-row isolation so one
          // poison row is quarantined instead of rolling back (and blocking)
          // every other write in the batch.
        }
        const remaining = await persistIsolating(upserts, deletes);
        if (remaining === "ok") {
          onFlushOk();
          transientRetries = 0;
          continue;
        }
        // Genuinely transient (couldn't connect / mid-stream drop): re-stage the
        // remainder and back off — bounded, so we never hot-spin or hang.
        restage(remaining.upserts, remaining.deletes);
        transientRetries++;
        recordFlushFailure(`transient write failure (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          console.error(
            `[db] giving up after ${transientRetries} transient failures; ` +
              `${pendingCount()} write(s) remain in memory and will retry on the next ` +
              `mutation or flushPending().`
          );
          break;
        }
        await new Promise((r) => setTimeout(r, backoffMs(transientRetries)));
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * Block until staged writes are flushed (graceful shutdown + post-load
 * migrations). Bounded: one runFlush drains everything storable and quarantines
 * what it can't; only a persistently-unreachable DB leaves work pending, which
 * we warn about rather than hang on (Render SIGKILLs after its grace window).
 */
export async function flushPending(): Promise<void> {
  if (!pool) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await runFlush();
  if (hasPending()) {
    console.error(
      `[db] flushPending: ${pendingCount()} write(s) still unpersisted (database unreachable?).`
    );
  }
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

// Host + database name only (never credentials), for the boot log. Makes it
// obvious at a glance WHICH database an environment is talking to — the cheapest
// guard against dev and prod accidentally sharing one (see .env.example).
function describeDb(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "unknown";
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
  legacyPlaintextIds = new Map(); // recomputed below by decodeFromLoad
  for (const name of COLLECTIONS) {
    const { rows } = await pool!.query<{ data: unknown }>(`select data from "${TABLES[name]}"`);
    (fresh[name] as unknown[]) = rows.map((r) => decodeFromLoad(name, r.data));
  }
  state = fresh;
}

/**
 * Connect to Postgres, ensure the schema, and load the full dataset into the
 * in-memory snapshot. Must be awaited before the server starts serving so the
 * synchronous read API has data. With no DATABASE_URL configured, falls back
 * to an ephemeral in-memory store (no persistence) so the server can still boot.
 *
 * `poolOverride` injects a pool for tests (exercise the write-through flush with
 * a fake pg pool); production always constructs its own from DATABASE_URL.
 */
export async function initDb(opts?: { poolOverride?: PgPool }): Promise<void> {
  // Reset health counters so each boot (and each test that re-inits) starts clean.
  consecutiveFlushFailures = 0;
  lastFlushError = null;
  lastFlushErrorAt = null;
  quarantinedRows = 0;
  warnedSealedNoKey = false;
  if (opts?.poolOverride) {
    pool = opts.poolOverride;
  } else if (!config.databaseUrl) {
    console.warn("[db] DATABASE_URL not set — using ephemeral in-memory store (no persistence)");
    state = structuredClone(empty);
    pool = null;
    return;
  } else {
    pool = new Pool({
      connectionString: sanitizeUrl(config.databaseUrl),
      ssl: { rejectUnauthorized: true },
      max: 5,
    });
  }
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

  // One-shot: encrypt any secret field still stored in plaintext. decodeFromLoad
  // recorded the rows that loaded unencrypted; re-staging them seals on the next
  // flush. Idempotent — once sealed at rest, later boots record nothing.
  if (isEncryptionConfigured()) {
    let migrated = 0;
    for (const [name, ids] of legacyPlaintextIds) {
      for (const row of state[name] as unknown as Array<{ id?: string }>) {
        if (row.id && ids.has(row.id)) {
          stageUpsert(name, row);
          migrated++;
        }
      }
    }
    if (migrated) {
      await flushPending();
      console.log(`[db] encrypted ${migrated} integration secret(s) at rest`);
    }
  } else if (pool) {
    console.warn(
      "[db] INTEGRATION_ENCRYPTION_KEY is not set — integration tokens are stored in " +
        "PLAINTEXT at rest. Set the key to encrypt them (see .env.example)."
    );
  }

  const total = COLLECTIONS.reduce((n, k) => n + state[k].length, 0);
  const target = opts?.poolOverride ? "injected test pool" : describeDb(config.databaseUrl);
  console.log(
    `[db] connected [${target}] — loaded ${total} rows across ${COLLECTIONS.length} tables`
  );
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
