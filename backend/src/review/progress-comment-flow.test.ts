// Offline end-to-end for the PR feedback contract: the review pipeline posts ONE
// "review in progress" conversation comment per commit, persists its id + sha,
// and edits THAT comment into the summary card on finish — while every
// individual finding and acceptance criterion lands as its own inline review
// comment thread, anchored to the code it concerns. A rerun on the SAME sha
// reuses the card comment; only a new sha (push) gets a fresh one. Across pushes
// the threads are reconciled in place: still-reported items are edited, items
// that stop being reported are marked fixed.
//
// No formal PR review is ever submitted with a body — a pass is a bodyless
// APPROVE and a failure dismisses our stale approval.
//
// Fully offline: empty ANTHROPIC_API_KEY forces the LLM mock, and global.fetch is
// stubbed so every GitHub call (token, PR/diff/commits, git tree, check run,
// conversation comment POST/PATCH, review-comment POST/PATCH/GET, review
// dismissal) is captured rather than sent. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/progress-comment-flow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { runReviewJob } from "./pipeline.js";

// Every GitHub call in the pipeline authenticates through appJWT(), which refuses
// to sign unless the App is configured (github/app.ts). To keep this suite "fully
// offline" (above) without leaning on a real backend/.env, hand it a throwaway App
// id + RSA key: the signed JWT is never sent (fetch is stubbed below), it only has
// to sign without throwing. Without this the suite silently depends on ambient App
// creds and fails in a clean checkout / CI.
config.github.appId = "123456";
config.github.privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

type Call = { method: string; url: string; body: any; accept: string };

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
// The head sha the stubbed PR reports. The pipeline compares it against the row
// it is reviewing to detect a push that landed mid-run, so it has to track the
// row rather than being pinned to the first commit.
let stubHeadSha = "abc1234";
function currentHeadSha() {
  return stubHeadSha;
}

