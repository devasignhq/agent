// Pure tests for the thread reconciler's planner. No db / network / LLM — the
// whole point of splitting planReconciliation out of reconcileThreads is that
// every rule below is decidable offline. Run:
//   node --import tsx/esm --test src/review/threads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines } from "./anchor.js";
import { formatThreadBody } from "./comment.js";
import { buildReviewItems, type ReviewItem, type ReviewStage } from "./items.js";
import { bodyHash, planReconciliation, type ThreadOp } from "./threads.js";
import { EMPTY_HOLISTIC, type HolisticFinding } from "./verdict-types.js";
import type { PriorVerdict } from "./criteria-format.js";
import type { Criterion, ReviewThread } from "../types.js";

const SHA_OLD = "a1b2c3d0000000";
const SHA_NEW = "9f2c1abdeadbee";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@",
  " ctx",
  "+added",
  "+more",
  " tail",
].join("\n");
const INDEX = commentableLines(DIFF);

const ALL_STAGES = new Set<ReviewStage>([
  "criteria",
  "holistic",
  "security",
  "defects",
  "deferrals",
  "docs",
  "commitIntent",
  "crossRepo",
]);

const ATTRIBUTION = {
  kind: "commit" as const,
  sha: SHA_NEW,
  url: `https://gh/c/${SHA_NEW}`,
  message: "Await the flush",
};

const finding = (over: Partial<HolisticFinding> = {}): HolisticFinding => ({
  path: "src/a.ts",
  line: 11,
  concern: "Missing await on flush().",
  severity: "blocker",
  ...over,
});

const items = (over: Partial<Parameters<typeof buildReviewItems>[0]> = {}): ReviewItem[] =>
  buildReviewItems({
    criteria: [],
    prior: new Map<string, PriorVerdict>(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
    ...over,
  });

const defectItems = (over: Partial<HolisticFinding> = {}) =>
  items({ holistic: { ...EMPTY_HOLISTIC, defects: [finding(over)] } });

// A thread as it would have been persisted after a run that reported `item`.
const threadFor = (item: ReviewItem, over: Partial<ReviewThread> = {}): ReviewThread => ({
  key: item.key,
  commentId: 500,
  state: "open",
  itemState: item.state,
  title: item.title,
  category: item.category,
  severity: item.severity,
  stage: item.stage,
  path: item.path,
  line: item.line,
  anchor: "line",
  firstSeenSha: SHA_OLD,
  lastSeenSha: SHA_OLD,
  missCount: 0,
  bodyHash: bodyHash(formatThreadBody(item)),
  updatedAt: 1,
  ...over,
});

const plan = (over: Partial<Parameters<typeof planReconciliation>[0]> = {}) =>
  planReconciliation({
    items: [],
    threads: [],
    index: INDEX,
    headSha: SHA_NEW,
    stagesRun: ALL_STAGES,
    attribution: ATTRIBUTION,
    commitUrl: (sha) => `https://gh/c/${sha}`,
    ...over,
  });

const opsOf = (ops: ThreadOp[], kind: ThreadOp["op"]) => ops.filter((o) => o.op === kind);

// ─── the happy lifecycle ───────────────────────────────────────────────────

test("a brand-new item opens a thread anchored to its line", () => {
  const [item] = defectItems();
  const p = plan({ items: [item] });
  const creates = opsOf(p.ops, "create");
  assert.equal(creates.length, 1);
  const create = creates[0] as Extract<ThreadOp, { op: "create" }>;
  assert.deepEqual(create.anchor, { kind: "line", path: "src/a.ts", line: 11, side: "RIGHT" });
  assert.match(create.body, /Missing await on flush/);
  assert.equal(p.fixedCount, 0);
});

test("an unchanged item costs no API call — the body hash suppresses the PATCH", () => {
  const [item] = defectItems();
  const p = plan({ items: [item], threads: [threadFor(item)] });
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.changed, false);
  assert.equal(opsOf(p.ops, "create").length, 0);
});

test("a reworded item with the same key edits its existing thread in place", () => {
  const [before] = defectItems();
  const [after] = defectItems({ failureScenario: "Two writers land in the same tick." });
  const p = plan({ items: [after], threads: [threadFor(before)] });
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.changed, true);
  assert.match(update.body, /How it fails/);
  assert.equal(opsOf(p.ops, "create").length, 0);
});

test("an item that stops being reported is marked fixed and counted", () => {
  const [item] = defectItems();
  const p = plan({ items: [], threads: [threadFor(item)] });
  const resolves = opsOf(p.ops, "resolve") as Extract<ThreadOp, { op: "resolve" }>[];
  assert.equal(resolves.length, 1);
  assert.deepEqual(resolves[0].attribution, ATTRIBUTION);
  assert.equal(p.fixedCount, 1);
});

