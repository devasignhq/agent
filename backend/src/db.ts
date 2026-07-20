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
import type { PoolClient } from "pg";
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
  bounties: [],
  escrowTransactions: [],
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
  bounties: "bounties",
  escrowTransactions: "escrow_transactions",
};

const COLLECTIONS = Object.keys(TABLES) as (keyof DB)[];

let state: DB = structuredClone(empty);
let pool: PgPool | null = null;
// Diagnostics for the "store wiped on redeploy" failure mode. Surfaced via
// dbHealth() -> /api/health so a wipe is visible in one request right after a
// deploy: `rowsLoadedAtBoot` is how many rows loadAll() pulled back from
// Postgres at boot (a sudden 0 on a DB that had data is the smoking gun), and
// `bootedAt` confirms the process actually restarted.
let rowsLoadedAtBoot = 0;
let bootedAt = 0;

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
// A sealed row that a *configured* key fails to open (corruption / rotated key)
// is blanked to an empty secret: the boot load survives and consumers read it as
// "not connected" rather than receiving the raw envelope as a credential.
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
    // A configured key that still can't open the envelope means the row is
    // corrupt/tampered (or was sealed with a since-rotated key). Don't crash the
    // boot load — but don't hand callers the raw envelope either: they read this
    // field as a plaintext secret (e.g. an integration token) and would otherwise
    // treat the SealedSecret object as a credential. Blank it to an empty record
    // so every consumer sees "no token / not connected" (they read `tokens.*`
    // unguarded, so a `null` here would throw a TypeError instead).
    console.error(
      `[db] Failed to decrypt '${field}' for ${name} row ${rowId(data) || "unknown"} — treating its secret as unavailable:`,
      err
    );
    return { ...r, [field]: {} } as T;
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
// Monotonic generation for the in-flight flush loop. breakStall() bumps it to
// CANCEL a wedged loop: runFlush captures it and bails after any await once it no
// longer matches, so a forced recovery flush can never run concurrently with the
// loop it replaced (preserves single-flight).
let flushEpoch = 0;

// ---------------------------------------------------------------------------
// Coherence (delta-sync) — keep this process's cache live with Postgres
//
// The cache used to be a load-ONCE snapshot: read at boot, never reconciled, so
// a second process on the same DB (Render's zero-downtime deploy overlaps the
// old and new instance) served a stale view AND clobbered the other's committed
// rows via whole-row last-write-wins. We close that by (a) tagging every row
// with a per-row monotonic `version` (in its jsonb) and only letting a write win
// the upsert when its version is >= the stored one — a stale instance can't roll
// a row back; and (b) giving every table a DB-assigned `rev` (a global sequence)
// and polling `where rev > watermark` so each instance pulls in rows another
// instance committed. Postgres is the source of truth; the cache revalidates to
// it continuously instead of trusting a frozen boot snapshot.
//
// NB: delta-sync uses plain SELECTs, so it works through Neon's PgBouncer pooler
// (which prod connects to and which does NOT support LISTEN/NOTIFY).
const REV_SEQ = "devasign_rev_seq";
const DELTA_SYNC_MS = 2_000; // pull inserts/updates committed elsewhere (gentle on the pool)
const DELETE_SWEEP_MS = 30_000; // reconcile deletes (rev-watermark can't see a gone row)
// Highest `rev` this process has merged, per table. Drives the delta-sync poll.
const revWatermark = new Map<keyof DB, number>();
let coherenceTimer: NodeJS.Timeout | null = null;
let sweepCountdownMs = 0; // run the (heavier) delete sweep every DELETE_SWEEP_MS
let syncing = false; // single-flight guard so the two passes never interleave on `state`
let lastSyncAt = 0; // for dbHealth — confirms coherence is actually ticking

// --- Pool self-healing ------------------------------------------------------
// node-pg does NOT always recover a pool whose connections died in a way it
// didn't observe — Neon dropping the whole compute's sessions, a PgBouncer/proxy
// reset. The pool then keeps handing out dead clients and EVERY flush fails
// "unreachable" indefinitely (the prod symptom: writes work for ~90s, then wedge
// for minutes while reads keep serving from cache). Swapping in a brand-new Pool
// forces fresh TCP/PgBouncer sessions. Debounced so repeated failures can't
// thrash it. Staged writes live in dirty/deleted (not the pool), so the swap
// loses nothing.
let realPool = false; // true only for a pool we built from DATABASE_URL (not a test stub)
let lastPoolRebuild = 0;
const POOL_REBUILD_DEBOUNCE_MS = 20_000;
let lastErrorLoggedAt = 0; // rate-limit surfacing the real flush error
// Tests inject a factory so a rebuild mints a fresh fake pool (production uses a
// real Pool from DATABASE_URL); and a fixed backoff so the give-up path is fast.
let poolFactory: (() => PgPool) | null = null;
let backoffOverrideMs: number | null = null;

