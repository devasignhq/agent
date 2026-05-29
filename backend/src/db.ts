// Tiny JSON store. Stand-in for Firestore in dev. Writes are flushed to disk
// (debounced) so the server can restart without losing state.
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { config } from "./config.js";
import type { DB } from "./types.js";

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
};

// One-shot migration on load: assign an id (and createdAt) to any
// TaskAttachment that was persisted before the `id` field existed. Without
// this, the frontend's constraint X-click can't address the attachment by
// id and falls back to a client-only hide path. Idempotent — rows that
// already have an id are untouched. Returns true when something changed.
function backfillAttachmentIds(state: DB): boolean {
  let mutated = false;
  for (const task of state.tasks || []) {
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

function load(): DB {
  if (!config.dbPath) return structuredClone(empty);
  try {
    const raw = fs.readFileSync(config.dbPath, "utf8");
    const parsed = JSON.parse(raw);
    const merged = { ...empty, ...parsed } as DB;
    if (backfillAttachmentIds(merged)) {
      // Persist the migrated snapshot synchronously so re-reads (or another
      // process) see the rewritten ids without waiting on the debounced flush.
      try {
        fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
        fs.writeFileSync(config.dbPath, JSON.stringify(merged, null, 2));
        console.log("[db] migrated attachment ids");
      } catch (err) {
        console.warn("[db] could not write back attachment-id migration:", err);
      }
    }
    return merged;
  } catch {
    return structuredClone(empty);
  }
}

const state: DB = load();

let saveTimer: NodeJS.Timeout | null = null;
function flush() {
  if (!config.dbPath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.writeFileSync(config.dbPath, JSON.stringify(state, null, 2));
  }, 150);
}

export const db = {
  // Read primitive — return the live array; callers must not mutate without flushing
  table<K extends keyof DB>(name: K): DB[K] {
    return state[name];
  },

  insert<K extends keyof DB>(name: K, row: DB[K][number]) {
    (state[name] as DB[K][number][]).push(row);
    flush();
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
    flush();
    return list[idx];
  },

  remove<K extends keyof DB>(name: K, predicate: (row: DB[K][number]) => boolean) {
    const list = state[name] as DB[K][number][];
    const before = list.length;
    const kept = list.filter((r) => !predicate(r));
    state[name] = kept as any;
    flush();
    return before - kept.length;
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