test("a fixed item that comes back reopens its own thread rather than opening a second", () => {
  const [item] = defectItems();
  const resolvedThread = threadFor(item, { state: "resolved", resolvedAtSha: SHA_OLD, missCount: 1 });
  const p = plan({ items: [item], threads: [resolvedThread] });
  assert.equal(opsOf(p.ops, "create").length, 0);
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.changed, true);
  assert.match(update.body, /\*\*Reopened\*\*/);
});

test("an already-resolved thread is left alone, not re-resolved every run", () => {
  const [item] = defectItems();
  const p = plan({ items: [], threads: [threadFor(item, { state: "resolved" })] });
  assert.equal(opsOf(p.ops, "resolve").length, 0);
  assert.equal(opsOf(p.ops, "carry").length, 1);
  assert.equal(p.fixedCount, 0);
});

// ─── guards against announcing a phantom fix ───────────────────────────────

test("Gate A: a thread whose stage did not run is untouched and still counted", () => {
  const [item] = defectItems();
  const p = plan({
    items: [],
    threads: [threadFor(item)],
    stagesRun: new Set<ReviewStage>(["criteria"]),
  });
  assert.equal(opsOf(p.ops, "resolve").length, 0);
  assert.equal(opsOf(p.ops, "miss").length, 0);
  assert.equal(opsOf(p.ops, "carry").length, 1);
  assert.equal(p.fixedCount, 0);
  // Crucially it still shows on the card: nobody looked, so nothing went away.
  assert.deepEqual(p.openForCounting, [{ category: "defect", state: "open" }]);
});

test("a same-sha rerun never accrues a miss — nothing in the code changed", () => {
  const [item] = defectItems();
  const p = plan({ items: [], threads: [threadFor(item, { lastSeenSha: SHA_NEW })] });
  assert.equal(opsOf(p.ops, "resolve").length, 0);
  assert.equal(opsOf(p.ops, "carry").length, 1);
  assert.equal(p.fixedCount, 0);
  assert.deepEqual(p.openForCounting, [{ category: "defect", state: "open" }]);
});

test("a thread rebuilt from GitHub is never resolved until its item is seen again", () => {
  const [item] = defectItems();
  const p = plan({ items: [], threads: [threadFor(item, { recovered: true })] });
  assert.equal(opsOf(p.ops, "resolve").length, 0);
  assert.equal(opsOf(p.ops, "carry").length, 1);
});

test("Gate B: a file that left the PR resolves with 'gone', not a claim of a fix", () => {
  const [item] = defectItems({ path: "src/dropped.ts" });
  const p = plan({ items: [], threads: [threadFor(item)] });
  const resolve = opsOf(p.ops, "resolve")[0] as Extract<ThreadOp, { op: "resolve" }>;
  assert.equal(resolve.attribution.kind, "gone");
  assert.equal((resolve.attribution as any).path, "src/dropped.ts");
});

// ─── criteria ──────────────────────────────────────────────────────────────

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  id: "C1",
  text: "Claims are gated on ownership.",
  met: false,
  evidence: null,
  evidenceCode: { path: "src/a.ts", startLine: 11, language: "ts", code: "x" },
  ...over,
});

