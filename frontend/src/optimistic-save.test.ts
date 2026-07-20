// Unit tests for the durability-aware optimistic-save state machine
// (optimistic-save.ts), shared by the Workflow screen and the bounty funding page.
// These lock down the behaviour added for transient `not_durable` 503s: keep the
// optimistic state + show a "queued" notice + re-confirm once, the monotonic
// saveSeq supersession guard, the unchanged hard-failure revert path, and the two
// maintainer-feedback edge cases: a repo switch mid-save must not bleed into the
// new repo's UI (criterion 7), and a re-confirm that also 503s must leave the
// 'queued' state rather than spin forever (criterion 8).
//
// No DOM / React needed — runSave takes plain dependency callbacks. Run with:
//   node --test src/optimistic-save.test.ts        (Node >=22 strips the types)
//   npm test                                     (globs all src/**/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSave,
  isTransientNotDurable,
  saveErrorMessage,
  RETRY_DELAY_MS,
} from "./optimistic-save.ts";

// A workflow distinct from the harness's `prev`, so a deep-equality check on the
// recorded setValue calls can tell an optimistic paint apart from a revert.
const NEXT: any = {
  version: 1,
  trigger: { onSynchronize: false, skipDrafts: true, skipBots: true },
  stages: { holistic: false, docs: true, deferrals: false },
  verdict: { blocking: false },
};

function baseWf(): any {
  return {
    version: 1,
    trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
    stages: { holistic: true, docs: true, deferrals: true },
    verdict: { blocking: true },
  };
}

function transientError(): any {
  return Object.assign(new Error("not_durable"), {
    status: 503,
    body: { error: "not_durable", message: "write not yet persisted — please retry" },
  });
}

// Builds runSave deps backed by call recorders. `persist(callNo)` decides each
// attempt's outcome (throw to reject); `scheduleRetry` captures the re-confirm
// callback instead of arming a real timer so tests drive it synchronously.
function makeHarness(overrides: any = {}) {
  const calls = { setValue: [] as any[], setErr: [] as any[], setPending: [] as boolean[] };
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let persistCalls = 0;
  const prev = "prev" in overrides ? overrides.prev : baseWf();
  const deps = {
    scopeId: "scope-1",
    getPrev: () => prev,
    persist: async (id: string, n: any) => {
      persistCalls++;
      return overrides.persist ? overrides.persist(persistCalls, id, n) : { ok: true };
    },
    setValue: (wf: any) => calls.setValue.push(wf),
    setErr: (m: any) => calls.setErr.push(m),
    setPending: (p: boolean) => calls.setPending.push(p),
    seqRef: overrides.seqRef ?? { current: 0 },
    retryTimer: { current: null as any },
    scheduleRetry: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length as any;
    },
    retryDelayMs: overrides.retryDelayMs,
    ...(overrides.deps || {}),
  };
  return { deps, calls, scheduled, prev, persistCount: () => persistCalls };
}

// Let a fired re-confirm's async chain settle (it isn't returned by scheduleRetry).
const flush = () => new Promise((r) => setTimeout(r, 0));

test("transient not_durable: keeps optimistic state, shows pending, schedules ONE retry", async () => {
  const h = makeHarness({ persist: () => { throw transientError(); } });
  await runSave(h.deps, NEXT);

  assert.deepEqual(h.calls.setValue, [NEXT], "only the optimistic paint — must NOT revert");
  assert.deepEqual(h.calls.setErr, [null], "no hard error surfaced");
  assert.deepEqual(h.calls.setPending, [true], "calm 'queued' notice shown");
  assert.equal(h.scheduled.length, 1, "exactly one re-confirm scheduled");
  assert.equal(h.scheduled[0].ms, RETRY_DELAY_MS, "scheduled at the configured delay");
});

test("hard failure: reverts to prev and surfaces the backend's friendly message", async () => {
  const err = Object.assign(new Error("server_boom"), {
    status: 500,
    body: { error: "server_boom", message: "Something went wrong on our end." },
  });
  const h = makeHarness({ persist: () => { throw err; } });
  await runSave(h.deps, NEXT);

  assert.deepEqual(h.calls.setValue, [NEXT, h.prev], "optimistic paint, then revert to prev");
  assert.deepEqual(h.calls.setPending, [false], "pending cleared on a hard failure");
  assert.equal(h.calls.setErr.at(-1), "Something went wrong on our end.", "friendly message, not the raw code");
  assert.equal(h.scheduled.length, 0, "no retry for a non-transient error");
});

test("upgrade_required: tailored Pro/Max copy and revert", async () => {
  const err = Object.assign(new Error("upgrade_required"), {
    status: 403,
    body: { error: "upgrade_required" },
  });
  const h = makeHarness({ persist: () => { throw err; } });
  await runSave(h.deps, NEXT);

  assert.deepEqual(h.calls.setValue, [NEXT, h.prev]);
  assert.equal(h.calls.setErr.at(-1), "That control is a Pro/Max feature.");
});

test("happy path: confirms durable, no revert, no notice, no retry", async () => {
  const h = makeHarness({ persist: () => ({ ok: true }) });
  await runSave(h.deps, NEXT);

  assert.deepEqual(h.calls.setValue, [NEXT], "no revert");
  assert.deepEqual(h.calls.setErr, [null]);
  assert.deepEqual(h.calls.setPending, [false], "confirmed durable");
  assert.equal(h.scheduled.length, 0);
});

