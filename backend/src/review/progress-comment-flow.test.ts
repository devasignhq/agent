// Offline end-to-end for the PR feedback contract: the review pipeline posts a
// "review in progress" conversation comment when a run starts, and on finish
// posts ONE review whose body is the summary card and whose comments are the
// inline threads — one per finding and acceptance criterion, anchored to the
// code it concerns — then deletes the placeholder so the review block takes
// its place. A rerun on the SAME sha edits that review's body; a new sha (push)
// gets a fresh review. Across pushes the threads are reconciled in place:
// still-reported items are edited, items that stop being reported are marked
// fixed.
//
// A pass is still a separate bodyless APPROVE and a failure dismisses our stale
// approval.
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
  // Hunk placed where the mock's findings point (line 42, evidence at 40), so
  // some items anchor to a line and ride in the batched review while the ones
  // further away (52) degrade to file level and are posted one at a time.
  "@@ -40,2 +40,3 @@",
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
    // ghPaged reads the Link header; none means a single page.
    headers: { get: () => null },
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

function installFetchStub(opts: { firstCommentId: number; firstThreadId?: number; firstReviewId?: number }) {
  const calls: Call[] = [];
  let nextCommentId = opts.firstCommentId;
  let nextThreadId = opts.firstThreadId ?? 900;
  // Bodies the pipeline wrote, so a later read-back (the "what this was" block on
  // a resolved thread) sees what it actually posted.
  const threadBodies = new Map<number, string>();
  // Comments carried by each batched review, served back by the listing.
  const reviewComments = new Map<number, Array<Record<string, unknown>>>();
  let nextReviewId = opts.firstReviewId ?? 99;
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
    // Edit a comment in place (".../issues/comments/{id}"), or delete it.
    if (/\/issues\/comments\/\d+$/.test(u) && method === "PATCH") return ghResponse({});
    if (/\/issues\/comments\/\d+$/.test(u) && method === "DELETE")
      return { ok: true, status: 204, json: async () => undefined, text: async () => "", headers: { get: () => null } } as any;
    // Edit a submitted review's body (".../reviews/{id}").
    if (/\/pulls\/\d+\/reviews\/\d+$/.test(u) && method === "PUT") return ghResponse({ id: Number(u.split("/").pop()) });
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
    if (/\/pulls\/\d+\/reviews\/\d+\/comments(\?|$)/.test(u) && method === "GET") {
      const rid = Number(/\/reviews\/(\d+)\/comments/.exec(u)![1]);
      return ghResponse(reviewComments.get(rid) ?? []);
    }
    if (/\/pulls\/\d+\/reviews$/.test(u) && method === "POST") {
      const rid = nextReviewId++;
      const comments = (Array.isArray(body?.comments) ? body.comments : []).map((c: any) => {
        const id = nextThreadId++;
        threadBodies.set(id, String(c.body));
        return { id, body: c.body, path: c.path, line: c.line ?? null };
      });
      reviewComments.set(rid, comments);
      return ghResponse({ id: rid, html_url: `https://github.com/acme/widgets/pull/1#pullrequestreview-${rid}` });
    }
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

  // 2. The placeholder is gone once the review posts: its id is cleared, the
  //    sha is kept (it is the new-commit signal), and the review is recorded.
  const row = db.find("prReviews", (r) => r.id === id);
  assert.equal(row?.progressCommentId, null);
  assert.equal(row?.progressCommentSha, "abc1234");
  assert.equal(row?.summaryReviewId, 99);
  assert.equal(row?.summaryReviewSha, "abc1234");
  assert.ok(
    !calls.some((c) => c.method === "PATCH" && /\/issues\/comments\/4242$/.test(c.url)),
    "the placeholder is never edited into the card when the review posts"
  );

  // 3. The summary card is the BODY of the one review that carries the threads:
  //    title, chips, merge score, and a short summary — NOT a wall of findings.
  const reviews = calls.filter((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url));
  assert.equal(reviews.length, 1, "the card and every line-anchored thread ride in one review");
  const review = reviews[0];
  assert.equal(review.body?.event, "COMMENT");
  const card = String(review.body?.body);
  assert.match(card, /^## DevAsign Code Review/);
  assert.match(card, /### (✅|🟡|🔴) Merge score: \d{1,3}\/100/);
  assert.match(card, /`(Criteria not met|Bugs|Nitpicks|Security|No issues found) \(?\d*\)?`/);
  assert.doesNotMatch(card, /### Acceptance criteria not met/, "detail belongs on the threads now");
  assert.doesNotMatch(card, /### Line notes/);
  assert.doesNotMatch(card, /devasign:item/, "the card is not a thread");
  const del = calls.find((c) => c.method === "DELETE" && /\/issues\/comments\/4242$/.test(c.url));
  assert.ok(del, "the placeholder is deleted");
  assert.ok(calls.indexOf(del!) > calls.indexOf(review), "…only after the review has landed");

  // 4. The detail is on the review's inline threads, each carrying its item
  //    marker and collapsed under its heading.
  assert.equal(review.body?.commit_id, "abc1234", "threads anchor to the reviewed commit");
  const batched: any[] = review.body?.comments ?? [];
  assert.ok(batched.length > 0, "findings must land as inline review comments");
  for (const t of batched) {
    assert.match(String(t.body), /^<!-- devasign:item v1 k=/, "every thread is identifiable");
    assert.match(String(t.body), /^<details>\n<summary>/m, "every thread is collapsed by default");
    assert.ok(t.path, "every thread names a file");
    assert.equal(typeof t.line, "number");
    assert.equal(t.side, "RIGHT");
  }
  // comments[] cannot carry a file-level anchor, so those stay separate posts.
  const singles = calls.filter((c) => c.method === "POST" && /\/pulls\/1\/comments$/.test(c.url));
  for (const t of singles) {
    assert.equal(t.body?.subject_type, "file", "only file-level threads are posted one at a time");
    assert.match(String(t.body?.body), /^<!-- devasign:item v1 k=/);
    assert.equal(t.body?.commit_id, "abc1234");
  }
  const noteThread = [...batched, ...singles.map((c) => c.body)].find((t) =>
    String(t.body).includes("src/handler.ts")
  );
  assert.ok(noteThread, "the line-anchored note reached a thread");

  // 5. Thread state is persisted — with the ids the batched review's listing
  //    reported — so the next push can edit rather than duplicate.
  const stored = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  assert.equal(stored.length, batched.length + singles.length);
  assert.ok(stored.every((t) => t.state === "open" && t.commentId >= 900));
  assert.ok(
    calls.some((c) => c.method === "GET" && /\/pulls\/1\/reviews\/\d+\/comments/.test(c.url)),
    "comment ids come from the review's listing"
  );
  assert.equal(db.find("prReviews", (r) => r.id === id)?.threadsNeedRecovery, undefined);

  // 6. The only review is the COMMENT one carrying the threads — no approval or
  //    change request — and with no stored approval there is nothing to dismiss.
  assert.ok(
    reviews.every((c) => c.body?.event === "COMMENT"),
    "no APPROVE / REQUEST_CHANGES review may be posted"
  );
  assert.ok(!calls.some((c) => c.method === "PUT" && /\/dismissals$/.test(c.url)));

  // 7. The Check Run still carries the merge gate — and is posted before the
  //    threads, so a thread stall can never delay it.
  const check = calls.find((c) => c.method === "POST" && /\/check-runs$/.test(c.url));
  assert.ok(check, "check run must be (re)posted");
  assert.equal(check!.body?.conclusion, "action_required");
  assert.ok(
    calls.indexOf(check!) < calls.indexOf(review),
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
  // Still no approval / change-request review — only the COMMENT one carrying threads.
  assert.ok(
    !calls.some(
      (c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url) && c.body?.event !== "COMMENT"
    )
  );
});

test("rerun on the same commit reuses the comment; a new commit gets a fresh one", async () => {
  const id = seedReview();

  // First run → review 99 for sha abc1234; placeholder 5000 posted then deleted.
  let stub = installFetchStub({ firstCommentId: 5000, firstReviewId: 99 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  assert.equal(db.find("prReviews", (r) => r.id === id)?.summaryReviewId, 99);
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, null);

  // Second run, SAME sha (manual rerun) → a fresh placeholder (the last one was
  // deleted), review 99's body is edited in place, no second review block.
  stub = installFetchStub({ firstCommentId: 5001, firstReviewId: 100 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  const placeholder = stub.calls.find((c) => c.method === "POST" && /\/issues\/1\/comments$/.test(c.url));
  assert.ok(placeholder, "a rerun announces itself again");
  assert.match(String(placeholder!.body?.body), /Review in progress/);
  assert.ok(
    !stub.calls.some((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url)),
    "a same-sha rerun must not post a second review"
  );
  const put = stub.calls.filter((c) => c.method === "PUT" && /\/pulls\/1\/reviews\/99$/.test(c.url));
  assert.equal(put.length, 1, "the existing review's body is edited instead");
  assert.match(String(put[0].body?.body), /### (✅|🟡|🔴) Merge score:/);
  assert.ok(
    stub.calls.some((c) => c.method === "DELETE" && /\/issues\/comments\/5001$/.test(c.url)),
    "the rerun's placeholder is deleted too"
  );
  // A same-sha rerun is not a new push: existing threads are edited, never
  // duplicated, and nothing is marked fixed.
  assert.ok(
    !stub.calls.some((c) => c.method === "POST" && /\/pulls\/1\/comments$/.test(c.url)),
    "a same-sha rerun must not open duplicate threads"
  );
  assert.equal(db.find("prReviews", (r) => r.id === id)?.summaryReviewId, 99);
  assert.equal(db.find("prReviews", (r) => r.id === id)?.progressCommentId, null);

  // Third run after a push (new sha) → a FRESH review, per the one-review-per-
  // commit rule.
  db.update("prReviews", (r) => r.id === id, { headSha: "bbb7777" });
  stub = installFetchStub({ firstCommentId: 5002, firstReviewId: 101 });
  try {
    await runReviewJob(id);
  } finally {
    stub.restore();
  }
  const posted = stub.calls.find((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url));
  assert.ok(posted, "a new sha gets its own review");
  assert.equal(posted!.body?.commit_id, "bbb7777");
  assert.match(String(posted!.body?.body), /### (✅|🟡|🔴) Merge score:/);
  const row = db.find("prReviews", (r) => r.id === id);
  assert.equal(row?.summaryReviewId, 101, "the row now tracks the new commit's review");
  assert.equal(row?.summaryReviewSha, "bbb7777");
  assert.equal(row?.progressCommentId, null);
  assert.equal(row?.progressCommentSha, "bbb7777");
  assert.ok(
    stub.calls.some((c) => c.method === "DELETE" && /\/issues\/comments\/5002$/.test(c.url)),
    "the new placeholder (5002) is deleted once the review lands"
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
  assert.ok(
    !stub.calls.some(
      (c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url) && c.body?.comments?.length
    ),
    "nor ride in a new batched review"
  );
  assert.ok(
    stub.calls.some(
      (c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url) && c.body?.comments?.length === 0 && c.body?.body
    ),
    "the new commit's card still posts, as a body-only review"
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
  assert.match(resolvedBody, /<summary>✅ Fixed —/);
  assert.match(resolvedBody, /no longer appears in the review of `ccc8888`/);
  assert.match(resolvedBody, /\*\*What this was\*\*/);

  const finalThreads = db.find("prReviews", (r) => r.id === id)?.reviewThreads ?? [];
  const gone = finalThreads.find((t) => t.commentId === 4321);
  assert.equal(gone?.state, "resolved");
  assert.equal(gone?.resolvedAtSha, "ccc8888");

  // And the card counts it as fixed while still reporting what remains open.
  const card = String(
    stub.calls.filter((c) => c.method === "POST" && /\/pulls\/1\/reviews$/.test(c.url)).pop()?.body?.body
  );
  assert.match(card, /✅ `Fixed since last review \(1\)`/);
});
