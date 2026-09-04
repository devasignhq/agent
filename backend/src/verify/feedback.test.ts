// Offline: the PR-comment feedback loop — classification (mock LLM), revisions
// that supersede rather than mutate, targeted re-plan + dispatch, replies,
// clarification on low confidence, and one re-run in flight per PR.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/feedback.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { afterFeedbackRunSettled, applyActions, CONFIDENCE_THRESHOLD, enqueueVerifyFeedbackIfEligible, isBotLogin, normalizeActions, runVerifyFeedback } from "./feedback.js";
import { createVerifyRun, diffCriteria, snapshotCriteriaRevision, updateRun } from "./runs.js";
import { runVerifyJudge } from "./judge.js";
import type { Criterion } from "../types.js";
import type { MaintainerComment } from "../queue.js";

const crit = (id: string, text: string, kind: Criterion["kind"] = "code"): Criterion => ({ id, text, met: null, evidence: null, kind });
const comment = (body: string, over: Partial<MaintainerComment> = {}): MaintainerComment => ({ body, author: "maintainer", authorAssociation: "OWNER", sourceUrl: "https://github.com/acme/w/pull/7#issuecomment-900", sourceEvent: "issue_comment", commentId: 900, ...over });

function seed() {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: "", accountId: 1, accountLogin: "acme", installationId: 9, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "w", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  const criteria = [crit("1", "The revenue page shows a refunds line", "ui"), crit("2", "sumRefunds handles an empty list")];
  const review = db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 7, prTitle: "Refunds", headSha: "abc1234", baseSha: "d", status: "changes_requested", verdict: null, criteria, taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
  snapshotCriteriaRevision(review.id, criteria, null);
  const run = createVerifyRun({ review, repo, status: "completed", triggeredBy: { kind: "pr_event" } });
  updateRun(run.id, { verdicts: [{ criterionId: "1", verdict: "fail", reason: "refunds line missing", evidenceRefs: [] }, { criterionId: "2", verdict: "pass", reason: "passed", evidenceRefs: [] }] });
  const calls = { replies: [] as string[], dispatches: [] as unknown[], plans: [] as string[][] };
  const deps = {
    postReply: async (_i: unknown, _r: unknown, _n: number, body: string) => { calls.replies.push(body); return 700 + calls.replies.length; },
    dispatch: async (_i: unknown, _r: unknown, payload: unknown) => { calls.dispatches.push(payload); },
    plan: async (runId: string, ids: string[]) => { calls.plans.push(ids); updateRun(runId, { status: "awaiting_runner", planId: null }); return null; },
  };
  const cleanup = () => {
    for (const c of ["verifyRuns", "verifyPlans", "verifyResults", "criteriaRevisions", "prCommentActions", "reviewLogs"] as const) db.remove(c, (x: any) => x.reviewId === review.id || x.runId === run.id);
    db.remove("prReviews", (r) => r.id === review.id);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
  };
  return { repo, review, run, deps, calls, cleanup };
}

test("DoD 14: a reword + an add land as revision 2, re-plan only the affected criteria, dispatch the runner, and reply", async () => {
  const s = seed();
  try {
    const out = await runVerifyFeedback(s.review.id, comment("the refunds line should only show when refunds > 0, and also check the total is formatted as currency"), s.deps);
    assert.equal(out.outcome, "applied");
    assert.equal(out.revision, 2);
    const review = db.find("prReviews", (r) => r.id === s.review.id)!;
    const old = review.criteria.find((c) => c.id === "1")!;
    const reworded = review.criteria.find((c) => c.id === old.supersededBy)!;
    assert.ok(reworded, "the reword created a new criterion and superseded the old one");
    assert.equal(reworded.text, "The refunds line is shown only when refunds > 0.");
    assert.equal(reworded.kind, "ui", "kind carries over");
    assert.equal(reworded.source?.input, "comment");
    assert.equal(reworded.source?.ref, "900");
    const added = review.criteria.find((c) => /formatted as currency/i.test(c.text))!;
    assert.ok(added);
    assert.equal(added.revision, 2);
    const rev = db.find("criteriaRevisions", (c) => c.reviewId === s.review.id && c.revision === 2)!;
    assert.equal(rev.causedByCommentId, 900);
    assert.deepEqual(rev.diff.map((d) => d.op).sort(), ["add", "add", "remove"], "diff: new reworded criterion + added criterion + old superseded");
    assert.deepEqual(s.calls.plans, [[reworded.id, added.id]], "only the affected criteria are re-planned");
    assert.equal(s.calls.dispatches.length, 1);
    assert.equal((s.calls.dispatches[0] as any).pr, 7);
    assert.equal(s.calls.replies.length, 1);
    assert.match(s.calls.replies[0], /reworded 1 → \d+/);
    assert.match(s.calls.replies[0], /added \d+: The total is formatted as currency/);
    assert.match(s.calls.replies[0], /Re-running verification for 2 criteria/);
    const newRun = db.find("verifyRuns", (r) => r.id === out.runId)!;
    assert.equal(newRun.triggeredBy.kind, "comment");
    assert.equal(newRun.inheritFromRunId, s.run.id);
    assert.equal(newRun.criteriaRevision, 2);
    assert.equal(newRun.attempt, 2);
    const row = db.find("prCommentActions", (c) => c.reviewId === s.review.id)!;
    assert.equal(row.outcome, "applied");
    assert.equal(row.replyCommentId, 701);
    assert.deepEqual(row.classified.map((a) => a.action), ["reword_criterion", "add_criterion"]);
  } finally {
    s.cleanup();
  }
});