function installFetchStub(opts: { firstCommentId: number; firstThreadId?: number }) {
  const calls: Call[] = [];
  let nextCommentId = opts.firstCommentId;
  let nextThreadId = opts.firstThreadId ?? 900;
  // Bodies the pipeline wrote, so a later read-back (the "what this was" block on
  // a resolved thread) sees what it actually posted.
  const threadBodies = new Map<number, string>();
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
    {
      const m = /\/pulls\/comments\/(\d+)$/.exec(u);
      if (m && method === "PATCH" && typeof body?.body === "string") {
        threadBodies.set(Number(m[1]), body.body);
      }
    }

    if (u.includes("/access_tokens") && method === "POST")
      return ghResponse({ token: "tok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    // Create a PR/issue comment (".../issues/{n}/comments").
    if (/\/issues\/\d+\/comments$/.test(u) && method === "POST")
      return ghResponse({ id: nextCommentId++ });
    // Edit a comment in place (".../issues/comments/{id}").
    if (/\/issues\/comments\/\d+$/.test(u) && method === "PATCH") return ghResponse({});
    // Dismiss a stale approval (".../reviews/{id}/dismissals").
    if (/\/pulls\/\d+\/reviews\/\d+\/dismissals$/.test(u) && method === "PUT") return ghResponse({});
    // Inline review-comment threads. Ordered before the /pulls/{n} matcher below
    // and anchored so "/pulls/1/comments" can't be caught by another rule.
    if (/\/pulls\/\d+\/comments(\?|$)/.test(u) && method === "POST")
      return ghResponse({ id: nextThreadId++, path: body?.path, line: body?.line ?? null });
    if (/\/pulls\/\d+\/comments(\?|$)/.test(u) && method === "GET") return ghResponse([]);
    if (/\/pulls\/comments\/\d+$/.test(u) && method === "PATCH") return ghResponse({});
    if (/\/pulls\/comments\/\d+$/.test(u) && method === "GET")
      return ghResponse({ body: threadBodies.get(Number(u.split("/").pop())) ?? "<!-- prior body -->" });
    if (/\/pulls\/\d+\/commits/.test(u) && method === "GET")
      return ghResponse([{ sha: "abc1234", commit: { message: "Add widget" } }]);
    if (/\/pulls\/\d+\/reviews$/.test(u) && method === "POST")
      return ghResponse({ id: 99, html_url: "https://github.com/acme/widgets/pull/1#pullrequestreview-99" });
    if (/\/pulls\/\d+$/.test(u) && method === "GET") {
      if (accept.includes("diff")) return ghResponse(DIFF);
      return ghResponse({
        title: "Add widget",
        body: "",
        state: "open",
        head: { sha: currentHeadSha(), ref: "feature" },
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

test("placeholder → summary card, with every finding as its own inline thread", async () => {
  const id = seedReview();
  const { calls, restore } = installFetchStub({ firstCommentId: 4242 });
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }

  // 1. Exactly one conversation comment: the placeholder.
  // One review comment per run. Verification, when it finishes, gets its own
  // separate "Tests by DevAsign" comment — never an edit of this one.
  const createCalls = calls.filter((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url));
  assert.equal(createCalls.length, 1, "exactly one conversation comment per run");
  assert.ok(!createCalls.some((c) => /Tests by DevAsign/.test(String(c.body?.body))));
  assert.match(String(createCalls[0].body?.body), /## DevAsign Code Review/);
  assert.match(String(createCalls[0].body?.body), /Review in progress/);

  // 2. Its id + sha are persisted on the review row.
  const row = db.find("prReviews", (r) => r.id === id);
  assert.equal(row?.progressCommentId, 4242);
  assert.equal(row?.progressCommentSha, "abc1234");

  // 3. That exact comment becomes the summary card: title, chips, merge score,
  //    and a short summary — NOT the old wall of every finding.
  const patchCall = calls.find((c) => c.method === "PATCH" && /\/issues\/comments\/4242$/.test(c.url));
  assert.ok(patchCall, "expected a PATCH editing comment 4242 into the card");
  const card = String(patchCall!.body?.body);
  assert.match(card, /^## DevAsign Code Review/);
  assert.match(card, /### (✅|🟡|🔴) Merge score: \d{1,3}\/100/);
  assert.match(card, /`(Criteria not met|Bugs|Nitpicks|Security|No issues found) \(?\d*\)?`/);
  assert.doesNotMatch(card, /### Acceptance criteria not met/, "detail belongs on the threads now");
  assert.doesNotMatch(card, /### Line notes/);

  // 4. The detail is on inline threads instead, each carrying its item marker.
  const threads = calls.filter((c) => c.method === "POST" && /\/pulls\/1\/comments$/.test(c.url));
  assert.ok(threads.length > 0, "findings must land as inline review comments");
  for (const t of threads) {
    assert.match(String(t.body?.body), /^<!-- devasign:item v1 k=/, "every thread is identifiable");
    assert.equal(t.body?.commit_id, "abc1234", "threads anchor to the reviewed commit");
    assert.ok(t.body?.path, "every thread names a file");
  }
  // The mock's line note points past the diff, so it degrades to a file-level
  // comment rather than 422-ing.
  const noteThread = threads.find((t) => String(t.body?.body).includes("src/handler.ts"));
  assert.ok(noteThread, "the line-anchored note reached a thread");

  // 5. Thread state is persisted so the next push can edit rather than duplicate.
  const stored = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  assert.equal(stored.length, threads.length);
  assert.ok(stored.every((t) => t.state === "open" && t.commentId >= 900));

  // 6. NO formal PR review is submitted, and with no stored approval there is
  //    nothing to dismiss.
  assert.ok(
    !calls.some((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url)),
    "no formal PR review may be posted"
  );
  assert.ok(!calls.some((c) => c.method === "PUT" && /\/dismissals$/.test(c.url)));

  // 7. The Check Run still carries the merge gate — and is posted before the
  //    threads, so a thread stall can never delay it.
  const check = calls.find((c) => c.method === "POST" && /\/check-runs$/.test(c.url));
  assert.ok(check, "check run must be (re)posted");
  assert.equal(check!.body?.conclusion, "action_required");
  assert.ok(
    calls.indexOf(check!) < calls.indexOf(threads[0]),
    "the merge gate must not wait on inline threads"
  );
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
  assert.ok(patches.length >= 2, "the existing comment cycles in-progress → card");
  assert.match(String(patches[0].body?.body), /Review in progress/);
  assert.match(String(patches[patches.length - 1].body?.body), /### (✅|🟡|🔴) Merge score:/);
  // A same-sha rerun is not a new push: existing threads are edited, never
  // duplicated, and nothing is marked fixed.
  assert.ok(
    !stub.calls.some((c) => c.method === "POST" && /\/pulls\/1\/comments$/.test(c.url)),
    "a same-sha rerun must not open duplicate threads"
  );
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
    "the new comment (5001) is the one edited into the card"
  );
});

test("across a push, threads are edited in place and a vanished finding is marked fixed", async () => {
  const id = seedReview();

  // Run 1 on abc1234 — opens a thread per item.
  stubHeadSha = "abc1234";
  let stub = installFetchStub({ firstCommentId: 7000, firstThreadId: 800 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  const afterFirst = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  assert.ok(afterFirst.length > 0, "run 1 opened threads");
  const openedIds = afterFirst.map((t) => t.commentId).sort();

  // Push a new commit and re-run. The mock returns the same verdict, so every
  // item is still reported: each thread is edited (or left alone), never
  // duplicated, and nothing is announced as fixed.
  db.update("prReviews", (r) => r.id === id, { headSha: "bbb7777", lastReviewedSha: "abc1234" });
  stubHeadSha = "bbb7777";
  stub = installFetchStub({ firstCommentId: 7001, firstThreadId: 850 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.ok(
    !stub.calls.some((c) => c.method === "POST" && /\/pulls\/1\/comments$/.test(c.url)),
    "an unchanged finding must reuse its thread, not open a second one"
  );
  const afterSecond = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  assert.deepEqual(
    afterSecond.map((t) => t.commentId).sort(),
    openedIds,
    "the same threads survive the push"
  );
  assert.ok(afterSecond.every((t) => t.state === "open"));
  assert.ok(afterSecond.every((t) => t.lastSeenSha === "bbb7777"));

  // Now push a commit that resolves everything: an empty diff would make every
  // item look gone for the wrong reason, so instead drop the findings by
  // reviewing a PR whose stages all still run but report nothing. Simulate that
  // by clearing the row's criteria and letting the mock's verdict stand: the
  // stored threads whose keys are no longer produced get marked fixed.
  const stale = db.find("prReviews", (r) => r.id === id)!;
  db.update("prReviews", (r) => r.id === id, {
    headSha: "ccc8888",
    lastReviewedSha: "bbb7777",
    reviewThreads: [
      ...(stale.reviewThreads ?? []),
      {
        key: "src/handler.ts::agonefinding",
        commentId: 4321,
        state: "open",
        itemState: "open",
        title: "A finding that is now gone",
        category: "defect",
        severity: "blocker",
        stage: "defects",
        path: "src/handler.ts",
        line: 2,
        anchor: "line",
        firstSeenSha: "abc1234",
        lastSeenSha: "bbb7777",
        missCount: 0,
        bodyHash: "stale",
        updatedAt: Date.now(),
      },
    ],
  } as any);
  stubHeadSha = "ccc8888";
  stub = installFetchStub({ firstCommentId: 7002, firstThreadId: 870 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  stubHeadSha = "abc1234";

  const resolvePatch = stub.calls.find(
    (c) => c.method === "PATCH" && /\/pulls\/comments\/4321$/.test(c.url)
  );
  assert.ok(resolvePatch, "the vanished finding's thread must be edited, not left shouting");
  const resolvedBody = String(resolvePatch!.body?.body);
  assert.match(resolvedBody, /devasign:resolved sha=ccc8888/);
  assert.match(resolvedBody, /### ✅ Fixed —/);
  assert.match(resolvedBody, /no longer appears in the review of `ccc8888`/);
  assert.match(resolvedBody, /<summary>What this was<\/summary>/);

  const finalThreads = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  const gone = finalThreads.find((t) => t.commentId === 4321);
  assert.equal(gone?.state, "resolved");
  assert.equal(gone?.resolvedAtSha, "ccc8888");

  // And the card counts it as fixed while still reporting what remains open.
  const card = String(
    stub.calls.filter((c) => c.method === "PATCH" && /\/issues\/comments\/\d+$/.test(c.url)).pop()
      ?.body?.body
  );
  assert.match(card, /✅ `Fixed since last review \(1\)`/);
});
