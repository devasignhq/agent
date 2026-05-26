// Tiny JSON store. Stand-in for Firestore in dev. Writes are flushed to disk
// (debounced) so the server can restart without losing state.
import fs from "node:fs";
import path from "node:path";
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
};

function load(): DB {
  if (!config.dbPath) return structuredClone(empty);
  try {
    const raw = fs.readFileSync(config.dbPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...empty, ...parsed };
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
