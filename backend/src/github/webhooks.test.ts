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

// Keep the github_app_authorization → purgeAccount path hermetic: with the
// GitHub App / Stripe guards off, purgeAccount skips the real uninstall + cancel
// network calls (and the email helper no-ops without a key) and only does the
// local row wipe. The PR-flow tests below don't depend on these being set.
config.github.appId = "";
config.github.privateKey = "";
config.stripe.secretKey = "";

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

function deliver(event: any, opts: { guid?: string; type?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  const headers: Record<string, string> = {
    "X-GitHub-Event": opts.type || "pull_request",
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

// ── Tier-gated triggering ───────────────────────────────────────────────────
// The unlinked-install tests above seed `installationId: uuid()` (no install
// row → onboarding grace → review everything). The tests below seed a *linked*
// account so the who-opened-it gate actually fires.

let linkSeq = 0;
function seedLinkedRepo(opts: {
  plan: "free" | "pro" | "max";
  ownerLogin: string;
  ownerGithubId?: number | null;
}) {
  const userId = uuid();
  db.insert("users", {
    id: userId,
    githubId: opts.ownerGithubId ?? null,
    githubLogin: opts.ownerLogin,
    email: `${opts.ownerLogin}@example.com`,
    plan: opts.plan,
    createdAt: Date.now(),
  } as any);
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan: opts.plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: opts.plan === "free" ? null : "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  const instId = uuid();
  db.insert("installations", {
    id: instId,
    userId,
    accountId: 1000 + linkSeq,
    accountLogin: "acme",
    installationId: 999,
    repoIds: [],
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: instId,
    owner: "acme",
    name: `linked-${linkSeq++}`,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
  return { userId, repo };
}

function commentEvent(repo: any, opts: {
  body: string;
  authorLogin: string;
  authorId?: number;
  authorAssociation?: string;
  prNumber?: number;
}) {
  return {
    action: "created",
    repository: { full_name: `${repo.owner}/${repo.name}` },
    installation: { id: 999 },
    sender: { type: "User", login: opts.authorLogin },
    issue: {
      number: opts.prNumber ?? 7,
      pull_request: { url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/7` },
    },
    comment: {
      body: opts.body,
      user: { login: opts.authorLogin, id: opts.authorId },
      author_association: opts.authorAssociation ?? "MEMBER",
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/7#issuecomment-1`,
    },
  };
}

test("Free: a PR the owner opened is reviewed; anyone else's is not", () => {
  const { repo } = seedLinkedRepo({ plan: "free", ownerLogin: "alice" });

  // Owner-authored → materialized + queued.
  deliver(prEvent(repo, "opened", { user: { login: "alice", type: "User" } }));
  assert.equal(rowsFor(repo, 7).length, 1);

  // Someone else's PR on the same repo → no row, no checkout.
  deliver(prEvent(repo, "opened", { number: 8, user: { login: "bob", type: "User" } }));
  assert.equal(rowsFor(repo, 8).length, 0);
});

test("Max: a team member's PR is reviewed; an outsider's is not", () => {
  const { repo } = seedLinkedRepo({ plan: "max", ownerLogin: "alice" });

  // Org member (author_association MEMBER) → reviewed even though not the owner.
  deliver(prEvent(repo, "opened", {
    number: 10,
    user: { login: "teammate", type: "User" },
    author_association: "MEMBER",
  }));
  assert.equal(rowsFor(repo, 10).length, 1);

  // Outside contributor → not auto-reviewed (awaits a "review" comment).
  for (const [n, assoc] of [[11, "CONTRIBUTOR"], [12, "NONE"]] as const) {
    deliver(prEvent(repo, "opened", {
      number: n,
      user: { login: "stranger", type: "User" },
      author_association: assoc,
    }));
    assert.equal(rowsFor(repo, n).length, 0, `assoc=${assoc}`);
  }
});

test("issue_comment: no review starts unless the owner comments the trigger word", () => {
  const { repo } = seedLinkedRepo({ plan: "free", ownerLogin: "alice" });

  // Owner comments something that isn't the trigger → ignored, no checkout.
  deliver(
    commentEvent(repo, { body: "looks good", authorLogin: "alice", authorAssociation: "OWNER" }),
    { type: "issue_comment" }
  );
  assert.equal(rowsFor(repo, 7).length, 0);

  // A non-owner maintainer comments the trigger word → still ignored.
  deliver(
    commentEvent(repo, { body: "review", authorLogin: "bob", authorAssociation: "MEMBER" }),
    { type: "issue_comment" }
  );
  assert.equal(rowsFor(repo, 7).length, 0);
});

test("issue_comment: a comment on a PR already under review still enqueues feedback", () => {
  const { repo } = seedLinkedRepo({ plan: "free", ownerLogin: "alice" });
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Add widget",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "passed",
    verdict: "passed",
    criteria: [],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);

  const before = queueSnapshot().reviews;
  deliver(
    commentEvent(repo, { body: "please also check the error path", authorLogin: "carol", authorAssociation: "COLLABORATOR" }),
    { type: "issue_comment" }
  );
  // Feedback enqueued onto the existing review; the comment is logged.
  assert.equal(queueSnapshot().reviews, before + 1);
  assert.equal(rowsFor(repo, 7).length, 1); // no duplicate row
  const received = db.filter(
    "reviewLogs",
    (l) => l.reviewId === review.id && l.action === "comment.received"
  );
  assert.equal(received.length, 1);
});

// ── github_app_authorization (OAuth grant revoked → delete account) ──────────

function authRevokedEvent(senderId: number | undefined, action = "revoked") {
  return { action, sender: { id: senderId, login: "someone" } };
}

// purgeAccount runs in the webhook's async tail, so let it settle before asserting.
const flush = () => new Promise((r) => setImmediate(r));

test("github_app_authorization revoked: deletes the revoking user's account immediately", async () => {
  const gh = 50_000 + linkSeq;
  const { userId } = seedLinkedRepo({ plan: "pro", ownerLogin: "alice", ownerGithubId: gh });
  // Sanity: the full account graph exists before the revoke.
  assert.equal(db.filter("users", (u) => u.id === userId).length, 1);
  assert.equal(db.filter("subscriptions", (s) => s.userId === userId).length, 1);
  assert.equal(db.filter("installations", (i) => i.userId === userId).length, 1);

  deliver(authRevokedEvent(gh), { type: "github_app_authorization" });
  await flush();

  assert.equal(db.filter("users", (u) => u.id === userId).length, 0, "user wiped");
  assert.equal(db.filter("subscriptions", (s) => s.userId === userId).length, 0, "subscription wiped");
  assert.equal(db.filter("installations", (i) => i.userId === userId).length, 0, "installation wiped");
});

test("github_app_authorization revoked: unknown sender is a no-op, other accounts untouched", async () => {
  const gh = 60_000 + linkSeq;
  const { userId } = seedLinkedRepo({ plan: "pro", ownerLogin: "bob", ownerGithubId: gh });

  // A revoke for a github id we have no user for — must not throw or touch others.
  deliver(authRevokedEvent(gh + 1), { type: "github_app_authorization" });
  await flush();

  assert.equal(db.filter("users", (u) => u.id === userId).length, 1, "unrelated account intact");
});

test("github_app_authorization: a non-revoked action is ignored", async () => {
  const gh = 70_000 + linkSeq;
  const { userId } = seedLinkedRepo({ plan: "pro", ownerLogin: "carol", ownerGithubId: gh });

  // GitHub only sends "revoked" for this event, but guard the switch anyway.
  deliver(authRevokedEvent(gh, "created"), { type: "github_app_authorization" });
  await flush();

  assert.equal(db.filter("users", (u) => u.id === userId).length, 1, "account untouched");
});
