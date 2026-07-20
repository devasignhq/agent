// Offline tests for the bounty criteria drafting job. Real job, mock LLM (no
// ANTHROPIC_API_KEY), and no installation row so the issue-comments fetch skips
// GitHub entirely. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/criteria-job.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { queueSnapshot } from "../queue.js";
import { createBounty, getBounty, patchBounty } from "./service.js";
import { runBountyCriteriaJob } from "./criteria-job.js";

const TABLES = ["bounties", "repositories", "installations", "users", "repoIndex"] as const;

beforeEach(() => {
  for (const t of TABLES) db.remove(t as any, () => true);
});

function seedRepo(opts: { indexState?: string; withIndex?: boolean } = {}) {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(), // no matching install row → no GitHub calls
    owner: "acme",
    name: "pay",
    private: false,
    reviewsEnabled: true,
    modelOverrides: {},
    indexState: opts.indexState ?? "ready",
  } as any);
  if (opts.withIndex) {
    db.insert("repoIndex", {
      id: uuid(),
      repoId: repo.id,
      path: "src/webhooks.ts",
      sha: "a",
      size: 4000,
      language: "ts",
      summary: "Receives GitHub webhook payloads and dispatches them.",
      exports: ["handleWebhook"],
      imports: [],
      securityFlags: [],
      indexedAt: Date.now(),
      model: "test",
    } as any);
  }
  return repo;
}

function seedBounty(patch: Record<string, unknown> = {}) {
  return db.insert("bounties", {
    id: uuid(),
    seq: 1,
    code: "BNTY-1",
    source: "github",
    installationId: 0, // falsy → fetchIssueComments returns [] without a call
    repo: "acme/pay",
    issueNumber: 12,
    issueUrl: "https://github.com/acme/pay/issues/12",
    title: "Ignore duplicate webhook deliveries",
    description: "We reprocess redelivered webhooks, which double-charges.",
    acceptance: [],
    acceptanceState: "generating",
    taskId: "x".repeat(25),
    contractId: "C",
    amountStroops: "1000000000",
    amountUsdc: 100,
    deliveryDays: 3,
    status: "PENDING_FUNDING",
    onchainStatus: null,
    applications: [],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  } as any);
}

test("drafts criteria and marks the bounty ready", async () => {
  seedRepo({ withIndex: true });
  const b = seedBounty();

  await runBountyCriteriaJob(b.id);

  const after = getBounty(b.id)!;
  assert.equal(after.acceptanceState, "ready");
  assert.ok(after.acceptance.length > 0, "the mock LLM returns four criteria");
  assert.ok(after.acceptanceEndGoal && after.acceptanceEndGoal.length > 0);
  assert.ok(
    after.events?.some((e) => e.kind === "criteria_drafted"),
    "the draft must be recorded on the activity log"
  );
});

test("works with no repo index at all (issue-only criteria)", async () => {
  seedRepo({ indexState: "none" });
  const b = seedBounty();

  await runBountyCriteriaJob(b.id);

  assert.equal(getBounty(b.id)!.acceptanceState, "ready", "an unindexed repo must still draft");
});

test("works when the repo is not connected at all", async () => {
  const b = seedBounty({ repo: "stranger/repo" });

  await runBountyCriteriaJob(b.id);

  assert.equal(getBounty(b.id)!.acceptanceState, "ready");
});

// ── the guards that protect a sponsor's own words ────────────────────────────

test("does nothing when the bounty is not marked generating", async () => {
  const b = seedBounty({ acceptanceState: "ready", acceptance: ["mine, not yours"] });

  await runBountyCriteriaJob(b.id);

  const after = getBounty(b.id)!;
  assert.deepEqual(after.acceptance, ["mine, not yours"], "a sponsor's saved list must never be overwritten");
});

test("discards its own result if the sponsor saved while the model was running", async () => {
  seedRepo();
  const b = seedBounty();

  // Simulate the sponsor's PATCH landing mid-flight: the job re-reads state
  // after the LLM call and must stand down.
  const job = runBountyCriteriaJob(b.id);
  patchBounty(b.id, { acceptance: ["sponsor wrote this"], acceptanceState: "ready" });
  await job;

  const after = getBounty(b.id)!;
  assert.deepEqual(after.acceptance, ["sponsor wrote this"]);
  assert.equal(after.acceptanceState, "ready");
});

