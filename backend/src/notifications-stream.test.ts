// Unit tests for the SSE connection registry (notifications-stream.ts): who a
// change signal reaches, keepalive frames, eviction of a dead socket, and the
// graceful-shutdown teardown. No HTTP — a plain fake Response records the bytes
// written. The registry is module-level shared state, so every test calls
// closeAllStreams() first to isolate.
// Run: node --import tsx/esm --test src/notifications-stream.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import {
  addClient,
  removeClient,
  notifyUser,
  notifyGithubId,
  notifyAudience,
  hasClients,
  heartbeat,
  closeAllStreams,
  activeStreamCount,
} from "./notifications-stream.js";
import { withRequestContext } from "./request-context.js";

// Minimal Response stub: records every written frame, can be made to throw on
// write (a dead socket), and flags when it's ended.
function fakeRes() {
  const r: any = {
    writes: [] as string[],
    ended: false,
    throwOnWrite: false,
    write(s: string) {
      if (r.throwOnWrite) throw new Error("EPIPE");
      r.writes.push(s);
      return true;
    },
    end() {
      r.ended = true;
    },
  };
  return r as Response & { writes: string[]; ended: boolean; throwOnWrite: boolean };
}

const frame = (type: string) => `data: ${JSON.stringify({ type })}\n\n`;
const DATA = frame("notifications-changed");
const PING = `: ping\n\n`;

test("notifyUser pushes the change signal to every stream of that user only", () => {
  closeAllStreams();
  const a1 = fakeRes();
  const a2 = fakeRes();
  const b1 = fakeRes();
  addClient("user-a", a1);
  addClient("user-a", a2);
  addClient("user-b", b1);
  assert.equal(activeStreamCount(), 3);

  notifyUser("user-a");
  assert.equal(a1.writes.at(-1), DATA);
  assert.equal(a2.writes.at(-1), DATA);
  assert.equal(b1.writes.includes(DATA), false);

  closeAllStreams();
});

test("removeClient stops delivery and updates the count", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u", r);
  assert.equal(activeStreamCount(), 1);
  removeClient("u", r);
  assert.equal(activeStreamCount(), 0);
  notifyUser("u"); // no registered stream — no delivery, no throw
  assert.equal(r.writes.length, 0);
  closeAllStreams();
});

test("heartbeat writes a comment keepalive to every stream", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u", r);
  heartbeat();
  assert.equal(r.writes.at(-1), PING);
  closeAllStreams();
});

test("a stream whose write throws is evicted; the others keep receiving", () => {
  closeAllStreams();
  const dead = fakeRes();
  const live = fakeRes();
  addClient("u", dead);
  addClient("u", live);
  dead.throwOnWrite = true;

  notifyUser("u");
  assert.equal(activeStreamCount(), 1); // dead was evicted
  assert.equal(live.writes.at(-1), DATA); // live still delivered
  closeAllStreams();
});

test("closeAllStreams ends every connection and clears the registry", () => {
  closeAllStreams();
  const a = fakeRes();
  const b = fakeRes();
  addClient("x", a);
  addClient("y", b);

  closeAllStreams();
  assert.equal(a.ended, true);
  assert.equal(b.ended, true);
  assert.equal(activeStreamCount(), 0);
});

// ── dual-key addressing ─────────────────────────────────────────────────────
// A bounty knows its assignee and applicants by githubId only, so the registry
// has to be reachable by that identity without a users-table scan.

test("a stream registered with a githubId is reachable by EITHER identity", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u1", r, { githubId: 4242 });

  notifyUser("u1", "bounties-changed");
  assert.equal(r.writes.at(-1), frame("bounties-changed"));

  notifyGithubId(4242, "wallet-changed");
  assert.equal(r.writes.at(-1), frame("wallet-changed"));
  closeAllStreams();
});

test("notifyGithubId reaches only that account's streams", () => {
  closeAllStreams();
  const mine = fakeRes();
  const theirs = fakeRes();
  const anon = fakeRes();
  addClient("u1", mine, { githubId: 1 });
  addClient("u2", theirs, { githubId: 2 });
  addClient("u3", anon); // no linked GitHub account

  notifyGithubId(1, "bounties-changed");
  assert.equal(mine.writes.length, 1);
  assert.equal(theirs.writes.length, 0);
  assert.equal(anon.writes.length, 0);
  closeAllStreams();
});

test("removeClient clears BOTH indexes, so no delivery survives by githubId", () => {
  closeAllStreams();
  const r = fakeRes();
  addClient("u1", r, { githubId: 77 });
  removeClient("u1", r);
  assert.equal(activeStreamCount(), 0);

  notifyGithubId(77, "bounties-changed");
  assert.equal(r.writes.length, 0, "a stale githubId index entry would deliver here");
  closeAllStreams();
});

test("notifyAudience delivers at most once to a connection named by both identities", () => {
  closeAllStreams();
  const both = fakeRes(); // the same person as sponsor (userId) and assignee (githubId)
  const other = fakeRes();
  addClient("u1", both, { githubId: 9 });
  addClient("u2", other, { githubId: 10 });

  notifyAudience({ userIds: ["u1"], githubIds: [9, 10] }, "bounties-changed");
  assert.equal(both.writes.length, 1, "must not double-write");
  assert.equal(other.writes.length, 1);
  closeAllStreams();
});

test("hasClients reports whether any resolution work is worth doing", () => {
  closeAllStreams();
  assert.equal(hasClients(), false);
  const r = fakeRes();
  addClient("u1", r);
  assert.equal(hasClients(), true);
  removeClient("u1", r);
  assert.equal(hasClients(), false);
});

// ── actor exclusion ─────────────────────────────────────────────────────────
// The tab that caused a write already refetches on its own; pushing back to it
// would only buy a second, redundant fetch.

test("a write from a tab skips that tab but still reaches the user's others", () => {
  closeAllStreams();
  const acting = fakeRes();
  const otherTab = fakeRes();
  const otherUser = fakeRes();
  addClient("u1", acting, { githubId: 5, tabId: "tab-A" });
  addClient("u1", otherTab, { githubId: 5, tabId: "tab-B" });
  addClient("u2", otherUser, { githubId: 6, tabId: "tab-C" });

  withRequestContext({ tabId: "tab-A" }, () => {
    notifyUser("u1", "bounties-changed");
    notifyGithubId(6, "bounties-changed");
  });

  assert.equal(acting.writes.length, 0, "the acting tab must be skipped");
  assert.equal(otherTab.writes.length, 1, "the same user's other tab still updates");
  assert.equal(otherUser.writes.length, 1);
  closeAllStreams();
});

test("outside a request scope nobody is excluded — the background-job case", () => {
  closeAllStreams();
  const a = fakeRes();
  const b = fakeRes();
  addClient("u1", a, { tabId: "tab-A" });
  addClient("u1", b, { tabId: "tab-B" });

  notifyUser("u1", "bounties-changed"); // the keeper: no request, no acting tab

  assert.equal(a.writes.length, 1);
  assert.equal(b.writes.length, 1);
  closeAllStreams();
});

test("a stream with no tab id is never excluded", () => {
  closeAllStreams();
  const legacy = fakeRes();
  addClient("u1", legacy); // predates the tab-id plumbing

  withRequestContext({ tabId: "tab-A" }, () => notifyUser("u1", "bounties-changed"));

  assert.equal(legacy.writes.length, 1);
  closeAllStreams();
});
