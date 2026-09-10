// Offline end-to-end for the verify branch: fork after criteria, plan in
// parallel (mock planner), join with a separate "Tests by DevAsign" comment + a
// "DevAsign · Verify" check run, then results → judgment → that same tests
// comment is edited in place and the check run re-posted. The review's own
// summary card is never touched by verification.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= node --import tsx/esm --test src/review/pipeline-verify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { runReviewJob } from "./pipeline.js";
import { VERIFY_FORK_PR, VERIFY_FORKED, VERIFY_STAGE_DISABLED } from "../verify/branch.js";
import { VERIFICATION_END, VERIFICATION_START } from "../verify/report.js";
import { resultsHandler } from "../routes/v1.js";
import { runVerifyJudge } from "../verify/judge.js";

config.github.appId = "123456";
config.github.privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Call = { method: string; url: string; body: any; accept: string };
const DIFF = ["diff --git a/src/handler.ts b/src/handler.ts", "index 1111111..2222222 100644", "--- a/src/handler.ts", "+++ b/src/handler.ts", "@@ -1,2 +1,3 @@", " export function handler() {", "+  return doWork();", " }"].join("\n");
const TREE = ["package.json", "package-lock.json", "src/handler.ts", "src/handler.test.ts"].map((path) => ({ path, type: "blob", sha: "s", size: 5 }));

function ghResponse(body: any) {
  return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as any;
}

