// Integration test: a review triggered by the account owner commenting "review"
// consumes one of their monthly reviews, exactly like an auto-reviewed PR — and
// is dropped when they're already at the cap. Drives the REAL handleWebhook
// (issue_comment) → ensurePRReview path, stubbing GitHub's installation-token
// and PR-fetch calls so the comment trigger can run offline. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/github/comment-trigger-cap.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { handleWebhook } from "./webhooks.js";

// appJWT() refuses to sign unless the App is "configured" (appId + privateKey),
// so mint a throwaway RSA key and point the config at it for this process.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
config.github.appId = "123456";
config.github.privateKey = privateKey as string;

// Stub GitHub: hand back an installation token and a minimal PR object so
// ensurePRReview can materialize a row without touching the network.
let prFetches = 0;
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  if (u.includes("/access_tokens")) {
    return new Response(
      JSON.stringify({ token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  }
  if (u.includes("/pulls/")) {
    prFetches++;
    return new Response(
      JSON.stringify({
        number: 7,
        title: "External contribution",
        head: { sha: "aaa1111" },
        base: { sha: "bbb2222" },
        additions: 3,
        deletions: 1,
        changed_files: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  throw new Error(`unexpected fetch in test: ${u}`);
}) as any;

const OWNER_GH_ID = 5001;
let seq = 0;

// A linked account on a finite-cap plan, with the owner's GitHub identity wired
// so isAccountOwner matches the commenter.
function seedAccount(plan: "free" | "pro", reviewsUsed: number) {
  const userId = uuid();
  db.insert("users", {
    id: userId,
    githubId: OWNER_GH_ID,
    githubLogin: "alice",
    email: "alice@example.com",
    plan,
    createdAt: Date.now(),
  } as any);
  const sub = db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: plan === "free" ? null : "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  const instId = uuid();
  db.insert("installations", {
    id: instId,
    userId,
    accountId: 9000 + seq,
    accountLogin: "acme",
    installationId: 999,
    repoIds: [],
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: instId,
    owner: "acme",
    name: `cap-${seq++}`,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
  return { sub, repo };
}

function deliverReviewComment(repo: any) {
  const event = {
    action: "created",
    repository: { full_name: `${repo.owner}/${repo.name}` },
    installation: { id: 999 },
    sender: { type: "User", login: "alice" },
    issue: {
      number: 7,
      pull_request: { url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/7` },
    },
    comment: {
      body: "review",
      user: { login: "alice", id: OWNER_GH_ID },
      author_association: "OWNER",
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/7#issuecomment-1`,
    },
  };
  const raw = Buffer.from(JSON.stringify(event));
  const headers: Record<string, string> = {
    "X-GitHub-Event": "issue_comment",
    "X-GitHub-Delivery": uuid(),
  };
  if (config.github.webhookSecret) {
    headers["X-Hub-Signature-256"] =
      "sha256=" + crypto.createHmac("sha256", config.github.webhookSecret).update(raw).digest("hex");
  }
  const req = { header: (n: string) => headers[n], body: raw } as any;
  const res = { status() { return this; }, send() { return this; }, json() { return this; } } as any;
  handleWebhook(req, res);
}

async function waitFor(pred: () => boolean, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

function rowFor(repo: any) {
  return db.find("prReviews", (r) => r.repoId === repo.id && r.prNumber === 7);
}

test("owner's \"review\" comment under the cap is reviewed and charges one review", async () => {
  const { sub, repo } = seedAccount("free", 9); // one review left of 10
  deliverReviewComment(repo);

  assert.equal(await waitFor(() => !!rowFor(repo)), true, "a review row should be materialized");
  // The trigger consumed the owner's last allowed review for the period.
  assert.equal(db.find("subscriptions", (s) => s.id === sub.id)?.reviewsUsed, 10);
});

test("owner's \"review\" comment at the cap is not reviewed and charges nothing", async () => {
  const { sub, repo } = seedAccount("free", 10); // already at the 10/mo cap
  const before = prFetches;
  deliverReviewComment(repo);

  // Wait until ensurePRReview has fetched the PR (so the cap decision is made),
  // then assert it bailed: no row, usage untouched.
  await waitFor(() => prFetches > before);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rowFor(repo), null, "over-cap trigger must not materialize a review");
  assert.equal(db.find("subscriptions", (s) => s.id === sub.id)?.reviewsUsed, 10);
});
