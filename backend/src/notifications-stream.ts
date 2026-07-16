// Live push channel for the dashboard bell — the backend→frontend leg that lets
// the dashboard drop its polling loop. Every notification funnels through
// pushNotification() (notifications.ts), which calls notifyUser() here; that
// writes a tiny Server-Sent-Events "changed" signal to the user's open streams,
// and the frontend refetches /api/notifications on receipt.
//
// Single-instance scope: the registry is in-memory, so notifyUser reaches only
// streams held by THIS process. On one steady-state instance that is every
// stream; the only gap is the brief old+new overlap during a zero-downtime
// deploy, which the frontend's slow fallback poll covers. Instant cross-instance
// delivery (a db.ts coherence hook) is a deliberate follow-up — see the plan.
import type { Response } from "express";

// userId → the set of that user's open SSE responses (one per browser tab).
const clients = new Map<string, Set<Response>>();

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
    return true;
  } catch {
    return false;
  }
}

export function addClient(userId: string, res: Response): void {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);
  ensureHeartbeat();
}

// Idempotent — safe to call from both req 'close' and an eviction path.
export function removeClient(userId: string, res: Response): void {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
  if (clients.size === 0) stopHeartbeat();
}

// Push a "notifications changed" signal to every open stream for this user. The
// payload is deliberately minimal: the client only needs to know THAT something
// changed and then refetches, so the stream never mirrors the API's shaping.
export function notifyUser(userId: string): void {
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const frame = `data: {"type":"notifications-changed"}\n\n`;
  for (const res of [...set]) {
    if (!writeFrame(res, frame)) removeClient(userId, res);
  }
}

// One keepalive tick — a comment line to every open stream. Exported so the unit
// test can trigger it deterministically instead of waiting on the interval.
export function heartbeat(): void {
  for (const [userId, set] of [...clients]) {
    for (const res of [...set]) {
      if (!writeFrame(res, `: ping\n\n`)) removeClient(userId, res);
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
  for (const set of clients.values()) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        // already closed — ignore
      }
    }
  }
  clients.clear();
  stopHeartbeat();
}

// Total registered connections. For tests/introspection only.
export function activeStreamCount(): number {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}
