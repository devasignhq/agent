// Offline end-to-end for the single-comment contract: the review pipeline posts
// ONE "review in progress" comment per commit, persists its id + sha, and edits
// THAT comment into the emoji-free FULL verdict (criteria, suggestions, line
// notes) on finish. No formal PR review is ever submitted with a body — a pass
// is a bodyless APPROVE and a failure dismisses our stale approval — so the
// verdict comment is the run's entire conversation footprint. A rerun on the
// SAME sha reuses the comment; only a new sha (push) gets a fresh one.
//
// Fully offline: empty ANTHROPIC_API_KEY forces the LLM mock, and global.fetch is
// stubbed so every GitHub call (token, PR/diff/commits, git tree, check run,
// comment POST/PATCH, review dismissal) is captured rather than sent. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/progress-comment-flow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { runReviewJob } from "./pipeline.js";

type Call = { method: string; url: string; body: any; accept: string };

// PR comments are emoji-free by product decision.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

// A clean diff: no TODO/stub markers (so the deferral scan makes no LLM call) and
// one file path so the line-note filter keeps the mock's annotation.
const DIFF = [
  "diff --git a/src/handler.ts b/src/handler.ts",
  "index 1111111..2222222 100644",
  "--- a/src/handler.ts",
  "+++ b/src/handler.ts",
  "@@ -1,2 +1,3 @@",
  " export function handler() {",
  "+  return doWork();",
  " }",
].join("\n");

function ghResponse(body: any) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

