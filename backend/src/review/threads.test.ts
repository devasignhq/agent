// Pure tests for the thread reconciler's planner. No db / network / LLM — the
// whole point of splitting planReconciliation out of reconcileThreads is that
// every rule below is decidable offline. Run:
//   node --import tsx/esm --test src/review/threads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines } from "./anchor.js";
import { formatThreadBody, parseItemMarker } from "./comment.js";
import { buildReviewItems, type ReviewItem, type ReviewStage } from "./items.js";
import { bodyHash, planReconciliation, reconcileThreads, type ThreadClient, type ThreadOp } from "./threads.js";
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
  assert.match(update.body, /<summary>✅ Acceptance criterion met — C1/);
  assert.match(update.body, /Fixed in \[`9f2c1ab`\]/);
});

test("a criterion already met last run is not counted as newly fixed again", () => {
  const [metItem] = items({ criteria: [criterion({ met: true, evidence: "now gated" })] });
  const p = plan({ items: [metItem], threads: [threadFor(metItem, { itemState: "met" })] });
  assert.equal(p.fixedCount, 0);
});

// ─── the running-count contract the card depends on ────────────────────────

test("fix two bugs and introduce one: the open set is 1 and the fixed count is 2", () => {
  // Three genuinely different findings. Identity is by evidence, not key, so
  // terse fixtures like "first bug" / "third bug" would read as one finding —
  // real concerns don't share their vocabulary like that.
  const a = defectItems({ path: "src/a.ts", concern: "Missing await on flush() — the handler returns before the write lands." })[0];
  const b = defectItems({ path: "src/a.ts", concern: "The retry loop never backs off, so a failing provider is hammered." })[0];
  const c = defectItems({ path: "src/a.ts", concern: "Null check on items is inverted, returning the empty payload for a populated list." })[0];
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

// ─── identity across runs: a reworded finding is the same finding ──────────


const DEFERRAL_RUN1 =
  "Incidental: The added comment `// TODO: honour the pagination params from the ticket (page, pageSize) before shipping.` admits that pagination params (page, pageSize) from the ticket are not yet honoured. This work is deferred, but the PR description explicitly discloses pagination as a follow-up.";
const DEFERRAL_RUN2 =
  'Incidental: Undercuts PR description\'s pagination follow-up note (explicitly disclosed, not part of the three acceptance criteria). Verbatim admission: "// TODO: honour the pagination params from the ticket (page, pageSize) before shipping." The pagination params (page, pageSize) are not honoured.';

const deferralItems = (concern: string) =>
  items({ holistic: { ...EMPTY_HOLISTIC, deferrals: [finding({ line: 11, concern, severity: "warn" })] } });

test("a reworded re-report updates its thread and takes the new key — no phantom fix, no duplicate", () => {
  // Exactly what happened on verify-demo#5: the model re-described the same TODO
  // on the next push, the key changed, and the old thread was announced fixed
  // while a new one opened beside it.
  const [before] = deferralItems(DEFERRAL_RUN1);
  const [after] = deferralItems(DEFERRAL_RUN2);
  assert.notEqual(before.key, after.key, "the wording-derived keys really do differ");
  const p = plan({ items: [after], threads: [threadFor(before, { match: { concern: before.concern } })] });
  assert.equal(opsOf(p.ops, "resolve").length, 0, "not a fix");
  assert.equal(opsOf(p.ops, "create").length, 0, "not a new finding");
  assert.equal(p.fixedCount, 0);
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.item.key, after.key);
  assert.equal(update.changed, true, "the new wording is written to the existing thread");
});

test("rows written before matching existed fall back to the title and still pair", () => {
  const [before] = deferralItems(DEFERRAL_RUN1);
  const [after] = deferralItems(DEFERRAL_RUN2);
  // A legacy row as prod actually holds them: no `match`, and a title clipped the
  // old way — a flat 99 characters, which keeps most of the concern's vocabulary.
  // (The current clip stops before an inline code span, which would starve a
  // title-only fallback; new rows always carry `match`, so that never happens.)
  const legacy = threadFor(before, { title: `${before.concern.slice(0, 99)}…` });
  delete (legacy as any).match;
  const p = plan({ items: [after], threads: [legacy] });
  assert.equal(opsOf(p.ops, "update").length, 1);
  assert.equal(opsOf(p.ops, "resolve").length, 0);
});

test("a finding that comes back reworded after being marked fixed reopens its own thread", () => {
  const [before] = deferralItems(DEFERRAL_RUN1);
  const [after] = deferralItems(DEFERRAL_RUN2);
  const resolved = threadFor(before, { state: "resolved", resolvedAtSha: SHA_OLD, match: { concern: before.concern } });
  const p = plan({ items: [after], threads: [resolved] });
  assert.equal(opsOf(p.ops, "create").length, 0);
  const update = opsOf(p.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.match(update.body, /\*\*Reopened\*\*/);
});

test("an open thread gets first pick over a resolved one for the same re-report", () => {
  const [before] = deferralItems(DEFERRAL_RUN1);
  const [after] = deferralItems(DEFERRAL_RUN2);
  const open = threadFor(before, { commentId: 1, match: { concern: before.concern } });
  const done = threadFor(before, { commentId: 2, key: before.key + "-old", state: "resolved", match: { concern: before.concern } });
  const p = plan({ items: [after], threads: [done, open] });
  const updates = opsOf(p.ops, "update") as Extract<ThreadOp, { op: "update" }>[];
  assert.equal(updates.length, 1);
  assert.equal(updates[0].thread.commentId, 1);
  assert.equal(opsOf(p.ops, "carry").length, 1, "the resolved twin is left alone");
});

test("a genuinely different finding on the same line still opens its own thread", () => {
  const [bug] = defectItems({ line: 45, concern: "The catch block rethrows, so a failed audit write fails the whole list request." });
  const [other] = defectItems({ line: 45, concern: "The warning message interpolates the raw error object, which prints [object Object] in the structured logger." });
  const p = plan({ items: [other], threads: [threadFor(bug, { match: { concern: bug.concern } })] });
  assert.equal(opsOf(p.ops, "create").length, 1);
  assert.equal(opsOf(p.ops, "resolve").length, 1, "the bug really is gone this run");
});

test("applying a paired update migrates the stored key and match, so the next run matches exactly", async () => {
  const [before] = deferralItems(DEFERRAL_RUN1);
  const [after] = deferralItems(DEFERRAL_RUN2);
  const p = plan({ items: [after], threads: [threadFor(before, { match: { concern: before.concern } })] });
  const calls: string[] = [];
  const client: ThreadClient = {
    createReview: async () => ({ reviewId: 1, comments: [] }),
    create: async () => ({ id: 999 }),
    update: async (_i, _o, _n, id, body) => {
      calls.push(`update#${id}:${body.split("\n")[2]}`);
      return "ok";
    },
    get: async () => "",
  };
  const result = await reconcileThreads({
    installationId: 1, owner: "o", name: "n", prNumber: 1, headSha: SHA_NEW, plan: p, client,
  });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].key, after.key, "the thread now carries the new key");
  assert.equal(result.threads[0].match?.concern, after.concern);
  assert.equal(result.threads[0].commentId, 500, "same GitHub comment");
  assert.match(calls[0], /^update#500:<summary>🚧 Deferred work/);

  // And a third run with the run-2 wording is now an exact-key match: no pairing needed.
  const again = plan({ items: [after], threads: result.threads });
  const update = opsOf(again.ops, "update")[0] as Extract<ThreadOp, { op: "update" }>;
  assert.equal(update.changed, false, "identical body — no API call");
});
// ─── applying the plan: one batched review per run ─────────────────────────

type ClientCall = { fn: keyof ThreadClient; args: any };

// Records every call and answers with whatever the test scripted.
function fakeClient(script: {
  batch?:
    | Awaited<ReturnType<ThreadClient["createReview"]>>
    | ((args: any) => Awaited<ReturnType<ThreadClient["createReview"]>>);
  single?: Awaited<ReturnType<ThreadClient["create"]>>;
}) {
  const calls: ClientCall[] = [];
  let nextId = 900;
  const client: ThreadClient = {
    async createReview(_i, _o, _n, _p, args) {
      calls.push({ fn: "createReview", args });
      if (typeof script.batch === "function") return script.batch(args);
      if (script.batch) return script.batch;
      // Echoed back in REVERSE order: ids must be matched by marker, never by
      // position.
      const comments = [...args.comments]
        .reverse()
        .map((c) => ({ id: nextId++, body: c.body, path: c.path }));
      return { reviewId: 42, comments };
    },
    async create(_i, _o, _n, _p, args) {
      calls.push({ fn: "create", args });
      return script.single ?? { id: nextId++ };
    },
    async update(_i, _o, _n, commentId, body) {
      calls.push({ fn: "update", args: { commentId, body } });
      return "ok";
    },
    async get(_i, _o, _n, commentId) {
      calls.push({ fn: "get", args: { commentId } });
      return `<!-- devasign:item v1 k=x -->\n### old\n\nold detail`;
    },
  };
  return { client, calls };
}

const apply = (p: ReturnType<typeof plan>, client: ThreadClient) =>
  reconcileThreads({
    installationId: 1,
    owner: "acme",
    name: "widgets",
    prNumber: 1,
    headSha: SHA_NEW,
    plan: p,
    client,
  });

// Concerns deliberately share no vocabulary: buildReviewItems clusters findings
// by identity, and three thin ones would merge into a single item.
const threeItems = () =>
  items({
    holistic: {
      ...EMPTY_HOLISTIC,
      defects: [
        finding({
          line: 11,
          concern: "The catch block rethrows, so a failed audit write fails the whole list request.",
        }),
        finding({
          line: 12,
          concern:
            "The warning message interpolates the raw error object, which prints [object Object] in the structured logger.",
        }),
        finding({
          line: 13,
          concern:
            "The retry loop has no ceiling, so a permanently rejected payload spins until the job times out.",
        }),
      ],
    },
  });

test("new line-anchored threads go up as ONE review, ids matched back by marker", async () => {
  const p = plan({ items: threeItems() });
  const { client, calls } = fakeClient({});
  const result = await apply(p, client);

  const batches = calls.filter((c) => c.fn === "createReview");
  assert.equal(batches.length, 1, "exactly one review for the run");
  assert.equal(calls.filter((c) => c.fn === "create").length, 0);
  assert.equal(batches[0].args.commitId, SHA_NEW);
  assert.deepEqual(
    batches[0].args.comments.map((c: any) => [c.path, c.line, c.side]),
    [
      ["src/a.ts", 11, "RIGHT"],
      ["src/a.ts", 12, "RIGHT"],
      ["src/a.ts", 13, "RIGHT"],
    ]
  );
  assert.equal(result.created, 3);
  assert.equal(result.threads.length, 3);
  assert.equal(result.fellBack, false);
  assert.equal(result.recoveryNeeded, false);
  // The fake answered in reverse order; each thread must still own the id whose
  // body carries its own marker.
  const comments: Array<{ id: number; body: string }> = [...batches[0].args.comments]
    .reverse()
    .map((c: any, i: number) => ({ id: 900 + i, body: c.body }));
  for (const t of result.threads) {
    const match = comments.find((c) => parseItemMarker(c.body) === t.key);
    assert.equal(t.commentId, match?.id, `thread ${t.key} owns the comment carrying its marker`);
  }
});

test("file-level anchors cannot ride in the batch and stay separate posts, after it", async () => {
  const [lineItem] = defectItems({ line: 11 });
  const [farItem] = defectItems({ line: 400, concern: "Far away." });
  const p = plan({ items: [lineItem, farItem] });
  const { client, calls } = fakeClient({});
  const result = await apply(p, client);
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["createReview", "create"]
  );
  assert.equal(calls[1].args.anchor.kind, "file");
  assert.equal(result.created, 2);
  assert.equal(result.threads.find((t) => t.key === farItem.key)?.anchor, "file");
});