// --- Stall breaker: recover a SILENT write-through wedge ---------------------
// A flush can wedge WITHOUT erroring — a hung op the per-op watchdog didn't
// catch leaves the single-flight `flushing` promise pending, so every later
// flush short-circuits (`if (flushing) return flushing`) and staged writes never
// drain. Because nothing ERRORS, the failure-keyed recovery (rebuild-on-give-up,
// heartbeat) never engages: /api/health just reads `writeThrough:"stalled"`,
// `lastFlushError:null` forever and writes 503. This breaks it: when the backlog
// hasn't made progress in stallBreakMs AND nothing has been recorded as failing,
// abandon the wedged flush, reconcile the FULL in-memory snapshot (so any write
// trapped in the abandoned flush is re-staged from authoritative memory — no
// loss), rebuild the pool, and re-flush. The forced flush also makes the real
// error finally surface if the writes genuinely can't persist.
let lastFlushProgressAt = 0;
let stallBreakerTimer: NodeJS.Timeout | null = null;
const DEFAULT_STALL_BREAK_MS = 20_000;
let stallBreakMs = DEFAULT_STALL_BREAK_MS;
let stallCheckOverrideMs: number | null = null; // tests drive a fast check cadence
// Consecutive silent breaks in the CURRENT incident. When force-recovery keeps
// firing with no forward progress, this trips escalation: record a real failure so
// /health goes "degraded" and the backoff heartbeat owns recovery, instead of
// spinning + spamming every ~50s forever. Reset by onFlushOk on real progress.
let consecutiveStallBreaks = 0;
const DEFAULT_STALL_ESCALATE_AFTER = 3;
let stallEscalateAfter = DEFAULT_STALL_ESCALATE_AFTER;

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

// Background retry. A single runFlush pass gives up after MAX_TRANSIENT_RETRIES so
// it can't hot-spin or hang a shutdown — but if it gives up, the parked writes
// must NOT wait for a new mutation to be retried (a wedged Neon connection on an
// idle box would otherwise never re-flush, and the backlog dies on the next
// redeploy — exactly the prod data-loss we're fixing). This heartbeat keeps
// draining the backlog on its own, self-stops once it's empty, and restarts on
// the next give-up / pool 'error'. Unref'd so it never holds the process open.
let heartbeatTimer: NodeJS.Timeout | null = null;
const HEARTBEAT_MS = 15_000;

// Second-order data-loss trap this guards against: a flush that HANGS (vs errors).
// The pool bounds connect (connectionTimeoutMillis) but a query on a half-open
// socket can hang forever; runFlush's `if (flushing) return flushing` guard then
// wedges every later flush — heartbeat included — so writes pile up unpersisted
// while NOTHING errors (writeThrough stayed "ok"), and the backlog dies on the
// next redeploy. Two bounds close it, plus a visibility signal:
//  • Pool statement/query/idle-txn timeouts (DB_STATEMENT_TIMEOUT_MS): a stuck
//    flush query REJECTS so the existing restage→retry→heartbeat path fires.
//  • A per-op watchdog (flushWatchdogMs) races each flush op as a last-resort net
//    for a hang the DB layer doesn't reject, so `flushing` can never stay pending.
//    Sits ABOVE the DB timeout so the clean DB-level cancellation normally wins.
//  • Stall detection (stallThresholdMs): an un-drained backlog older than this
//    reads as writeThrough "stalled" even when nothing errored — so a future
//    unforeseen wedge is visible/alertable instead of masquerading as "ok".
// Generous vs a healthy flush (tens of ms) and safe for the boot load select.
const DB_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_FLUSH_WATCHDOG_MS = 45_000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;
// Overridable via initDb opts so tests can exercise hang/stall paths without
// waiting tens of seconds; production always uses the defaults above.
let flushWatchdogMs = DEFAULT_FLUSH_WATCHDOG_MS;
let stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
// Bound pool.connect() at the app layer. `connectionTimeoutMillis` (libpq) doesn't
// reliably cover a stall AFTER the TCP connect — a Neon/PgBouncer startup-handshake
// hang — which otherwise wedges the flush silently until the 45s watchdog. Kept
// at/below the watchdog; overridable via initDb for tests.
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;

// When the oldest still-pending write was first staged (null = backlog empty).
// Drives stall detection without timestamping every row: set on the first stage
// into an empty backlog, cleared once a flush confirms the backlog fully drained.
let firstStagedAt: number | null = null;

function pendingCount(): number {
  let n = 0;
  for (const m of dirty.values()) n += m.size;
  for (const s of deleted.values()) n += s.size;
  return n;
}

function onFlushOk(): void {
  const wasFailing = consecutiveFlushFailures > 0;
  consecutiveFlushFailures = 0;
  consecutiveStallBreaks = 0; // real progress ends any in-flight silent-wedge incident
  lastFlushError = null;
  lastFlushProgressAt = Date.now(); // real forward progress — resets the stall-breaker clock
  // A successful flush is forward progress, so reset the stall clock. If writes
  // re-staged concurrently (continuous load), re-arm it to NOW so the age measures
  // how long the CURRENT undrained backlog has been stuck — not total time since
  // the first-ever stage. Without this, sustained load keeps hasPending() true so
  // the clock stays pinned to the oldest stage and a healthy, draining backlog
  // eventually reads as a false "stalled".
  firstStagedAt = hasPending() ? Date.now() : null;
  // The instant a wedged connection comes back, re-stage the FULL in-memory
  // snapshot so Postgres reconverges to memory — not just the last dirty set.
  // This recovers anything the give-up path parked AND anything that drifted
  // while persistence was down, so a redeploy can't reload a stale DB.
  if (wasFailing) {
    console.warn("[db] write-through recovered — re-syncing full snapshot to Postgres");
    reconcileAll();
  }
}

