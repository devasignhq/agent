// Offline: the resolve poll loop — when it stops waiting, and how it hands the
// wait back to the server so a late plan can re-dispatch CI.
//   node --import tsx/esm --test src/resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_SERVER_DEADLINE_MS, resolvePlan, serverDeadline } from "./run.js";
import type { ResolveRequest, ResolveResponse } from "./types.js";

const ctx = {
  cwd: ".", onActions: true, repo: "acme/widgets", event: "pull_request",
  pr: 7, sha: "c".repeat(40), runId: "1", runAttempt: 1, runnerOs: "Linux",
} as const;

const setup = { languages: ["ts"], frameworks: [], testCommands: [], services: [], envExampleVars: [] } as any;

/** An API that answers `pending` forever, recording every request it saw. */
function pendingApi(pending: Partial<ResolveResponse & { giveUpAfterMs: number }> = {}) {
  const seen: ResolveRequest[] = [];
  const api = {
    resolve: async (body: ResolveRequest): Promise<ResolveResponse> => {
      seen.push(body);
      return { ok: true, status: "pending", runId: null, retryAfterMs: 2_000, ...pending } as ResolveResponse;
    },
  } as any;
  return { api, seen };
}

test("gives up after the timeout, and its last poll tells the server so", async () => {
  const { api, seen } = pendingApi();
  const res = await resolvePlan(api, ctx as any, setup, 2_500);
  assert.equal(res.status, "pending");
  assert.ok(seen.length >= 2, "polls at least once more before quitting");
  assert.equal(seen[seen.length - 1].giveUp, true, "the final poll is flagged");
  assert.ok(seen.slice(0, -1).every((r) => !r.giveUp), "no earlier poll claims to be the last");
});

test("the setup payload rides only on the first poll", async () => {
  const { api, seen } = pendingApi();
  await resolvePlan(api, ctx as any, setup, 2_500);
  assert.ok(seen[0].setup, "first poll carries the detected setup");
  assert.ok(seen.slice(1).every((r) => r.setup === undefined), "later polls stay small");
});

test("a server give-up hint shortens the wait, but can never extend it", () => {
  const t0 = 1_000_000;
  const caller = t0 + 600_000;
  assert.equal(serverDeadline(caller, t0, 120_000), t0 + 120_000, "a shorter server hint wins");
  assert.equal(serverDeadline(caller, t0, 900_000), caller, "a longer one cannot pin the job open");
  assert.equal(serverDeadline(t0 + 10_000, t0, 120_000), t0 + 10_000, "a short caller timeout still wins");
  // Below the floor the hint would make CI churn faster than a plan can ever land.
  assert.equal(serverDeadline(caller, t0, 1_000), t0 + MIN_SERVER_DEADLINE_MS);
  for (const bad of [undefined, 0, -5, NaN]) {
    assert.equal(serverDeadline(caller, t0, bad as number | undefined), caller, `ignores ${bad}`);
  }
});

test("a plan that arrives mid-wait returns immediately and is never flagged as a give-up", async () => {
  let n = 0;
  const seen: ResolveRequest[] = [];
  const api = {
    resolve: async (body: ResolveRequest): Promise<ResolveResponse> => {
      seen.push(body);
      if (++n < 2) return { ok: true, status: "pending", runId: "r", retryAfterMs: 2_000 };
      return { ok: true, status: "ready", runId: "r", plan: { planId: "p" } as any };
    },
  } as any;
  const res = await resolvePlan(api, ctx as any, setup, 60_000);
  assert.equal(res.status, "ready");
  assert.ok(seen.every((r) => !r.giveUp));
});