test("a refused batch (bad anchor) falls back to one thread at a time", async () => {
  const p = plan({ items: threeItems() });
  const { client, calls } = fakeClient({ batch: { error: "anchor" } });
  const result = await apply(p, client);
  assert.equal(calls.filter((c) => c.fn === "create").length, 3);
  assert.equal(result.created, 3);
  assert.equal(result.fellBack, true);
  assert.equal(result.recoveryNeeded, false);
});

test("a rate-limited batch aborts the run: nothing persisted, file-level posts skipped", async () => {
  const [lineItem] = defectItems({ line: 11 });
  const [farItem] = defectItems({ line: 400, concern: "Far away." });
  const p = plan({ items: [lineItem, farItem] });
  const { client, calls } = fakeClient({ batch: { error: "rate_limit" } });
  const result = await apply(p, client);
  assert.equal(result.aborted, true);
  assert.equal(result.created, 0);
  assert.equal(result.threads.length, 0);
  assert.equal(calls.filter((c) => c.fn === "create").length, 0);
});

test("an unknown batch outcome persists nothing and asks the next run to rebuild ids", async () => {
  const p = plan({ items: threeItems() });
  const { client, calls } = fakeClient({ batch: { error: "other", reviewId: 42 } });
  const result = await apply(p, client);
  assert.equal(result.recoveryNeeded, true);
  assert.equal(result.aborted, false);
  assert.equal(result.threads.length, 0, "no ids to persist — a guess would be a duplicate later");
  assert.equal(calls.filter((c) => c.fn === "create").length, 0, "never re-posted blind");
});