test("a missing bounty is a no-op, not a throw", async () => {
  await assert.doesNotReject(() => runBountyCriteriaJob(uuid()));
});

// ── failure handling ─────────────────────────────────────────────────────────

test("never leaves the bounty stuck in generating when synthesis throws", async () => {
  seedRepo();
  const b = seedBounty();

  await assert.doesNotReject(() =>
    runBountyCriteriaJob(b.id, {
      synthesize: async () => {
        throw new Error("model unavailable");
      },
    })
  );

  const after = getBounty(b.id)!;
  assert.equal(after.acceptanceState, "errored");
  assert.notEqual(after.acceptanceState, "generating", "a stuck row spins the fund page forever");
});

test("an empty endGoal is treated as a failure, NOT as 'the issue was too vague'", async () => {
  seedRepo();
  const b = seedBounty();

  // What tryParseJSON returns when the model's response doesn't parse. The
  // prompt guarantees a non-empty endGoal even when criteria is legitimately
  // empty, so this shape can only mean the call failed. Persisting it as
  // "ready" would tell the sponsor their issue was too vague when it wasn't.
  await runBountyCriteriaJob(b.id, {
    synthesize: async () => ({ endGoal: "", criteria: [] }),
  });

  assert.equal(getBounty(b.id)!.acceptanceState, "errored");
});

test("a genuinely vague issue yields an empty list but still reads ready", async () => {
  seedRepo();
  const b = seedBounty();

  await runBountyCriteriaJob(b.id, {
    synthesize: async () => ({
      endGoal: "The issue does not say what should change.",
      criteria: [],
    }),
  });

  const after = getBounty(b.id)!;
  assert.equal(after.acceptanceState, "ready", "empty-but-explained is a result, not a failure");
  assert.deepEqual(after.acceptance, []);
  assert.match(after.acceptanceEndGoal!, /does not say/);
});

test("normalizes drafted criteria and enforces the stored caps", async () => {
  seedRepo();
  const b = seedBounty();

  await runBountyCriteriaJob(b.id, {
    synthesize: async () => ({
      endGoal: "Success.",
      criteria: [
        { id: "1", text: "  spans\na newline  ", met: null, evidence: null },
        { id: "2", text: "   ", met: null, evidence: null },
        { id: "3", text: "x".repeat(5000), met: null, evidence: null },
      ],
    }),
  });

  const { acceptance } = getBounty(b.id)!;
  assert.deepEqual(acceptance, ["spans a newline"], "blank dropped, over-long dropped, whitespace collapsed");
});

// ── the createBounty wiring ──────────────────────────────────────────────────
// No worker is subscribed under `node --test`, so jobs just accumulate and the
// counts are exact. This covers the seam the job tests above cannot: that
// creating a bounty actually flags it and queues the draft.

const CREATE_INPUT = {
  source: "github" as const,
  installationId: 1,
  repo: "acme/pay",
  issueNumber: 99,
  issueUrl: "https://github.com/acme/pay/issues/99",
  title: "Ignore duplicate webhook deliveries",
  description: "We reprocess redelivered webhooks.",
  amountUsdc: 100,
  deliveryDays: 3,
};

test("createBounty flags the bounty generating and enqueues a draft", () => {
  const before = queueSnapshot().reviews;
  const b = createBounty(CREATE_INPUT);

  assert.equal(b.acceptanceState, "generating", "the fund page needs to know a draft is coming");
  assert.deepEqual(b.acceptance, []);
  assert.equal(queueSnapshot().reviews, before + 1);
});

test("createBounty skips drafting when the caller supplied their own list", () => {
  const before = queueSnapshot().reviews;
  const b = createBounty({ ...CREATE_INPUT, acceptance: ["I wrote this myself"] });

  assert.equal(b.acceptanceState, undefined, "nothing is generating");
  assert.deepEqual(b.acceptance, ["I wrote this myself"]);
  assert.equal(queueSnapshot().reviews, before, "no LLM call to overwrite the caller");
});