test("a criterion that flips to met keeps its thread, counts as fixed, and names the commit", () => {
  const [unmetItem] = items({ criteria: [criterion()] });
  const [metItem] = items({ criteria: [criterion({ met: true, evidence: "now gated" })] });
  const p = plan({ items: [metItem], threads: [threadFor(unmetItem)] });
  assert.equal(opsOf(p.ops, "resolve").length, 0, "a passing criterion is still worth showing");
  assert.equal(p.fixedCount, 1);
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.match(update.body, /### ✅ Acceptance criterion met — C1/);
  assert.match(update.body, /Fixed in \[`9f2c1ab`\]/);
});

test("a criterion already met last run is not counted as newly fixed again", () => {
  const [metItem] = items({ criteria: [criterion({ met: true, evidence: "now gated" })] });
  const p = plan({ items: [metItem], threads: [threadFor(metItem, { itemState: "met" })] });
  assert.equal(p.fixedCount, 0);
});

// ─── the running-count contract the card depends on ────────────────────────

test("fix two bugs and introduce one: the open set is 1 and the fixed count is 2", () => {
  const a = defectItems({ path: "src/a.ts", concern: "first bug" })[0];
  const b = defectItems({ path: "src/a.ts", concern: "second bug" })[0];
  const c = defectItems({ path: "src/a.ts", concern: "third bug, freshly introduced" })[0];
  const p = plan({ items: [c], threads: [threadFor(a, { commentId: 1 }), threadFor(b, { commentId: 2 })] });
  assert.equal(p.fixedCount, 2);
  assert.equal(opsOf(p.ops, "resolve").length, 2);
  assert.equal(opsOf(p.ops, "create").length, 1);
  assert.deepEqual(p.openForCounting, [{ category: "defect", state: "open" }]);
});

// ─── caps, budget and anchoring fallbacks ──────────────────────────────────

test("an unanchorable item never becomes a thread and is handed to the card", () => {
  const [item] = items({
    holistic: { ...EMPTY_HOLISTIC, crossRepoImpacts: [finding({ path: undefined, severity: "warn" })] },
  });
  const p = plan({ items: [item] });
  assert.equal(opsOf(p.ops, "create").length, 0);
  assert.deepEqual(p.unanchorable, [item]);
});

test("an item whose file is not in the diff is unanchorable, not file-anchored", () => {
  const [item] = defectItems({ path: "src/elsewhere.ts" });
  const p = plan({ items: [item] });
  assert.equal(opsOf(p.ops, "create").length, 0);
  assert.equal(p.unanchorable.length, 1);
});

test("a per-category cap pushes the excess onto the card and leaves criteria alone", () => {
  const nits = Array.from({ length: 6 }, (_, i) =>
    items({
      holistic: {
        ...EMPTY_HOLISTIC,
        docDriftFindings: [finding({ concern: `doc drift ${i}`, severity: "nit" })],
      },
    })[0]
  );
  const p = plan({ items: nits });
  assert.equal(opsOf(p.ops, "create").length, 3, "docDrift is capped at 3");
  assert.equal(p.overflowed.length, 3);
  assert.ok(p.overflowed.every((i) => i.category === "docDrift"));
});

test("the lifetime thread ceiling is respected across runs, counting existing threads", () => {
  const existing = Array.from({ length: 3 }, (_, i) => {
    const [item] = defectItems({ concern: `existing ${i}` });
    return threadFor(item, { commentId: 100 + i });
  });
  const fresh = Array.from({ length: 3 }, (_, i) => defectItems({ concern: `fresh ${i}` })[0]);
  const p = plan({ items: fresh, threads: existing, maxOpen: 4 });
  assert.equal(opsOf(p.ops, "create").length, 1);
  assert.equal(p.overflowed.length, 2);
});

test("the per-run write budget stops creates rather than half-spraying threads", () => {
  const fresh = Array.from({ length: 5 }, (_, i) => defectItems({ concern: `bug ${i}` })[0]);
  const p = plan({ items: fresh, budget: 2 });
  assert.equal(opsOf(p.ops, "create").length, 2);
  assert.equal(p.overflowed.length, 3);
  assert.ok(p.ops.some((o) => o.op === "overflow" && o.reason === "budget"));
});

test("the budget spends on criteria and blockers before advisory nits", () => {
  const nit = items({
    holistic: { ...EMPTY_HOLISTIC, conventionFindings: [finding({ concern: "nit", severity: "nit" })] },
  })[0];
  const bug = defectItems({ concern: "blocker bug" })[0];
  const crit = items({ criteria: [criterion()] })[0];
  const p = plan({ items: [nit, bug, crit], budget: 2 });
  const created = (opsOf(p.ops, "create") as Extract<ThreadOp, { op: "create" }>[]).map(
    (o) => o.item.category
  );
  assert.deepEqual(created, ["criterion", "defect"]);
  assert.deepEqual(p.overflowed.map((i) => i.category), ["convention"]);
});

test("an exhausted budget defers the PATCH instead of dropping the thread's state", () => {
  const [before] = defectItems();
  const [after] = defectItems({ failureScenario: "changed" });
  const p = plan({ items: [after], threads: [threadFor(before)], budget: 0 });
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.changed, false, "no API call this run — the next run retries");
});

test("a line just outside a hunk snaps, and the body says where it really pointed", () => {
  const [item] = defectItems({ line: 15 });
  const p = plan({ items: [item] });
  const create = opsOf(p.ops, "create")[0] as Extract<ThreadOp, { op: "create" }>;
  assert.deepEqual(create.anchor, {
    kind: "line",
    path: "src/a.ts",
    line: 13,
    side: "RIGHT",
    snappedFrom: 15,
  });
  assert.match(create.body, /_Nearest diff line to `src\/a\.ts:15`\._/);
});

test("a finding far outside every hunk still lands, at file level", () => {
  const [item] = defectItems({ line: 900 });
  const p = plan({ items: [item] });
  const create = opsOf(p.ops, "create")[0] as Extract<ThreadOp, { op: "create" }>;
  assert.deepEqual(create.anchor, { kind: "file", path: "src/a.ts" });
});