// ─── the summary card rides as the review body ─────────────────────────────

const CARD = "## DevAsign Code Review\n\ncard";
const applyWith = (p: ReturnType<typeof plan>, client: ThreadClient) =>
  reconcileThreads({
    installationId: 1,
    owner: "acme",
    name: "widgets",
    prNumber: 1,
    headSha: SHA_NEW,
    plan: p,
    summary: { body: CARD },
    client,
  });

test("the card is the body of the batched review", async () => {
  const p = plan({ items: threeItems() });
  const { client, calls } = fakeClient({});
  const result = await applyWith(p, client);
  const batches = calls.filter((c) => c.fn === "createReview");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].args.body, CARD);
  assert.equal(batches[0].args.comments.length, 3);
  assert.equal(result.reviewId, 42);
  assert.equal(result.bodyPosted, true);
});

test("with a card but no new threads, a body-only review still posts", async () => {
  const p = plan({ items: [] });
  const { client, calls } = fakeClient({});
  const result = await applyWith(p, client);
  assert.deepEqual(calls.map((c) => c.fn), ["createReview"]);
  assert.deepEqual(calls[0].args.comments, []);
  assert.equal(calls[0].args.body, CARD);
  assert.equal(result.bodyPosted, true);
  assert.equal(result.reviewId, 42);
});