test("supersession: a newer save makes the stale in-flight save no-op when it settles", async () => {
  let reject!: (e: any) => void;
  const inflight = new Promise((_res, rej) => { reject = rej; });
  const seqRef = { current: 0 };
  const h = makeHarness({ seqRef, persist: () => inflight });

  const run = runSave(h.deps, NEXT); // claims seq = 1, then awaits persist
  seqRef.current = 5;                // a newer save claims latest
  reject(transientError());          // the stale attempt now fails
  await run;

  assert.deepEqual(h.calls.setValue, [NEXT], "stale save must NOT revert");
  assert.deepEqual(h.calls.setPending, [], "stale save toggles no pending/durable state");
  assert.deepEqual(h.calls.setErr, [null], "stale save surfaces no error");
  assert.equal(h.scheduled.length, 0, "stale save schedules no retry");
});

test("criterion 8 — a re-confirm that still 503s leaves 'queued' (not stuck) with a background note", async () => {
  const h = makeHarness({ persist: () => { throw transientError(); } });
  await runSave(h.deps, NEXT, true); // this call IS the re-confirm (isRetry = true)

  assert.deepEqual(h.calls.setPending, [false], "clears the 'queued' spinner — must not stay stuck");
  assert.match(String(h.calls.setErr.at(-1)), /saving in the background/i, "calm terminal note");
  assert.deepEqual(h.calls.setValue, [NEXT], "optimistic state kept — no revert");
  assert.equal(h.scheduled.length, 0, "a retry never schedules another retry");
});

test("scheduled re-confirm runs and clears the notice once durable", async () => {
  const h = makeHarness({ persist: (n: number) => { if (n === 1) throw transientError(); return { ok: true }; } });
  await runSave(h.deps, NEXT);
  assert.equal(h.scheduled.length, 1);
  assert.deepEqual(h.calls.setPending, [true]);

  h.scheduled[0].fn(); // fire the re-confirm
  await flush();

  assert.equal(h.persistCount(), 2, "re-confirm persisted again");
  assert.deepEqual(h.calls.setPending, [true, false], "notice cleared after the retry confirmed durable");
  assert.deepEqual(h.calls.setValue, [NEXT, NEXT], "no revert across the retry");
});

test("scheduled re-confirm is suppressed if a newer save superseded it", async () => {
  const seqRef = { current: 0 };
  const h = makeHarness({ seqRef, persist: () => { throw transientError(); } });
  await runSave(h.deps, NEXT);          // claims seq = 1, schedules retry
  assert.equal(h.scheduled.length, 1);

  seqRef.current = 9;                    // a newer save superseded
  h.scheduled[0].fn();                   // the stale timer fires
  await flush();

  assert.equal(h.persistCount(), 1, "superseded re-confirm did not persist again");
});

// `active` must START equal to deps.scopeId, or the save was never current and
// these would pass for the wrong reason — proving nothing about the switch.
test("criterion 7 — a stale FAILED save does not touch the new target's UI after a switch", async () => {
  let reject!: (e: any) => void;
  const inflight = new Promise((_res, rej) => { reject = rej; });
  let active = "scope-1";
  const h = makeHarness({
    deps: { scopeId: "scope-1", activeScopeId: () => active },
    persist: () => inflight,
  });

  const run = runSave(h.deps, NEXT); // targets scope-1, then awaits persist
  active = "scope-2";                // user switches target mid-flight
  reject(transientError());          // the stale attempt now fails
  await run;

  assert.deepEqual(h.calls.setValue, [NEXT], "no revert bled into scope-2");
  assert.deepEqual(h.calls.setPending, [], "no 'queued' notice on scope-2");
  assert.deepEqual(h.calls.setErr, [null], "no stale error on scope-2");
  assert.equal(h.scheduled.length, 0, "no retry scheduled for the abandoned scope-1");
});

test("criterion 7 — a stale SUCCEEDED save does not clear the new target's notice after a switch", async () => {
  let resolve!: (v: any) => void;
  const inflight = new Promise((res) => { resolve = res; });
  let active = "scope-1";
  const h = makeHarness({
    deps: { scopeId: "scope-1", activeScopeId: () => active },
    persist: () => inflight,
  });

  const run = runSave(h.deps, NEXT);
  active = "scope-2";                // switched away before persist resolved
  resolve({ ok: true });
  await run;

  assert.deepEqual(h.calls.setPending, [], "did not flip pending on scope-2");
});

test("no target selected: does nothing", async () => {
  const h = makeHarness({ deps: { scopeId: "" } });
  await runSave(h.deps, NEXT);

  assert.deepEqual(h.calls.setValue, []);
  assert.equal(h.persistCount(), 0);
});

test("helpers: isTransientNotDurable + saveErrorMessage", () => {
  assert.equal(isTransientNotDurable({ status: 503, body: { error: "not_durable" } }), true);
  assert.equal(isTransientNotDurable({ status: 503, body: { error: "boom" } }), false, "wrong code is not transient");
  assert.equal(isTransientNotDurable({ status: 500, body: { error: "not_durable" } }), false, "wrong status is not transient");
  assert.equal(isTransientNotDurable(new Error("x")), false);

  assert.equal(saveErrorMessage({ message: "upgrade_required" }), "That control is a Pro/Max feature.");
  assert.equal(saveErrorMessage({ body: { message: "Friendly" }, message: "raw_code" }), "Friendly", "prefers body.message over the code");
  assert.equal(saveErrorMessage({ message: "raw_code" }), "raw_code");
  assert.equal(saveErrorMessage({}), "Couldn't save — reverted.");
});
