// Offline end-to-end: the review pipeline posts a "review in progress" comment at
// run start, persists its id, and edits THAT comment into the FULL verdict on
// finish. The formal PR review is still posted, but its body is now just a one-line
// pointer — it exists only to carry the merge-gate event + inline comments. A fresh
// comment is posted per run, so a re-review on a new push gets its own
// announce→verdict comment.
//
// Fully offline: empty ANTHROPIC_API_KEY forces the LLM mock, and global.fetch is
// stubbed so every GitHub call (token, PR/diff/commits, git tree, check run, review,
// comment POST/PATCH) is captured rather than sent. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/progress-comment-flow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { runReviewJob } from "./pipeline.js";

type Call = { method: string; url: string; body: any; accept: string };

// A clean diff: no TODO/stub markers (so the deferral scan makes no LLM call) and
// one file path so the inline-comment filter keeps the mock's annotation.
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
// (incrementing), so a second run gets a distinct id.
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
function seedReview(): string {
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
  } as any);
  return review.id;
}

test("posts a 'review in progress' comment on start and edits it into the verdict", async () => {
  const id = seedReview();
  const { calls, restore } = installFetchStub({ firstCommentId: 4242 });
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }

  // 1. Placeholder comment created with the screenshot copy.
  const createCall = calls.find((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url));
  assert.ok(createCall, "expected a POST creating the PR comment");
  assert.match(String(createCall!.body?.body), /PR Review In Progress/);

  // 2. Its id is persisted on the review row.
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, 4242);

  // 3. That exact comment is edited into the FULL verdict — outcome headline plus
  //    the complete review body (end goal, criteria) — not a concise banner.
  const patchCall = calls.find((c) => c.method === "PATCH" && /\/issues\/comments\/4242$/.test(c.url));
  assert.ok(patchCall, "expected a PATCH editing comment 4242 into the verdict");
  const verdictComment = String(patchCall!.body?.body);
  assert.match(verdictComment, /DevAsign review —/);
  assert.match(verdictComment, /✅|🔴/);
  // The full verdict lives here now (the mock review is spec'd + changes_requested).
  assert.match(verdictComment, /## End goal|Acceptance criteria/);
  // …and it is NOT the formal review's one-line pointer.
  assert.doesNotMatch(verdictComment, /is in the pinned comment above/);

  // 4. The formal PR review is still posted (merge-gate event + inline comments),
  //    but its body is only the MINIMAL one-line pointer — the verdict is not
  //    duplicated there.
  const reviewCall = calls.find((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url));
  assert.ok(reviewCall, "the formal PR review must still be posted");
  assert.match(String(reviewCall!.body?.body), /pinned comment above/);
  assert.doesNotMatch(String(reviewCall!.body?.body), /## End goal/);
  // Inline line-level comments still ride on the formal review (the mock emits one
  // annotation against the single diff file).
  assert.ok(
    Array.isArray(reviewCall!.body?.comments) && reviewCall!.body.comments.length >= 1,
    "inline comments should still be attached to the formal review"
  );
});

test("a re-run posts a fresh comment and edits that one (one comment per run)", async () => {
  const id = seedReview();

  // First run → comment 5000.
  let stub = installFetchStub({ firstCommentId: 5000 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, 5000);

  // Second run (simulating a re-review on a new push) → a NEW comment 5001.
  stub = installFetchStub({ firstCommentId: 5001 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }

  assert.ok(
    stub.calls.find((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url)),
    "the second run must create a fresh comment"
  );
  assert.equal(
    db.find("prReviews", (r) => r.id === id)?.progressCommentId,
    5001,
    "the row now tracks the new run's comment id"
  );
  assert.ok(
    stub.calls.find((c) => c.method === "PATCH" && /\/issues\/comments\/5001$/.test(c.url)),
    "the second run must edit the NEW comment (5001), not the old one"
  );
});