test("'thanks' → ignore: no reply, no run, no revision", async () => {
  const s = seed();
  try {
    const out = await runVerifyFeedback(s.review.id, comment("thanks!"), s.deps);
    assert.equal(out.outcome, "ignored");
    assert.equal(s.calls.replies.length, 0);
    assert.equal(db.filter("verifyRuns", (r) => r.reviewId === s.review.id).length, 1);
    assert.equal(db.filter("criteriaRevisions", (c) => c.reviewId === s.review.id).length, 1);
    assert.equal(db.find("prCommentActions", (c) => c.reviewId === s.review.id)?.outcome, "ignored");
  } finally {
    s.cleanup();
  }
});

test("a question gets an answer citing evidence; a low-confidence change gets a clarification request; rerun re-plans everything", async () => {
  const s = seed();
  try {
    const q = await runVerifyFeedback(s.review.id, comment("why did criterion 1 fail?"), s.deps);
    assert.equal(q.outcome, "answered");
    assert.match(s.calls.replies[0], /recorded test outcomes/);
    assert.match(s.calls.replies[0], /Verification details/);
    const low = await runVerifyFeedback(s.review.id, comment("maybe also check the totals are rounded"), s.deps);
    assert.equal(low.outcome, "clarification_requested");
    assert.match(s.calls.replies[1], /not sure which/);
    assert.match(s.calls.replies[1], /add criterion: "The totals are rounded\."/);
    assert.equal(db.filter("criteriaRevisions", (c) => c.reviewId === s.review.id).length, 1, "nothing applied");
    const rerun = await runVerifyFeedback(s.review.id, comment("please re-run verification"), s.deps);
    assert.equal(rerun.outcome, "applied");
    assert.deepEqual(s.calls.plans, [["1", "2"]], "rerun plans every verifiable criterion");
    assert.equal(db.filter("criteriaRevisions", (c) => c.reviewId === s.review.id).length, 1, "a rerun creates no revision");
  } finally {
    s.cleanup();
  }
});

test("one re-run in flight per PR: a second comment is queued and released when the run settles", async () => {
  const s = seed();
  try {
    const first = await runVerifyFeedback(s.review.id, comment("also check the total is formatted as currency", { commentId: 901 }), s.deps);
    assert.equal(first.outcome, "applied");
    const second = await runVerifyFeedback(s.review.id, comment("also check the page title is Revenue", { commentId: 902 }), s.deps);
    assert.equal(second.outcome, "queued");
    assert.equal(s.calls.replies.length, 1, "no reply while queued");
    const queued = db.find("prCommentActions", (c) => c.githubCommentId === 902)!;
    assert.equal(queued.outcome, "queued");
    assert.equal(queued.queuedComment?.body, "also check the page title is Revenue");
    // The in-flight run settles: the reply is updated and the queued comment is re-enqueued.
    const run = db.find("verifyRuns", (r) => r.id === first.runId)!;
    updateRun(run.id, { status: "completed", verdicts: [{ criterionId: "3", verdict: "pass", reason: "passed", evidenceRefs: [] }] });
    const updates: string[] = [];
    await afterFeedbackRunSettled(db.find("verifyRuns", (r) => r.id === run.id)!, { updateReply: async (_i, _r, id, body) => { updates.push(`${id}:${body}`); return true; } });
    assert.equal(updates.length, 1);
    assert.match(updates[0], /^701:/);
    assert.match(updates[0], /Updated verification/);
    assert.match(updates[0], /\*\*3\.\*\* .* — \*\*pass\*\*/);
    assert.equal(db.find("prCommentActions", (c) => c.githubCommentId === 902)?.outcome, "ignored", "queued row is superseded by the re-enqueued copy");
  } finally {
    s.cleanup();
  }
});