// Install a fetch stub that records every call and answers each GitHub endpoint
// the pipeline touches. Comment-create POSTs return ids starting at firstCommentId
// (incrementing), so a later fresh comment gets a distinct id.
function installFetchStub(opts: { firstCommentId: number }) {
  const calls: Call[] = [];
  let nextCommentId = opts.firstCommentId;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const accept = String(headers.Accept || headers.accept || "");
    let body: any;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url: u, body, accept });

    if (u.includes("/access_tokens") && method === "POST")
      return ghResponse({ token: "tok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    // Create a PR/issue comment (".../issues/{n}/comments").
    if (/\/issues\/\d+\/comments$/.test(u) && method === "POST")
      return ghResponse({ id: nextCommentId++ });
    // Edit a comment in place (".../issues/comments/{id}").
    if (/\/issues\/comments\/\d+$/.test(u) && method === "PATCH") return ghResponse({});
    // Dismiss a stale approval (".../reviews/{id}/dismissals").
    if (/\/pulls\/\d+\/reviews\/\d+\/dismissals$/.test(u) && method === "PUT") return ghResponse({});
    if (/\/pulls\/\d+\/commits/.test(u) && method === "GET")
      return ghResponse([{ sha: "abc1234", commit: { message: "Add widget" } }]);
    if (/\/pulls\/\d+\/reviews$/.test(u) && method === "POST")
      return ghResponse({ id: 99, html_url: "https://github.com/acme/widgets/pull/1#pullrequestreview-99" });
    if (/\/pulls\/\d+$/.test(u) && method === "GET") {
      if (accept.includes("diff")) return ghResponse(DIFF);
      return ghResponse({
        title: "Add widget",
        body: "",
        head: { sha: "abc1234", ref: "feature" },
        base: { sha: "def5678" },
        additions: 1,
        deletions: 0,
        changed_files: 1,
        commits: 1,
      });
    }
    if (/\/git\/trees\//.test(u) && method === "GET") return ghResponse({ tree: [] });
    if (/\/check-runs$/.test(u) && method === "POST") return ghResponse({ id: 7 });
    return ghResponse({});
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Seed a PUBLIC repo (no private-repo gate), an install row, and a queued review.
function seedReview(extra: Record<string, unknown> = {}): string {
  const install = db.insert("installations", {
    id: uuid(),
    installationId: 12345,
    userId: "", // unlinked → frontier default model, no plan lookups
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: "widgets",
    private: false,
    reviewsEnabled: true,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    indexState: "none",
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 1,
    prTitle: "Add widget",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "queued",
    verdict: null,
    criteria: [],
    taskId: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  } as any);
  return review.id;
}

test("single comment per run: placeholder → emoji-free full verdict; no formal review posted", async () => {
  const id = seedReview();
  const { calls, restore } = installFetchStub({ firstCommentId: 4242 });
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }

  // 1. Placeholder comment created, emoji-free.
  const createCalls = calls.filter((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url));
  assert.equal(createCalls.length, 1, "exactly one conversation comment per run");
  assert.match(String(createCalls[0].body?.body), /PR Review In Progress/);
  assert.doesNotMatch(String(createCalls[0].body?.body), EMOJI);

  // 2. Its id + sha are persisted on the review row.
  const row = db.find("prReviews", (r) => r.id === id);
  assert.equal(row?.progressCommentId, 4242);
  assert.equal(row?.progressCommentSha, "abc1234");

  // 3. That exact comment is edited into the FULL verdict — headline, criteria
  //    sections, and the line-anchored notes folded in as "Line notes" — with
  //    no emoji anywhere (the mock review is spec'd + changes_requested).
  const patchCall = calls.find((c) => c.method === "PATCH" && /\/issues\/comments\/4242$/.test(c.url));
  assert.ok(patchCall, "expected a PATCH editing comment 4242 into the verdict");
  const verdictComment = String(patchCall!.body?.body);
  assert.match(verdictComment, /^## DevAsign review — changes requested/);
  assert.match(verdictComment, /## End goal|Acceptance criteria/);
  assert.match(verdictComment, /## Line notes/);
  assert.match(verdictComment, /`src\/handler\.ts:42`/);
  assert.doesNotMatch(verdictComment, EMOJI);

  // 4. NO formal PR review is submitted (a REQUEST_CHANGES body would render as
  //    an extra conversation comment), and with no stored approval there is
  //    nothing to dismiss.
  assert.ok(
    !calls.some((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url)),
    "no formal PR review may be posted"
  );
  assert.ok(
    !calls.some((c) => c.method === "PUT" && /\/dismissals$/.test(c.url)),
    "nothing to dismiss without a stored approval"
  );

  // 5. The Check Run still carries the merge gate.
  const check = calls.find((c) => c.method === "POST" && /\/check-runs$/.test(c.url));
  assert.ok(check, "check run must be (re)posted");
  assert.equal(check!.body?.conclusion, "action_required");
});

test("a failing run dismisses the stored stale approval", async () => {
  const id = seedReview({ approveReviewId: 777 });
  const { calls, restore } = installFetchStub({ firstCommentId: 6000 });
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }

  const dismiss = calls.find((c) => c.method === "PUT" && /\/pulls\/1\/reviews\/777\/dismissals$/.test(c.url));
  assert.ok(dismiss, "the stale approval must be dismissed");
  assert.match(String(dismiss!.body?.message), /approval no longer applies/i);
  assert.equal(
    db.find("prReviews", (r) => r.id === id)?.approveReviewId,
    null,
    "the dismissed approval id is cleared"
  );
  // Still no formal review POST.
  assert.ok(!calls.some((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url)));
});

test("rerun on the same commit reuses the comment; a new commit gets a fresh one", async () => {
  const id = seedReview();

  // First run → comment 5000 for sha abc1234.
  let stub = installFetchStub({ firstCommentId: 5000 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, 5000);

  // Second run, SAME sha (manual rerun) → no new comment; 5000 is reset to
  // in-progress and edited back into the verdict.
  stub = installFetchStub({ firstCommentId: 5001 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.ok(
    !stub.calls.some((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url)),
    "a same-sha rerun must not post a new comment"
  );
  const patches = stub.calls.filter((c) => c.method === "PATCH" && /\/issues\/comments\/5000$/.test(c.url));
  assert.ok(patches.length >= 2, "the existing comment cycles in-progress → verdict");
  assert.match(String(patches[0].body?.body), /PR Review In Progress/);
  assert.match(String(patches[patches.length - 1].body?.body), /^## DevAsign review —/);
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, 5000);

  // Third run after a push (new sha) → a FRESH comment, per the one-comment-
  // per-commit rule.
  db.update("prReviews", (r) => r.id === id, { headSha: "bbb7777" });
  stub = installFetchStub({ firstCommentId: 5001 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.ok(
    stub.calls.some((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url)),
    "a new sha gets its own announce→verdict comment"
  );
  const row = db.find("prReviews", (r) => r.id === id);
  assert.equal(row?.progressCommentId, 5001, "the row now tracks the new commit's comment id");
  assert.equal(row?.progressCommentSha, "bbb7777");
  assert.ok(
    stub.calls.find((c) => c.method === "PATCH" && /\/issues\/comments\/5001$/.test(c.url)),
    "the new comment (5001) is the one edited into the verdict"
  );
});