function installFetchStub(headRepoFullName = "acme/widgets") {
  const calls: Call[] = [];
  const comments = new Map<number, string>();
  const reviewComments = new Map<number, Array<Record<string, unknown>>>();
  let nextId = 4242;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const accept = String(headers.Accept || headers.accept || "");
    let body: any;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method, url: u, body, accept });
    if (u.includes("/access_tokens") && method === "POST") return ghResponse({ token: "tok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (/\/issues\/\d+\/comments$/.test(u) && method === "POST") { const id = nextId++; comments.set(id, String(body?.body ?? "")); return ghResponse({ id }); }
    let m = /\/issues\/comments\/(\d+)$/.exec(u);
    if (m && method === "PATCH") { comments.set(Number(m[1]), String(body?.body ?? "")); return ghResponse({}); }
    if (m && method === "GET") return ghResponse({ id: Number(m[1]), body: comments.get(Number(m[1])) ?? "" });
    if (/\/pulls\/\d+\/commits/.test(u) && method === "GET") return ghResponse([{ sha: "abc1234", commit: { message: "Add widget" } }]);
    if (/\/pulls\/\d+\/comments(\?|$)/.test(u) && method === "POST") return ghResponse({ id: 9000 + calls.length });
    if (/\/pulls\/\d+\/reviews$/.test(u) && method === "POST") {
      reviewComments.set(99, (body?.comments ?? []).map((c: any, i: number) => ({ id: 9500 + i, body: c.body, path: c.path })));
      return ghResponse({ id: 99 });
    }
    if (/\/pulls\/\d+\/reviews\/\d+\/comments(\?|$)/.test(u) && method === "GET") return ghResponse(reviewComments.get(99) ?? []);
    if (/\/issues\/comments\/\d+$/.test(u) && method === "DELETE") return { ok: true, status: 204, json: async () => undefined, text: async () => "" } as any;
    if (/\/pulls\/\d+\/comments(\?|$)/.test(u) && method === "GET") return ghResponse([]);
    if (/\/pulls\/comments\/\d+$/.test(u)) return ghResponse({ body: "" });
    if (/\/pulls\/\d+$/.test(u) && method === "GET") {
      if (accept.includes("diff")) return ghResponse(DIFF);
      return ghResponse({ title: "Add widget", body: "<!-- devasign:intent -->I added doWork to the handler.<!-- /devasign:intent -->", state: "open", head: { sha: "abc1234", ref: "feature", repo: { full_name: headRepoFullName } }, base: { sha: "def5678" }, additions: 1, deletions: 0, changed_files: 1, commits: 1 });
    }
    if (/\/git\/trees\//.test(u) && method === "GET") return ghResponse({ tree: TREE });
    if (/\/contents\/package\.json/.test(u)) return ghResponse('{"scripts":{"test":"node --test"}}');
    if (/\/contents\//.test(u)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    if (/\/check-runs$/.test(u) && method === "POST") return ghResponse({ id: 70 + calls.length, html_url: "https://github.com/acme/widgets/runs/1" });
    return ghResponse({});
  }) as any;
  return { calls, comments, restore: () => { globalThis.fetch = original; } };
}

function seedReview(workflow?: any) {
  const install = db.insert("installations", { id: uuid(), installationId: 12345, userId: "", accountId: 1, accountLogin: "acme", repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: install.id, owner: "acme", name: "widgets", private: false, reviewsEnabled: true, defaultModel: "claude-haiku-4-5", modelOverrides: {}, indexState: "none", defaultBranch: "main", ...(workflow ? { workflow } : {}) } as any);
  const review = db.insert("prReviews", { id: uuid(), repoId: repo.id, prNumber: 1, prTitle: "Add widget", headSha: "abc1234", baseSha: "def5678", status: "queued", verdict: null, criteria: [], taskId: null, additions: null, deletions: null, changedFiles: null, createdAt: Date.now(), updatedAt: Date.now() } as any);
  return { install, repo, review };
}

test("fork after criteria, plan in parallel, Verify check run at the join; results → judged → a separate Tests comment", async () => {
  const { install, repo, review } = seedReview();
  const { calls, comments, restore } = installFetchStub();
  try {
    await runReviewJob(review.id);

    const logs = db.filter("reviewLogs", (l) => l.reviewId === review.id);
    assert.ok(logs.some((l) => l.kind === "verify" && l.action === VERIFY_FORKED), "the branch forks");
    assert.ok(logs.some((l) => l.kind === "ingest" && (l.meta?.sources as string[])?.includes("agent_intent")), "the agent-intent block is ingested");
    const run = db.find("verifyRuns", (r) => r.reviewId === review.id)!;
    assert.ok(run, "a verify run row exists");
    assert.equal(run.status, "awaiting_runner");
    assert.equal(run.criteriaRevision, 1);
    assert.equal(db.filter("criteriaRevisions", (c) => c.reviewId === review.id).length, 1);
    const t = run.timings;
    assert.ok(t.criteriaFinishedAt && t.planStartedAt && t.planFinishedAt && t.reviewBranch?.finishedAt, `timings recorded: ${JSON.stringify(t)}`);
    assert.ok(t.planStartedAt! - t.criteriaFinishedAt! < 2_000, "the verify branch starts within seconds of criteria finishing");
    assert.ok(t.planStartedAt! <= t.reviewBranch!.finishedAt, "planning overlaps the review branch");
    const plan = db.find("verifyPlans", (p) => p.id === run.planId)!;
    assert.ok(plan.tests.length >= 3, `mock plan covers the criteria: ${plan.tests.length}`);
    assert.ok(plan.tests.some((x) => x.origin === "existing" && x.path === "src/handler.test.ts"), "an existing test in the tree is cited");
    assert.ok(plan.tests.filter((x) => x.origin === "generated").every((x) => x.path.startsWith(".devasign/tests/")));
    assert.ok(run.tokenUsage.plan, "plan usage recorded per provider");

    // The review's card is the body of the posted review and carries no
    // verification detail; the placeholder 4242 is removed once it lands.
    const posted = calls.find((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url));
    const body = String(posted!.body?.body);
    assert.ok(calls.some((c) => c.method === "DELETE" && /\/issues\/comments\/4242$/.test(c.url)));
    assert.match(body, /^## DevAsign Code Review/);
    assert.ok(!body.includes(VERIFICATION_START), "verification no longer lives in the review comment");

    // Nothing has finished yet, so no tests comment — the check run carries the
    // pending state instead of putting a nag on every PR.
    assert.ok(
      !calls.some((c) => c.method === "POST" && /Tests by DevAsign/.test(String(c.body?.body))),
      "no tests comment before verification finishes"
    );
    const checks = calls.filter((c) => c.method === "POST" && /\/check-runs$/.test(c.url)).map((c) => c.body).filter((c) => c.name !== "devasign/security");
    assert.deepEqual(checks.map((c) => c.name), ["DevAsign · End goal", "DevAsign · Verify"]);
    assert.equal(checks[1].conclusion, "neutral");
    assert.equal(checks[1].output.title, "Setup pending");
    assert.equal(db.find("prReviews", (r) => r.id === review.id)?.verifyCommentId, undefined);

    // Runner reports: first test passes, second fails on every attempt.
    const [first, second] = plan.tests;
    const req: any = {
      params: { runId: run.id },
      headers: {},
      runner: { claims: { repository: "acme/widgets", repository_id: "1", sha: "m", ref: "refs/pull/1/merge", event_name: "pull_request", run_id: "1" }, repo, install, plan: "free" },
      body: {
        runId: run.id, sha: "abc1234", planId: plan.id, cliVersion: "0.1.0", existingTestsTouchingDiff: [], timings: { startedAt: 1, finishedAt: 2 },
        results: [
          { id: "r1", testId: first.id, criterionIds: first.criterionIds, test: first.path, runner: first.runner, level: first.level, origin: first.origin, status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 3, artifactIds: [] }], durationMs: 3, artifactIds: [] },
          { id: "r2", testId: second.id, criterionIds: second.criterionIds, test: second.path, runner: second.runner, level: second.level, origin: second.origin, status: "fail", error: "expected refunds line", attempts: [1, 2, 3].map((n) => ({ n, status: "fail", durationMs: 2, artifactIds: [] })), durationMs: 6, artifactIds: [] },
        ],
      },
    };
    const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await resultsHandler(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "judging");
    assert.equal(db.find("verifyRuns", (r) => r.id === run.id)?.timings.resolvedAt, undefined);

    const judged = await runVerifyJudge(run.id);
    assert.equal(judged?.status, "completed");
    const byId = new Map(judged!.verdicts.map((v) => [v.criterionId, v.verdict]));
    assert.equal(byId.get(first.criterionIds[0]), "pass");
    assert.equal(byId.get(second.criterionIds[0]), "fail");

    // Verification finished, so now the tests comment appears — its own comment,
    // not an edit of the review's card.
    const testsCommentId = db.find("prReviews", (r) => r.id === review.id)!.verifyCommentId!;
    assert.equal(db.find("verifyRuns", (r) => r.id === run.id)?.report?.commentId, testsCommentId);
    const finalTests = comments.get(testsCommentId)!;
    assert.match(finalTests, /^## Tests by DevAsign/);
    assert.match(finalTests, /❌ `Failed \(1\)`/);
    assert.match(finalTests, /### (✅|🟡|🔴) Test score: \d{1,3}\/100/);
    assert.match(finalTests, /\*\*Verdict:\*\* FAIL/);
    assert.match(finalTests, /\[mock\] fail per the recorded test outcome/);
    assert.match(finalTests, /\*\*Test:\*\* `\.devasign\/tests\/criterion-2\.test\.ts`/);
    assert.match(finalTests, /<summary>Prompt to fix all failing tests<\/summary>/);
    assert.equal(finalTests.split(VERIFICATION_START).length, 2, "exactly one verification block");
    assert.match(String(judged!.verdicts.find((v) => v.verdict === "fail")?.reason), /\[mock\] fail/, "the judge's reason replaces the mechanical one for pass/fail");
    // Only one tests comment was ever created.
    const testsPosts = calls.filter(
      (c) => c.method === "POST" && /\/issues\/\d+\/comments$/.test(c.url) && /Tests by DevAsign/.test(String(c.body?.body))
    );
    assert.equal(testsPosts.length, 1, "exactly one tests comment for the run");
    // The review's card is untouched by verification.
    assert.ok(!comments.get(4242)!.includes(VERIFICATION_START));
    const verifyChecks = calls.filter((c) => c.method === "POST" && /\/check-runs$/.test(c.url) && c.body?.name === "DevAsign · Verify");
    assert.equal(verifyChecks.length, 2);
    assert.equal(verifyChecks[1].body.conclusion, "failure");
  } finally {
    restore();
  }
});

test("stages.verify=false → the branch is skipped, logged, and reported as disabled", async () => {
  const { review } = seedReview({ version: 1, stages: { verify: false } });
  const { calls, restore } = installFetchStub();
  try {
    await runReviewJob(review.id);
    assert.ok(db.find("reviewLogs", (l) => l.reviewId === review.id && l.action === VERIFY_STAGE_DISABLED));
    const run = db.find("verifyRuns", (r) => r.reviewId === review.id)!;
    assert.equal(run.status, "skipped");
    assert.equal(run.skipReason, "verify_disabled");
    const verify = calls.find((c) => c.method === "POST" && /\/check-runs$/.test(c.url) && c.body?.name === "DevAsign · Verify");
    assert.equal(verify?.body.output.title, "Verification disabled");
    const posted = calls.find((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url));
    // Nothing actionable to say, so no tests comment is posted; the check run
    // carries the state instead.
    assert.ok(
      !calls.some((c) => c.method === "POST" && /Tests by DevAsign/.test(String(c.body?.body))),
      "a disabled verify stage posts no tests comment"
    );
    assert.doesNotMatch(String(posted!.body?.body), /Verification is turned off/);
  } finally {
    restore();
  }
});

// A fork's `pull_request` workflow gets a read-only token and no OIDC token, so
// no runner can ever claim the run. Planning one only produced a 60-minute
// timeout and a misleading "the runner did not report results" on every push.
test("a PR from a fork is skipped up front instead of timing out an hour later", async () => {
  const { review } = seedReview();
  const { calls, comments, restore } = installFetchStub("contributor/widgets");
  try {
    await runReviewJob(review.id);
    const run = db.find("verifyRuns", (r) => r.reviewId === review.id)!;
    assert.equal(run.status, "skipped");
    assert.equal(run.skipReason, "fork_pr");
    assert.ok(!run.planId, "no plan is written for a run nothing can claim");
    assert.ok(db.filter("reviewLogs", (l) => l.reviewId === review.id).some((l) => l.action === VERIFY_FORK_PR));

    const body = [...comments.values()].at(-1) ?? "";
    assert.ok(
      !calls.some((c) => c.method === "POST" && /Tests by DevAsign/.test(String(c.body?.body))),
      "a fork PR posts no tests comment"
    );
    assert.doesNotMatch(body, /Verification does not run on pull requests from forks/);
    assert.doesNotMatch(body, /did not report results/);
    const verify = calls.filter((c) => c.method === "POST" && /\/check-runs$/.test(c.url)).map((c) => c.body).find((c) => c.name === "DevAsign · Verify");
    assert.equal(verify.conclusion, "neutral");
    assert.equal(verify.output.title, "Not run on fork PRs");
  } finally {
    restore();
    db.remove("verifyRuns", (r) => r.reviewId === review.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  }
});