test("without a card, no new threads means no review at all", async () => {
  const p = plan({ items: [] });
  const { client, calls } = fakeClient({});
  const result = await apply(p, client);
  assert.equal(calls.length, 0);
  assert.equal(result.bodyPosted, false);
  assert.equal(result.reviewId, null);
});

test("a refused batch falls back to single threads, then posts the card on its own", async () => {
  const p = plan({ items: threeItems() });
  let batches = 0;
  const { client, calls } = fakeClient({
    batch: (args) => (batches++ === 0 ? { error: "anchor" } : { reviewId: 77, comments: [] }),
  });
  const result = await applyWith(p, client);
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["createReview", "create", "create", "create", "createReview"]
  );
  assert.deepEqual(calls[4].args.comments, []);
  assert.equal(calls[4].args.body, CARD);
  assert.equal(result.fellBack, true);
  assert.equal(result.bodyPosted, true);
  assert.equal(result.reviewId, 77);
});

test("a rate-limited batch posts nothing more: the card falls back to the caller", async () => {
  const p = plan({ items: threeItems() });
  const { client, calls } = fakeClient({ batch: { error: "rate_limit" } });
  const result = await applyWith(p, client);
  assert.equal(calls.length, 1);
  assert.equal(result.aborted, true);
  assert.equal(result.bodyPosted, false);
  assert.equal(result.reviewId, null);
});

test("a batch that posted but could not be listed still counts the card as posted", async () => {
  const p = plan({ items: threeItems() });
  const { client } = fakeClient({ batch: { error: "other", reviewId: 42 } });
  const result = await applyWith(p, client);
  assert.equal(result.recoveryNeeded, true);
  assert.equal(result.bodyPosted, true);
  assert.equal(result.reviewId, 42);

  const unknown = await applyWith(p, fakeClient({ batch: { error: "other" } }).client);
  assert.equal(unknown.recoveryNeeded, true);
  assert.equal(unknown.bodyPosted, false);
});

test("a listing that misses one marker keeps the others and flags recovery", async () => {
  const p = plan({ items: threeItems() });
  const { client } = fakeClient({
    batch: (args) => ({
      reviewId: 42,
      comments: args.comments
        .slice(1)
        .map((c: any, i: number) => ({ id: 700 + i, body: c.body, path: c.path })),
    }),
  });
  const result = await apply(p, client);
  assert.equal(result.threads.length, 2);
  assert.equal(result.recoveryNeeded, true);
});

test("updates and resolves still go one PATCH at a time, before the batch", async () => {
  const [before] = defectItems();
  const [after] = defectItems({ failureScenario: "Two writers land in the same tick." });
  const [fresh] = defectItems({ line: 12, concern: "Brand new." });
  const p = plan({ items: [after, fresh], threads: [threadFor(before)] });
  const { client, calls } = fakeClient({});
  const result = await apply(p, client);
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["update", "createReview"]
  );
  assert.equal(result.updated, 1);
  assert.equal(result.created, 1);
  assert.equal(result.threads.length, 2);
});