function recordFlushFailure(message: string): void {
  consecutiveFlushFailures++;
  lastFlushError = message;
  lastFlushErrorAt = Date.now();
  // Throttle the log the same way logFlushError does (shared clock): the heartbeat
  // retries this path on backoff, so we don't want to trade the STALLED spam for
  // failure spam. The counters/health above are always updated — only the log gates.
  const now = Date.now();
  if (now - lastErrorLoggedAt >= 10_000) {
    lastErrorLoggedAt = now;
    console.error(`[db] flush failed — ${message}`);
  }
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
 * latent data loss worth surfacing until the next clean restart), and "stalled"
 * when a backlog has sat un-drained past stallThresholdMs WITHOUT recording a
 * failure — the silent-wedge signature that used to read as a healthy "ok".
 */
export function dbHealth() {
  const oldestPendingAgeMs =
    firstStagedAt !== null && hasPending() ? Date.now() - firstStagedAt : 0;
  const stalled = !!pool && oldestPendingAgeMs > stallThresholdMs;
  return {
    mode: pool ? "postgres" : "ephemeral",
    writeThrough: !pool
      ? "ok"
      : consecutiveFlushFailures > 0 || quarantinedRows > 0
        ? "degraded"
        : stalled
          ? "stalled"
          : "ok",
    // "unconfigured" once a real DB is connected but no encryption key is set —
    // integration tokens are being written in plaintext until the key is added.
    encryption: pool && !isEncryptionConfigured() ? "unconfigured" : "ok",
    pendingWrites: pendingCount(),
    // Age of the oldest un-flushed write (0 when the backlog is empty). A value
    // that keeps climbing = writes aren't reaching Postgres.
    oldestPendingAgeMs,
    consecutiveFlushFailures,
    quarantinedRows,
    lastFlushError,
    lastFlushErrorAt,
    rowsLoadedAtBoot,
    bootedAt,
    // Coherence (delta-sync) liveness: how long since the cache last revalidated
    // against Postgres. Ticks every ~1s; a climbing value means this instance may
    // be serving a stale view (the failure the coherent cache exists to prevent).
    coherence: !pool ? "ok" : lastSyncAt && Date.now() - lastSyncAt > 10_000 ? "stalled" : "ok",
    coherenceAgeMs: pool && lastSyncAt ? Date.now() - lastSyncAt : 0,
  };
}

/**
 * True only when writes are genuinely failing to reach Postgres — a flush errored
 * and has not since recovered (`onFlushOk` zeroes this on any successful drain).
 * This is the durability barrier's 503 gate. A non-zero GLOBAL pending backlog is
 * NORMAL — the bounty keeper and review worker stage writes continuously — and
 * must NOT fail a request whose own writes `flushPending()` already drained;
 * gating on `pendingWrites() > 0` produced a spurious `not_durable` whenever any
 * concurrent actor staged a write in the drain→recheck gap. Quarantined rows are
 * deliberately excluded: a poison row re-quarantines on every retry, so 503-ing it
 * would loop the client forever (it is a data bug, not a persistence outage).
 */
export function persistenceFailing(): boolean {
  return !!pool && consecutiveFlushFailures > 0;
}

function rowId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

// Per-row monotonic version, bumped on every mutation. Persisted inside the
// row's jsonb and used solely by the upsert's anti-clobber guard — read sites
// never reference it. A row with no version yet (legacy) starts at 1.
function bumpedVersion(row: unknown): number {
  const v = (row as { version?: unknown } | null)?.version;
  return (typeof v === "number" ? v : 0) + 1;
}

function stageUpsert(name: keyof DB, row: unknown): void {
  if (!pool) return; // ephemeral mode — nothing to persist
  const id = rowId(row);
  if (!id) return;
  let d = dirty.get(name);
  if (!d) dirty.set(name, (d = new Map()));
  d.set(id, row);
  deleted.get(name)?.delete(id);
  if (firstStagedAt === null) {
    firstStagedAt = Date.now();
    // Leaving the idle state: reset the stall clock so it measures THIS backlog's
    // age, not the (possibly very old) time of the last successful flush. Without
    // this, the first write after a long idle period reads as instantly stalled
    // and trips a spurious rebuild + reconcile before its flush even runs.
    lastFlushProgressAt = Date.now();
  }
  schedule();
}

