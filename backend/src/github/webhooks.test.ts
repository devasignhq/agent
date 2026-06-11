// Offline regression tests for duplicate-review prevention: one prReviews row
// per PR no matter how the work arrives (webhook redelivery, reopen, draft →
// ready, or the dashboard sync racing the `opened` webhook). Drives the REAL
// handleWebhook with stub req/res against the in-memory db; deliveries are
// HMAC-signed with whatever GITHUB_APP_WEBHOOK_SECRET dotenv loaded (an unset
// secret skips verification), and seeding no install row means no
// notification/plan-gate paths fire. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/github/webhooks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { handleWebhook } from "./webhooks.js";
import { queueSnapshot } from "../queue.js";

let repoSeq = 0;
function seedRepo() {
  return db.insert("repositories", {
    id: uuid(),
    installationId: uuid(), // no install row → no notifications, no plan gates
    owner: "acme",
    name: `widgets-${repoSeq++}`,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
}

function prEvent(repo: any, action: string, pr: Record<string, unknown> = {}) {
  return {
    action,
    repository: {
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: "main",
      private: false,
    },
    installation: { id: 999 },
    sender: { login: "alice", type: "User" },
    pull_request: {
      number: 7,
      title: "Add widget",
      draft: false,
      user: { login: "alice", type: "User" },
      head: { sha: "abc1234", ref: "feature" },
      base: { sha: "def5678", ref: "main" },
      additions: 10,
      deletions: 2,
      changed_files: 1,
      ...pr,
    },
  };
}

function deliver(event: any, opts: { guid?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  const headers: Record<string, string> = {
    "X-GitHub-Event": "pull_request",
    "X-GitHub-Delivery": opts.guid || uuid(),
  };
  if (config.github.webhookSecret) {
    headers["X-Hub-Signature-256"] =
      "sha256=" +
      crypto.createHmac("sha256", config.github.webhookSecret).update(raw).digest("hex");
  }
  const req = {
    header: (n: string) => headers[n],
    body: raw,
  } as any;
  const out: { status: number; json: any } = { status: 200, json: null };
  const res = {
    status(c: number) {
      out.status = c;
      return this;
    },
    send() {
      return this;
    },
    json(b: any) {
      out.json = b;
      return this;
    },
  } as any;
  handleWebhook(req, res);
  return out;
}

function rowsFor(repo: any, prNumber: number) {
  return db.filter("prReviews", (r) => r.repoId === repo.id && r.prNumber === prNumber);
}

test("redelivered webhook (same X-GitHub-Delivery GUID) is dropped", () => {
  const repo = seedRepo();
  const guid = uuid();
  const first = deliver(prEvent(repo, "opened"), { guid });
  assert.equal(first.json?.duplicate, undefined);
  assert.equal(rowsFor(repo, 7).length, 1);

  const second = deliver(prEvent(repo, "opened"), { guid });
  assert.equal(second.json?.duplicate, true);
  assert.equal(rowsFor(repo, 7).length, 1);
});

test("`opened` racing the dashboard sync reuses the row sync inserted", () => {
  const repo = seedRepo();
  // The /reviews/sync poll discovered the PR first and inserted its row.
  const synced = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Add widget",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "queued",
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);

  const before = queueSnapshot().reviews;
  deliver(prEvent(repo, "opened"));
  const rows = rowsFor(repo, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, synced.id);
  // Same sha already queued — the webhook must not enqueue a second run.
  assert.equal(queueSnapshot().reviews, before);
});

test("`reopened` re-queues the existing row instead of inserting a duplicate", () => {
  const repo = seedRepo();
  deliver(prEvent(repo, "opened"));
  const [row] = rowsFor(repo, 7);
  // The original run finished with a verdict before the PR was reopened.
  db.update("prReviews", (r) => r.id === row.id, { status: "passed" });

  deliver(prEvent(repo, "reopened"));
  const rows = rowsFor(repo, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].status, "queued");
  const requeues = db.filter(
    "reviewLogs",
    (l) => l.reviewId === row.id && l.action === "review.requeue"
  );
  assert.equal(requeues.length, 1);
});

test("draft `opened` then `ready_for_review` keeps a single row", () => {
  const repo = seedRepo();
  deliver(prEvent(repo, "opened", { draft: true }));
  assert.equal(rowsFor(repo, 7).length, 1);
  const [row] = rowsFor(repo, 7);

  // Still queued from `opened` → ready_for_review is covered by the in-flight run.
  deliver(prEvent(repo, "ready_for_review"));
  assert.equal(rowsFor(repo, 7).length, 1);

  // After the run completes, ready_for_review re-queues the same row.
  db.update("prReviews", (r) => r.id === row.id, { status: "changes_requested" });
  deliver(prEvent(repo, "ready_for_review"));
  const rows = rowsFor(repo, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued");
});

test("a new commit sha on `opened` redelivery updates the row in place", () => {
  const repo = seedRepo();
  deliver(prEvent(repo, "opened"));
  const [row] = rowsFor(repo, 7);
  db.update("prReviews", (r) => r.id === row.id, { status: "passed" });

  deliver(prEvent(repo, "opened", { head: { sha: "fff9999", ref: "feature" } }));
  const rows = rowsFor(repo, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].headSha, "fff9999");
  assert.equal(rows[0].status, "queued");
});
