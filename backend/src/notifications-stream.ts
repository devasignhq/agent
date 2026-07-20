// Live push channel for the browser apps — the backend→frontend leg that lets
// them drop their polling loops. A tiny Server-Sent-Events "changed" signal goes
// out on every state move a user cares about, and the client refetches through
// the normal REST endpoint. The frame is a SIGNAL, not a payload: it never
// mirrors the API's shaping or its authorization, so the refetch re-checks both.
//
// Two identities index the same connection. Notifications are addressed by
// userId, but a bounty knows its applicants by githubId only (applications carry
// no userId — see types.ts), so pushing to them used to need a linear scan of
// the users table on the keeper's 12s loop. Registering under both keys makes
// either fan-out a direct Map lookup with no DB work.
//
// Single-instance scope: the registry is in-memory, so a push reaches only
// streams held by THIS process. On one steady-state instance that is every
// stream; the only gap is the brief old+new overlap during a zero-downtime
// deploy, which the frontend's slow fallback poll covers. Instant cross-instance
// delivery (Postgres LISTEN/NOTIFY, or the db.ts delta-sync seam) is a
// deliberate follow-up — see the plan.
import type { Response } from "express";
import { currentTabId } from "./request-context.js";

// One open SSE connection: the socket plus the identities it can be addressed by.
type Client = {
  res: Response;
  userId: string;
  githubId: number | null;
  // Which browser tab this stream belongs to, so a write caused BY that tab can
  // skip it — the tab already refetches explicitly and doesn't need a nudge.
  // null for a client that predates the tab-id plumbing; such a stream is simply
  // never excluded.
  tabId: string | null;
};

// The two indexes over the same Client objects. Every client in byGithubId is
// also in byUser; the reverse only holds for users with a linked GitHub account.
const byUser = new Map<string, Set<Client>>();
const byGithubId = new Map<number, Set<Client>>();

// Comment-line keepalive cadence. Idle SSE connections get reaped by proxies /
// Render without periodic bytes, and a heartbeat also surfaces a dead socket
// (the write throws) so we can evict it.
const HEARTBEAT_MS = 25_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

// Write one raw SSE frame. Returns false when the socket is already dead (write
// throws) so the caller can evict it. A `false` return from res.write itself is
// just backpressure (buffer full but still queued) — not an error.
function writeFrame(res: Response, frame: string): boolean {
  try {
    res.write(frame);
    // No compression middleware is mounted today (SSE would otherwise buffer),
    // but if one is ever added it decorates res with flush() — call it so frames
    // still reach the client immediately. A no-op when absent.
    (res as { flush?: () => void }).flush?.();
    return true;
  } catch {
    return false;
  }
}

function addTo<K>(index: Map<K, Set<Client>>, key: K, client: Client): void {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(client);
}

function removeFrom<K>(index: Map<K, Set<Client>>, key: K, client: Client): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) index.delete(key);
}

export function addClient(
  userId: string,
  res: Response,
  opts: { githubId?: number | null; tabId?: string | null } = {}
): void {
  const client: Client = {
    res,
    userId,
    githubId: opts.githubId ?? null,
    tabId: opts.tabId ?? null,
  };
  addTo(byUser, userId, client);
  if (client.githubId !== null) addTo(byGithubId, client.githubId, client);
  ensureHeartbeat();
}

// Idempotent — safe to call from both req 'close' and an eviction path.
export function removeClient(userId: string, res: Response): void {
  const set = byUser.get(userId);
  if (!set) return;
  for (const client of [...set]) {
    if (client.res !== res) continue;
    removeFrom(byUser, userId, client);
    if (client.githubId !== null) removeFrom(byGithubId, client.githubId, client);
  }
  if (byUser.size === 0) stopHeartbeat();
}

// True when nobody at all is listening. The change emitter checks this before
// doing any recipient resolution, so a write with no watchers costs nothing.
export function hasClients(): boolean {
  return byUser.size > 0;
}

function frameFor(type: string): string {
  return `data: ${JSON.stringify({ type })}\n\n`;
}

// Deliver to a set of clients, skipping the tab that caused the write (if this
// is running inside a request) and evicting any socket that turns out to be dead.
function deliver(clients: Iterable<Client>, frame: string): void {
  const actingTab = currentTabId();
  for (const client of [...clients]) {
    // The acting tab refetches explicitly right after its own mutation; pushing
    // to it as well would just buy a second, redundant fetch. Every OTHER tab —
    // including the same user's other tabs — still gets the frame.
    if (actingTab !== null && client.tabId === actingTab) continue;
    if (!writeFrame(client.res, frame)) removeClient(client.userId, client.res);
  }
}

// Push a "something changed" signal to every open stream for this user.
//
// `type` tells the client WHICH slice moved so it can refetch just that one. The
// default keeps every pre-existing caller emitting exactly the frame it did
// before. Clients that don't parse the type refresh on any frame regardless, so
// adding a type is safe to deploy in either order.
export function notifyUser(userId: string, type: string = "notifications-changed"): void {
  const set = byUser.get(userId);
  if (!set || set.size === 0) return;
  deliver(set, frameFor(type));
}

// Same, addressed by GitHub account instead — the identity a bounty carries for
// its assignee and applicants.
export function notifyGithubId(githubId: number, type: string): void {
  const set = byGithubId.get(githubId);
  if (!set || set.size === 0) return;
  deliver(set, frameFor(type));
}

// Fan a single frame out to a mixed audience, delivering AT MOST ONCE per open
// connection even when the same person is named by both identities (an assignee
// resolved by githubId who is also the sponsor by userId, say).
export function notifyAudience(
  audience: { userIds?: Iterable<string>; githubIds?: Iterable<number> },
  type: string
): void {
  const targets = new Set<Client>();
  for (const id of audience.userIds ?? []) {
    for (const c of byUser.get(id) ?? []) targets.add(c);
  }
  for (const id of audience.githubIds ?? []) {
    for (const c of byGithubId.get(id) ?? []) targets.add(c);
  }
  if (targets.size === 0) return;
  deliver(targets, frameFor(type));
}

// One keepalive tick — a comment line to every open stream. Exported so the unit
// test can trigger it deterministically instead of waiting on the interval.
export function heartbeat(): void {
  for (const [userId, set] of [...byUser]) {
    for (const client of [...set]) {
      if (!writeFrame(client.res, `: ping\n\n`)) removeClient(userId, client.res);
    }
  }
}

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  // Never let the keepalive hold the process open on shutdown.
  heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// End every open stream cleanly on graceful shutdown so clients receive a FIN and
// reconnect to the next instance, rather than being cut mid-write by process.exit.
export function closeAllStreams(): void {
  // Snapshot both levels: res.end() can synchronously drive the req 'close'
  // handler → removeClient, mutating these collections mid-iteration.
  for (const set of [...byUser.values()]) {
    for (const client of [...set]) {
      try {
        client.res.end();
      } catch {
        // already closed — ignore
      }
    }
  }
  byUser.clear();
  byGithubId.clear();
  stopHeartbeat();
}

// Total registered connections. For tests/introspection only.
export function activeStreamCount(): number {
  let n = 0;
  for (const set of byUser.values()) n += set.size;
  return n;
}