function stageDelete(name: keyof DB, id: string): void {
  if (!pool) return;
  let s = deleted.get(name);
  if (!s) deleted.set(name, (s = new Set()));
  s.add(id);
  dirty.get(name)?.delete(id);
  if (firstStagedAt === null) {
    firstStagedAt = Date.now();
    lastFlushProgressAt = Date.now(); // reset stall clock when leaving the idle state (see stageUpsert)
  }
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

// Keep retrying parked writes in the background until the backlog drains, so
// recovery never depends on a new mutation arriving. Idempotent to start.
function startHeartbeat(): void {
  if (!pool || heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!pool || !hasPending()) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    // Writes are still backed up. If they keep failing the pool may be wedged, so
    // give the retry a fresh pool to work with (rebuildPool is debounced).
    if (consecutiveFlushFailures > 0) rebuildPool("heartbeat: writes still failing");
    void runFlush();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

// Construct the production Pool (from DATABASE_URL) with the bounds + idle-error
// handler. Extracted so rebuildPool() can mint a fresh one on a wedge.
function buildPool(): PgPool {
  if (poolFactory) return poolFactory(); // test-injected; factory wires its own handlers
  const p = new Pool({
    connectionString: sanitizeUrl(config.databaseUrl),
    ssl: { rejectUnauthorized: true },
    max: 5,
    // Keep TCP alive through Neon/Render proxies so idle pooled connections
    // aren't silently reaped between flushes (the trigger for the prod wipe).
    keepAlive: true,
    // Bound a connect attempt so a suspended/unreachable Neon endpoint can't hang
    // a flush (or the shutdown drain) — the retry/heartbeat/rebuild handle waiting.
    connectionTimeoutMillis: 10_000,
    // Recycle idle pooled connections before an intermediary (Neon/Render proxy,
    // PgBouncer) can silently drop one and hand a dead connection to the next write
    // — the "reused idle connection hangs" trigger behind the silent write-through
    // wedge. keepAliveInitialDelayMillis starts TCP keepalive probes promptly.
    idleTimeoutMillis: 10_000,
    keepAliveInitialDelayMillis: 10_000,
    // Bound the QUERY too, not just connect: a flush query on a half-open socket
    // would otherwise hang forever and wedge the flusher (see runFlush).
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    query_timeout: DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DB_STATEMENT_TIMEOUT_MS,
  });
  // node-postgres emits 'error' on an idle client failing (Neon dropping an idle
  // connection, a network blip). With NO listener Node escalates it to an uncaught
  // exception that can kill the process — which then silently restarts and reloads
  // the stale DB. Swallow it (the bad client is already evicted) and make sure the
  // heartbeat is draining any parked writes once connectivity returns.
  p.on("error", (err) => {
    console.error("[db] idle pool client error (pool reconnects on next query):", err.message);
    startHeartbeat();
  });
  return p;
}

// Replace a wedged pool with a brand-new one (see the self-healing note above).
// Synchronous swap so the very next flush uses the fresh pool; the old pool is
// drained in the background (its end() can hang on dead clients, so never await).
function rebuildPool(reason: string): void {
  if (!realPool) return; // ephemeral / injected test pool — never rebuild
  const now = Date.now();
  if (now - lastPoolRebuild < POOL_REBUILD_DEBOUNCE_MS) return;
  lastPoolRebuild = now;
  const old = pool;
  console.warn(`[db] rebuilding Postgres connection pool — ${reason}`);
  pool = buildPool();
  void old?.end().catch(() => {});
}

// Surface the REAL error behind a flush failure (rate-limited). The flush path
// otherwise swallows it and only logs the generic "database unreachable?", which
// hides whether it's a connection drop, a timeout, or a server-side SQL error.
function logFlushError(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < 10_000) return;
  lastErrorLoggedAt = now;
  const e = err as { message?: string; code?: string } | null;
  console.error(`[db] flush error (code=${e?.code ?? "?"}): ${e?.message ?? String(err)}`);
}

// Force-recover a backlog that's stalled with NO recorded failure (the silent
// wedge described above). reconcileAll() re-stages the whole snapshot from
// authoritative in-memory state, so even writes trapped in the abandoned flush
// come back — nothing is lost.
function breakStall(): void {
  consecutiveStallBreaks++;
  flushEpoch++; // cancel the wedged loop so it can't run concurrently with the fresh flush
  flushing = null; // release the single-flight lock so a fresh flush can run
  reconcileAll(); // re-stage everything from memory (recovers writes trapped in the abandoned flush)

  if (consecutiveStallBreaks >= stallEscalateAfter) {
    // Force-recovery hasn't taken after several tries — the wedge is persistent, not
    // a one-off blip. Stop spinning (and spamming) every ~50s: record a REAL failure
    // so /health flips to "degraded" (alertable), the stall-breaker's own
    // `consecutiveFlushFailures > 0` guard self-disables it, and the backoff heartbeat
    // owns recovery. The next flush's watchdog/connect-timeout finally surfaces the
    // underlying DB error instead of "NO error recorded".
    console.error(
      `[db] write-through wedged silently through ${consecutiveStallBreaks} recovery attempts — ` +
        `escalating to degraded and handing off to the backoff heartbeat.`
    );
    recordFlushFailure(
      `silent write-through wedge (no error surfaced after ${consecutiveStallBreaks} recoveries)`
    );
    rebuildPool("stall breaker: escalating persistent silent wedge");
    lastFlushProgressAt = Date.now();
    startHeartbeat();
    void runFlush();
    return;
  }

  // First break of an incident: log once (the intermediate breaks stay quiet), then
  // force-recover. A transient wedge clears here on the fresh pool's first flush.
  if (consecutiveStallBreaks === 1) {
    const stalledForMs = Date.now() - lastFlushProgressAt;
    console.error(
      `[db] write-through STALLED ${Math.round(stalledForMs / 1000)}s with ${pendingCount()} ` +
        `write(s) pending and NO error recorded — force-recovering (abandon wedged flush, ` +
        `reconcile snapshot, rebuild pool, re-flush).`
    );
  }
  rebuildPool("stall breaker: silent write-through wedge");
  lastFlushProgressAt = Date.now(); // give the forced flush room before re-tripping
  void runFlush();
}

function startStallBreaker(): void {
  if (!pool || stallBreakerTimer) return;
  // Check often enough to react promptly, but never busier than ~1s in prod;
  // tests can drive a fast clock via stallCheckMs.
  const checkMs = stallCheckOverrideMs ?? Math.min(5_000, Math.max(1_000, Math.floor(stallBreakMs / 2)));
  stallBreakerTimer = setInterval(() => {
    // Only act on a SILENT stall: no recorded failure (a real outage records
    // failures and is handled by the give-up/heartbeat/rebuild path already).
    if (!pool || consecutiveFlushFailures > 0) return;
    // Fire on a wedged backlog even when the queue is IDLE: a flush can hold the
    // single-flight lock with writes trapped inside it (so hasPending() is false
    // yet `flushing` is non-null). Only skip when there is genuinely nothing
    // wedged AND nothing staged — otherwise a trapped backlog would be lost.
    if (!hasPending() && flushing === null) return;
    if (Date.now() - lastFlushProgressAt < stallBreakMs) return;
    breakStall();
  }, checkMs);
  stallBreakerTimer.unref?.();
}

function stopStallBreaker(): void {
  if (stallBreakerTimer) {
    clearInterval(stallBreakerTimer);
    stallBreakerTimer = null;
  }
}

// Convergence safety net: re-stage every row in the in-memory snapshot so a
// healthy connection rewrites the entire dataset (idempotent upsert-by-id).
// Called from onFlushOk on recovery; exported so an operator/endpoint can force a
// full re-sync. Deletes aren't replayed here — a re-appearing stale row is far
// less harmful than the data loss this guards against.
export function reconcileAll(): void {
  if (!pool) return;
  for (const name of COLLECTIONS) {
    for (const row of state[name] as unknown as Array<{ id?: string }>) {
      if (row && typeof row.id === "string") stageUpsert(name, row);
    }
  }
}

// Pull rows another instance committed since our per-table watermark and merge
// them into the cache, so this process serves Postgres' current state instead of
// a frozen boot snapshot. Skips any id we hold an un-flushed local write for
// (ours is the newer truth until it lands) and any row whose `version` isn't
// newer than what we already have (mirrors the upsert's anti-clobber guard).
async function deltaSyncMerge(): Promise<void> {
  for (const name of COLLECTIONS) {
    const watermark = revWatermark.get(name) ?? 0;
    const { rows } = await pool!.query<{ id: string; data: unknown; rev: string }>(
      `select id, data, rev from "${TABLES[name]}" where rev > $1 order by rev`,
      [watermark]
    );
    if (!rows.length) continue;
    const list = state[name] as Array<{ id?: string; version?: number }>;
    const pendingUpserts = dirty.get(name);
    const pendingDeletes = deleted.get(name);
    let maxRev = watermark;
    let minPendingSkip = Infinity; // lowest rev we skipped because OUR write is un-flushed
    for (const r of rows) {
      const rev = Number(r.rev);
      if (rev > maxRev) maxRev = rev;
      const id = typeof r.id === "string" ? r.id : null;
      if (!id) continue;
      // Our own un-flushed write to this id is the newer truth — don't clobber it.
      if (pendingUpserts?.has(id) || pendingDeletes?.has(id)) {
        if (rev < minPendingSkip) minPendingSkip = rev;
        continue;
      }
      const incoming = decodeFromLoad(name, r.data) as { id?: string; version?: number };
      const idx = list.findIndex((row) => row.id === id);
      if (idx === -1) {
        list.push(incoming);
      } else {
        const localV = typeof list[idx].version === "number" ? list[idx].version! : -1;
        const incomingV = typeof incoming.version === "number" ? incoming.version : 0;
        if (incomingV >= localV) list[idx] = incoming;
      }
    }
    // Hold the watermark just below the lowest rev we skipped because our own
    // write to that id is still pending: if that write later loses the version
    // guard (another instance committed newer), we must re-pull this rev to
    // re-converge. Once the pending write resolves, the next pass advances.
    //
    // This can only HOLD the watermark, never regress it: the query returns only
    // rows with rev > watermark, so every skipped rev is >= watermark+1, hence
    // minPendingSkip-1 >= watermark; and maxRev >= watermark always. So the new
    // value is >= the old — the watermark is monotonically non-decreasing. The
    // worst case is re-pulling already-merged higher-rev rows for as long as a
    // low-rev write stays pending, which is bounded (a pending write drains in
    // ~one flush) and harmless: re-merges are idempotent and the `incomingV >=
    // localV` guard above means a re-pulled row can never overwrite a newer
    // cached one. (See db-coherence.test.ts "watermark hold-back".)
    revWatermark.set(name, Math.min(maxRev, minPendingSkip - 1));
  }
}

// A rev-watermark poll can't observe a deletion (the row is just gone), so a row
// another instance deleted would linger here — and could be resurrected if we
// later updated it. Periodically reconcile each table's id set against Postgres
// and drop cache rows that no longer exist there, never touching an id we have an
// un-flushed local write for (a freshly inserted row not yet persisted).
async function deleteSweepMerge(): Promise<void> {
  for (const name of COLLECTIONS) {
    const { rows } = await pool!.query<{ id: string }>(`select id from "${TABLES[name]}"`);
    const live = new Set(rows.map((r) => r.id));
    const pendingUpserts = dirty.get(name);
    const list = state[name] as Array<{ id?: string }>;
    const kept = list.filter((row) => {
      const id = typeof row.id === "string" ? row.id : null;
      if (!id) return true;
      return live.has(id) || !!pendingUpserts?.has(id);
    });
    if (kept.length !== list.length) (state[name] as unknown[]) = kept;
  }
}

// One coherence tick: always delta-sync; run the heavier delete sweep on a slower
// cadence. Single-flighted so the two passes never mutate `state` concurrently.
// Errors are swallowed — the next tick retries — so a transient DB blip can't
// kill the poller. Unref'd timer, so it never holds the process open.
async function coherenceTick(): Promise<void> {
  if (!pool || syncing) return;
  // Stand down while writes are failing: the pool is under recovery (and possibly
  // being rebuilt), so the poller's reads must not compete for connections or pile
  // more errors on. It resumes the moment a flush succeeds (failures reset to 0).
  if (consecutiveFlushFailures > 0) return;
  syncing = true;
  try {
    await deltaSyncMerge();
    sweepCountdownMs -= DELTA_SYNC_MS;
    if (sweepCountdownMs <= 0) {
      sweepCountdownMs = DELETE_SWEEP_MS;
      await deleteSweepMerge();
    }
    lastSyncAt = Date.now();
  } catch (err) {
    console.error("[db] coherence poll failed (will retry):", (err as Error)?.message || err);
  } finally {
    syncing = false;
  }
}

function startCoherence(): void {
  if (!pool || coherenceTimer) return;
  sweepCountdownMs = DELETE_SWEEP_MS;
  lastSyncAt = Date.now();
  coherenceTimer = setInterval(() => void coherenceTick(), DELTA_SYNC_MS);
  coherenceTimer.unref?.();
}

function stopCoherence(): void {
  if (coherenceTimer) {
    clearInterval(coherenceTimer);
    coherenceTimer = null;
  }
}

// Force a synchronous, full coherence pass — both the delta-sync merge and the
// delete sweep — without waiting on the 1s timer. For tests/ops ("reconcile this
// instance's cache against Postgres now"). No-op in ephemeral mode.
export async function syncFromStore(): Promise<void> {
  if (!pool || syncing) return;
  syncing = true;
  try {
    await deltaSyncMerge();
    await deleteSweepMerge();
    lastSyncAt = Date.now();
  } finally {
    syncing = false;
  }
}

// The `on conflict` clause shared by every upsert path. A write only wins when
// its row `version` is >= the stored one, so a stale instance (lower version)
// can never roll a row back — the anti-clobber half of coherence. `rev` is a
// global-sequence value re-used from the proposed (excluded) row so delta-sync
// on other instances notices the change. Existing rows with no `version` yet
// (legacy / pre-coherence) read as -1 so any real version supersedes them.
function upsertConflict(t: string): string {
  return (
    `on conflict (id) do update set data = excluded.data, rev = excluded.rev ` +
    `where coalesce((excluded.data->>'version')::bigint, 0) >= ` +
    `coalesce(("${t}".data->>'version')::bigint, -1)`
  );
}

async function persistBatch(
  upserts: Array<[keyof DB, unknown[]]>,
  deletes: Array<[keyof DB, string[]]>
): Promise<void> {
  const client = await connectBounded("flush connect");
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
          // Each row gets its own freshly-allocated `rev` from the global sequence.
          return `($${j * 2 + 1}, $${j * 2 + 2}, nextval('${REV_SEQ}'))`;
        });
        await client.query(
          `insert into "${t}" (id, data, rev) values ${tuples.join(", ")} ` +
            upsertConflict(t),
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
  const client = await connectBounded("isolate connect").catch((err) => {
    logFlushError(err); // surface the connect failure (e.g. ECONNREFUSED / timeout / bounded)
    return null;
  });
  if (!client) return { upserts, deletes }; // can't even connect -> all transient
  try {
    for (let ui = 0; ui < upserts.length; ui++) {
      const [name, rows] = upserts[ui];
      const t = TABLES[name];
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        try {
          await client.query(
            `insert into "${t}" (id, data, rev) values ($1, $2, nextval('${REV_SEQ}')) ` +
              upsertConflict(t),
            [rowId(row), sanitizeForJsonb(encodeForStore(name, row))]
          );
        } catch (err) {
          if (isUnstorableDataError(err)) {
            quarantineRow(name, row, err);
            continue;
          }
          // Transient mid-stream: surface it, then re-stage this row and after.
          logFlushError(err);
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

// Bound a DB op so a HANG (vs a rejection) can't leave the single in-flight
// `flushing` promise pending forever — which would wedge every later flush and
// the heartbeat, the exact silent-stall failure this guards against. Rejects with
// a labelled error the flush loop treats as a transient failure. The timer is
// unref'd so it can never hold the process open; the orphaned op is left to the
// pool's statement/query timeout to cancel server-side.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Bound pool.connect() at the app layer. `connectionTimeoutMillis` (libpq) doesn't
// reliably cover a stall AFTER the TCP connect — a Neon/PgBouncer startup-handshake
// hang — which would otherwise wedge the flush silently until the 45s watchdog. If
// the bound fires, release a late-resolving client so a wedged-then-recovered
// connect can't leak a checked-out client from the pool.
async function connectBounded(label: string): Promise<PoolClient> {
  const p = pool!.connect();
  let timedOut = false;
  p.then((c) => {
    if (timedOut) c.release();
  }).catch(() => {});
  try {
    return await withTimeout(p, connectTimeoutMs, label);
  } catch (err) {
    timedOut = true;
    throw err;
  }
}

async function runFlush(): Promise<void> {
  if (flushing) return flushing;
  // Cancellation token: breakStall() bumps flushEpoch to abandon a wedged loop.
  // This loop checks it after every await and exits the instant it's superseded,
  // so a stall-breaker's fresh flush is never racing a stale loop (single-flight).
  const myEpoch = flushEpoch;
  const cancelled = () => myEpoch !== flushEpoch;
  flushing = (async () => {
    let transientRetries = 0;
    try {
      while (pool && hasPending()) {
        if (cancelled()) return;
        const { upserts, deletes } = drainStaged();
        // Fast path: the whole batch in one transaction, watchdog-bounded so a
        // hung query rejects here instead of wedging `flushing` forever.
        try {
          await withTimeout(persistBatch(upserts, deletes), flushWatchdogMs, "flush batch");
          if (cancelled()) return; // a stall-breaker took over — don't double-act
          onFlushOk();
          transientRetries = 0;
          continue;
        } catch (err) {
          // Atomic batch failed/timed out — surface the real cause (rate-limited),
          // then fall through to row-by-row isolation so one poison row is
          // quarantined instead of rolling back (and blocking) every other write.
          logFlushError(err);
        }
        if (cancelled()) return;
        // Row-by-row isolation, also watchdog-bounded. drainStaged already cleared
        // these from `dirty`, so on a hang/throw here we must NOT drop them: treat
        // the whole drained set as still-pending and let the restage below requeue
        // it (no row is lost just because isolation itself stalled).
        let remaining: "ok" | Batch;
        try {
          remaining = await withTimeout(
            persistIsolating(upserts, deletes),
            flushWatchdogMs,
            "flush isolate"
          );
        } catch {
          remaining = { upserts, deletes };
        }
        if (cancelled()) return; // breakStall already reconciled these from memory
        if (remaining === "ok") {
          onFlushOk();
          transientRetries = 0;
          continue;
        }
        // Genuinely transient (couldn't connect / mid-stream drop / timed out):
        // re-stage the remainder and back off — bounded, so we never hot-spin or hang.
        restage(remaining.upserts, remaining.deletes);
        transientRetries++;
        recordFlushFailure(`transient write failure (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          console.error(
            `[db] giving up this pass after ${transientRetries} transient failures; ` +
              `${pendingCount()} write(s) remain in memory — a background heartbeat will keep ` +
              `retrying every ${HEARTBEAT_MS / 1000}s until the database is reachable again.`
          );
          // The pool may be wedged (dead connections node-pg won't replace). Mint a
          // fresh one so the heartbeat's next pass isn't doomed to the same failure.
          rebuildPool("flush gave up after repeated transient failures");
          startHeartbeat();
          break;
        }
        await new Promise((r) => setTimeout(r, backoffOverrideMs ?? backoffMs(transientRetries)));
      }
    } finally {
      // Only release the lock if WE still own it — a stall-breaker may have bumped
      // the epoch and installed a fresh flush; clearing here would clobber it.
      if (!cancelled()) flushing = null;
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
  // One global sequence stamps every committed write with a monotonic `rev` so
  // delta-sync can pull "everything changed since my watermark" across all tables.
  await pool!.query(`create sequence if not exists ${REV_SEQ}`);
  for (const name of COLLECTIONS) {
    const t = TABLES[name];
    await pool!.query(
      `create table if not exists "${t}" (id text primary key, data jsonb not null)`
    );
    // Added idempotently so pre-coherence databases upgrade in place. Existing
    // rows get rev 0; the next write to each restamps it from the sequence.
    await pool!.query(`alter table "${t}" add column if not exists rev bigint not null default 0`);
    await pool!.query(`create index if not exists "${t}_rev_idx" on "${t}" (rev)`);
  }
}

async function loadAll(): Promise<void> {
  const fresh = structuredClone(empty);
  legacyPlaintextIds = new Map(); // recomputed below by decodeFromLoad
  revWatermark.clear();
  for (const name of COLLECTIONS) {
    const { rows } = await pool!.query<{ data: unknown; rev: string }>(
      `select data, rev from "${TABLES[name]}"`
    );
    (fresh[name] as unknown[]) = rows.map((r) => decodeFromLoad(name, r.data));
    // Seed the delta-sync watermark to the highest rev present at boot; the
    // poller then only pulls rows committed after this snapshot.
    let max = 0;
    for (const r of rows) {
      const rev = Number(r.rev);
      if (rev > max) max = rev;
    }
    revWatermark.set(name, max);
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
 * `flushWatchdogMs` / `stallThresholdMs` let tests drive the hang/stall paths on
 * a short clock; production uses the defaults.
 */
export async function initDb(opts?: {
  poolOverride?: PgPool;
  poolFactory?: () => PgPool;
  flushWatchdogMs?: number;
  stallThresholdMs?: number;
  backoffMs?: number;
  stallBreakMs?: number;
  stallCheckMs?: number;
  stallEscalateAfter?: number;
  connectTimeoutMs?: number;
}): Promise<void> {
  // Reset health counters so each boot (and each test that re-inits) starts clean.
  consecutiveFlushFailures = 0;
  lastFlushError = null;
  lastFlushErrorAt = null;
  quarantinedRows = 0;
  warnedSealedNoKey = false;
  rowsLoadedAtBoot = 0;
  bootedAt = Date.now();
  flushWatchdogMs = opts?.flushWatchdogMs ?? DEFAULT_FLUSH_WATCHDOG_MS;
  stallThresholdMs = opts?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  // The breaker must NEVER fire for an op the per-op watchdog is still timing —
  // otherwise a merely slow query trips an endless rebuild-and-reflush spiral.
  // Keep stallBreakMs strictly above flushWatchdogMs so it only catches a genuine
  // silent wedge (one the watchdog never resolved).
  stallBreakMs = Math.max(opts?.stallBreakMs ?? DEFAULT_STALL_BREAK_MS, flushWatchdogMs + 1);
  stallCheckOverrideMs = opts?.stallCheckMs ?? null;
  stallEscalateAfter = opts?.stallEscalateAfter ?? DEFAULT_STALL_ESCALATE_AFTER;
  // Cap at the whole-flush watchdog: connect is a subset of persistBatch, which the
  // watchdog already bounds, so a connectTimeoutMs above it would never fire (the
  // watchdog rejects first) — leaving the connect-specific bound dead.
  connectTimeoutMs = Math.min(opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, flushWatchdogMs);
  lastFlushProgressAt = Date.now();
  // Drop any write-through state from a previous run so a re-init (tests, mainly)
  // never inherits a wedged in-flight flush promise, stale timers, or staged rows.
  // At a real boot these are already empty, so this is a harmless no-op there.
  dirty.clear();
  deleted.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  flushEpoch++; // cancel any in-flight flush loop from a prior run (tests re-init)
  flushing = null;
  firstStagedAt = null;
  consecutiveStallBreaks = 0;
  // Coherence poller + stall-breaker + watermarks are per-connection; drop any
  // from a prior run.
  stopCoherence();
  stopStallBreaker();
  revWatermark.clear();
  syncing = false;
  lastSyncAt = 0;
  // Pool-rebuild state — a re-init starts clean.
  realPool = false;
  lastPoolRebuild = 0;
  lastErrorLoggedAt = 0;
  poolFactory = opts?.poolFactory ?? null;
  backoffOverrideMs = opts?.backoffMs ?? null;
  if (opts?.poolFactory) {
    pool = buildPool(); // mints via the factory; rebuildable (exercises self-healing)
    realPool = true;
  } else if (opts?.poolOverride) {
    pool = opts.poolOverride;
  } else if (!config.databaseUrl) {
    console.warn("[db] DATABASE_URL not set — using ephemeral in-memory store (no persistence)");
    state = structuredClone(empty);
    pool = null;
    return;
  } else {
    pool = buildPool();
    realPool = true; // a real DATABASE_URL pool — eligible for self-healing rebuilds
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
  rowsLoadedAtBoot = total;
  // Begin revalidating the cache against Postgres. From here the snapshot is no
  // longer load-once: another instance's committed writes (e.g. the outgoing
  // instance during a zero-downtime deploy) flow in within ~1s.
  startCoherence();
  // Watchdog for a silent write-through wedge (stuck flush, no error).
  startStallBreaker();
  const target = opts?.poolOverride ? "injected test pool" : describeDb(config.databaseUrl);
  console.log(
    `[db] connected [${target}] — loaded ${total} rows across ${COLLECTIONS.length} tables`
  );
}

/** Flush pending writes and close the pool. Call on graceful shutdown. */
export async function shutdownDb(): Promise<void> {
  stopCoherence();
  stopStallBreaker();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await flushPending();
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── row-change notification ──────────────────────────────────────────────────
// A deliberately domain-free "this row was just written" signal. It exists so a
// feature can react to a mutation without every write site having to remember to
// tell it — the live-push fan-out (bounties/live.ts) is the first consumer, and
// db.ts knows nothing about what any listener does with the row.
//
// Emitted from insert() and update() specifically, NOT from stageUpsert() where
// they converge: stageUpsert early-returns in ephemeral mode (no pool), so
// hooking there would silently stop emitting in dev and in every test that runs
// without Postgres. Boot and reconcileAll() stage rows directly and never call
// insert/update, so loading a snapshot cannot fan out thousands of signals.
//
// remove() deliberately does not emit: the only caller is account deletion
// (account.ts), and nothing live-facing is driven by a row disappearing.
//
// Listeners run SYNCHRONOUSLY inside the write, so they must be cheap — do the
// resolution work behind a coalescing window, not here.
export type RowChange = {
  collection: keyof DB;
  kind: "insert" | "update";
  row: unknown;
  // The row as it was BEFORE an update, or null on an insert. Handing this over
  // costs nothing — update() is about to discard the old object anyway — and it
  // lets a listener tell a meaningful change from a no-op rewrite without
  // re-reading or snapshotting anything. Several hot paths rewrite fields no
  // user can see (bot comment ids, single-flight guards, transaction hash
  // rebroadcasts), and without a `prev` every one of them looks identical to a
  // real state transition.
  prev: unknown | null;
};
export type RowChangeListener = (change: RowChange) => void;

const changeListeners = new Set<RowChangeListener>();

/** Subscribe to row writes. Returns an unsubscribe. */
export function onRowChange(fn: RowChangeListener): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

function emitRowChange(change: RowChange): void {
  // Hot path: the keeper writes on a 12s loop and usually nobody is subscribed.
  if (changeListeners.size === 0) return;
  // Copy — a listener may unsubscribe itself while being notified.
  for (const fn of [...changeListeners]) {
    try {
      fn(change);
    } catch (err) {
      // A listener must NEVER be able to fail a write. The row is already in
      // memory and staged for persistence by the time we get here; swallow.
      console.error(`[db] change listener threw for "${String(change.collection)}":`, err);
    }
  }
}

export const db = {
  // Read primitive — return the live array; callers must not mutate without flushing
  table<K extends keyof DB>(name: K): DB[K] {
    return state[name];
  },

  insert<K extends keyof DB>(name: K, row: DB[K][number]) {
    // Stamp the monotonic version the upsert's anti-clobber guard keys off.
    (row as { version?: number }).version = bumpedVersion(row);
    (state[name] as DB[K][number][]).push(row);
    stageUpsert(name, row);
    emitRowChange({ collection: name, kind: "insert", row, prev: null });
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
    // Bump from the pre-update version so a later/concurrent writer with a stale
    // base can't win the upsert and roll this change back.
    const prev = list[idx];
    list[idx] = { ...prev, ...patch, version: bumpedVersion(prev) } as DB[K][number];
    stageUpsert(name, list[idx]);
    emitRowChange({ collection: name, kind: "update", row: list[idx], prev });
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