test("bots are ignored; only PRs with a verify run are eligible; helpers", async () => {
  const s = seed();
  try {
    assert.equal((await runVerifyFeedback(s.review.id, comment("re-run", { author: "devasign-agent[bot]" }), s.deps)).outcome, "bot");
    assert.equal(isBotLogin("dependabot[bot]"), true);
    assert.equal(isBotLogin("alice"), false);
    assert.equal(enqueueVerifyFeedbackIfEligible(s.review.id, comment("x")), true);
    assert.equal(enqueueVerifyFeedbackIfEligible(uuid(), comment("x")), false);
    const norm = normalizeActions({ actions: [{ action: "add_criterion", confidence: "0.9", actedOnText: "x", text: " New one " }, { action: "bogus" }, { action: "rerun", confidence: 2 }], reply: 42 });
    assert.deepEqual(norm.actions.map((a) => [a.action, a.confidence, a.text]), [["add_criterion", 0.9, "New one"], ["rerun", 1, undefined]]);
    assert.equal(norm.reply, null);
    const applied = applyActions([crit("1", "A"), crit("2", "B")], [
      { action: "add_criterion", confidence: 0.9, actedOnText: "x", text: "a" }, // duplicate of 1 (case-insensitive) → skipped
      { action: "reword_criterion", confidence: CONFIDENCE_THRESHOLD - 0.1, actedOnText: "x", criterionId: "2", text: "B2" }, // low → skipped
      { action: "mark_not_applicable", confidence: 0.9, actedOnText: "x", criterionId: "2" },
    ], 2, 5);
    assert.deepEqual(applied.affectedIds, []);
    assert.equal(applied.criteria.find((c) => c.id === "2")?.notApplicable, true);
    assert.deepEqual(diffCriteria([crit("1", "A"), crit("2", "B")], applied.criteria).map((d) => d.op), ["not_applicable"]);
  } finally {
    s.cleanup();
  }
});

test("judge: a feedback re-run inherits the previous run's verdicts for criteria it did not re-plan", async () => {
  const s = seed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })) as any;
  try {
    const review = db.find("prReviews", (r) => r.id === s.review.id)!;
    const next = createVerifyRun({ review, repo: s.repo, status: "judging", triggeredBy: { kind: "comment", commentId: 900 }, inheritFromRunId: s.run.id });
    const plan = db.insert("verifyPlans", { id: uuid(), schemaVersion: 1, runId: next.id, repoId: s.repo.id, criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: [{ id: "t1", path: ".devasign/tests/a.test.ts", content: "x", criterionIds: ["1"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "s", strategyVersion: 1, targetFiles: [] }] });
    const results = db.insert("verifyResults", { id: uuid(), schemaVersion: 1, runId: next.id, createdAt: 0, payload: { runId: next.id, sha: "abc1234", planId: plan.id, cliVersion: "0.1", existingTestsTouchingDiff: [], timings: { startedAt: 0, finishedAt: 1 }, results: [{ id: "r1", testId: "t1", criterionIds: ["1"], test: "a", runner: "node-test", level: "unit", origin: "generated", status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 1, artifactIds: [] }], durationMs: 1, artifactIds: [] }] } });
    updateRun(next.id, { planId: plan.id, resultsId: results.id });
    const out = await runVerifyJudge(next.id);
    assert.equal(out?.status, "completed");
    const byId = new Map(out!.verdicts.map((v) => [v.criterionId, v]));
    assert.equal(byId.get("1")?.verdict, "pass", "re-planned criterion judged fresh");
    assert.equal(byId.get("2")?.verdict, "pass", "untouched criterion inherits");
    assert.match(byId.get("2")!.reason, /from the previous run/);
  } finally {
    globalThis.fetch = originalFetch;
    s.cleanup();
  }
});
