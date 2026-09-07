// Offline: the shared worker pool. Three call sites depend on it (index summaries,
// the security audit, and ingest's video summaries), so its bounds and error
// isolation are load-bearing.
//   DATABASE_URL= node --import tsx/esm --test src/review/run-pool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "./indexer.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("never exceeds the concurrency bound, and still processes every item", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const done: number[] = [];
  let inFlight = 0;
  let peak = 0;
  await runPool(items, 3, async (i) => {
    peak = Math.max(peak, ++inFlight);
    await tick();
    inFlight--;
    done.push(i);
  });
  assert.equal(peak, 3, "a rate-limited API must not see more than the bound");
  assert.deepEqual(done.sort((a, b) => a - b), items);
});

test("one failing item does not sink the batch", async () => {
  const done: number[] = [];
  await runPool([1, 2, 3], 2, async (i) => {
    if (i === 2) throw new Error("boom");
    done.push(i);
  });
  assert.deepEqual(done.sort(), [1, 3], "a single bad video or file cannot lose the rest");
});

test("an empty list does no work and resolves", async () => {
  let called = false;
  await runPool([], 4, async () => { called = true; });
  assert.equal(called, false);
});

test("concurrency above the item count spawns no idle workers", async () => {
  let peak = 0;
  let inFlight = 0;
  await runPool([1, 2], 10, async () => {
    peak = Math.max(peak, ++inFlight);
    await tick();
    inFlight--;
  });
  assert.equal(peak, 2);
});
