// Tests for installation ↔ user membership helpers and per-user review
// attribution on the PR-opened webhook path. Drives the REAL handleWebhook with
// stub req/res against the in-memory db (same harness style as webhooks.test.ts).
// Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/github/installations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { handleWebhook } from "./webhooks.js";
import {
  installMembers,
  userInInstall,
  installationsForUser,
  addInstallMember,
  attributedUserFor,
} from "./installations.js";

let seq = 0;

function seedUser(githubId: number, login: string, plan = "pro") {
  const u = {
    id: uuid(),
    githubId,
    githubLogin: login,
    email: `${login}@example.com`,
    plan,
    createdAt: Date.now(),
  } as any;
  db.insert("users", u);
  db.insert("subscriptions", {
    id: uuid(),
    userId: u.id,
    plan,
    status: plan === "free" ? null : "trialing",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  return u;
}

function seedLinkedRepo(ownerUser: any, opts: { private?: boolean; members?: any[] } = {}) {
  const install = db.insert("installations", {
    id: uuid(),
    userId: ownerUser.id,
    userIds: [ownerUser.id, ...(opts.members || []).map((m) => m.id)],
    accountId: 555,
    accountLogin: "acme",
    accountType: "Organization",
    installationId: 7000 + seq,
    repoIds: [],
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: `widgets-${seq++}`,
    defaultBranch: "main",
    private: !!opts.private,
    defaultModel: "claude-haiku-4-5",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
  return { install, repo };
}

function prEvent(repo: any, installationId: number, pr: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: {
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: "main",
      private: repo.private,
    },
    installation: { id: installationId },
    sender: { login: "alice", type: "User" },
    pull_request: {
      number: 7,
      title: "Add widget",
      draft: false,
      user: { login: "alice", id: 1, type: "User" },
      author_association: "MEMBER",
      head: { sha: "abc1234", ref: "feature" },
      base: { sha: "def5678", ref: "main" },
      additions: 10,
      deletions: 2,
      changed_files: 1,
      ...pr,
    },
  };
}

function deliver(event: any) {
  const raw = Buffer.from(JSON.stringify(event));
  const headers: Record<string, string> = {
    "X-GitHub-Event": "pull_request",
    "X-GitHub-Delivery": uuid(),
  };
  if (config.github.webhookSecret) {
    headers["X-Hub-Signature-256"] =
      "sha256=" +
      crypto.createHmac("sha256", config.github.webhookSecret).update(raw).digest("hex");
  }
  const req = { header: (n: string) => headers[n], body: raw } as any;
  const res = {
    status() { return this; },
    send() { return this; },
    json() { return this; },
  } as any;
  handleWebhook(req, res);
}

function rowsFor(repo: any, prNumber = 7) {
  return db.filter("prReviews", (r) => r.repoId === repo.id && r.prNumber === prNumber);
}
function subOf(user: any) {
  return db.find("subscriptions", (s) => s.userId === user.id);
}

// ── Pure helpers ────────────────────────────────────────────────────────────

test("installMembers falls back to [userId] for legacy rows", () => {
  assert.deepEqual(installMembers({ userId: "u1" } as any), ["u1"]);
  assert.deepEqual(installMembers({ userId: "u1", userIds: ["u1", "u2"] } as any), ["u1", "u2"]);
  assert.deepEqual(installMembers({ userId: "" } as any), []);
});

test("userInInstall matches the primary userId and the members set", () => {
  const i = { userId: "u1", userIds: ["u1", "u2"] } as any;
  assert.equal(userInInstall(i, "u1"), true);
  assert.equal(userInInstall(i, "u2"), true);
  assert.equal(userInInstall(i, "u3"), false);
  assert.equal(userInInstall(i, ""), false);
  // legacy row without userIds still resolves via userId
  assert.equal(userInInstall({ userId: "u9" } as any, "u9"), true);
});

test("addInstallMember adds without displacing the original installer", () => {
  const owner = seedUser(2001, "owner-a");
  const { install } = seedLinkedRepo(owner);
  const second = seedUser(2002, "owner-b");
  const updated = addInstallMember(install.id, second.id);
  assert.ok(updated);
  assert.equal(updated!.userId, owner.id, "primary installer preserved");
  assert.ok(updated!.userIds!.includes(owner.id));
  assert.ok(updated!.userIds!.includes(second.id));
  // both owners now see the install
  assert.equal(installationsForUser(owner.id).some((i) => i.id === install.id), true);
  assert.equal(installationsForUser(second.id).some((i) => i.id === install.id), true);
});

test("attributedUserFor resolves only install-members", () => {
  const owner = seedUser(2101, "attr-owner");
  const { install } = seedLinkedRepo(owner);
  assert.equal(attributedUserFor(install, 2101), owner.id, "member resolves");
  assert.equal(attributedUserFor(install, 999999), null, "non-DevAsign actor → null");
  assert.equal(attributedUserFor(install, undefined), null, "missing actor → null");
  assert.equal(attributedUserFor(null, 2101), null, "missing install → null");
  // A DevAsign user who isn't a member of this install resolves to null.
  const outsider = seedUser(2102, "attr-outsider");
  assert.equal(attributedUserFor(install, outsider.githubId), null);
});

// ── Per-user attribution on the opened webhook ──────────────────────────────

test("member-authored PR is reviewed and counted against the author", () => {
  const owner = seedUser(3001, "memauth");
  const { install, repo } = seedLinkedRepo(owner);
  deliver(prEvent(repo, install.installationId, { user: { login: "memauth", id: 3001, type: "User" }, author_association: "MEMBER" }));
  const rows = rowsFor(repo);
  assert.equal(rows.length, 1, "review row created");
  assert.equal(rows[0].attributedUserId, owner.id, "attributed to the PR author");
  assert.equal(subOf(owner)!.reviewsUsed, 1, "author's usage incremented");
});

test("external-author PR (not an org member) is not auto-reviewed", () => {
  const owner = seedUser(3101, "extowner");
  const { install, repo } = seedLinkedRepo(owner);
  deliver(prEvent(repo, install.installationId, {
    user: { login: "drive-by", id: 999001, type: "User" },
    author_association: "CONTRIBUTOR",
  }));
  assert.equal(rowsFor(repo).length, 0, "no review for external contributor");
  assert.equal(subOf(owner)!.reviewsUsed, 0, "owner not charged");
});

test("org-member author without a DevAsign account is not auto-reviewed", () => {
  const owner = seedUser(3201, "noacct-owner");
  const { install, repo } = seedLinkedRepo(owner);
  // author_association MEMBER but the GitHub id maps to no DevAsign user.
  deliver(prEvent(repo, install.installationId, {
    user: { login: "teammate", id: 888001, type: "User" },
    author_association: "MEMBER",
  }));
  assert.equal(rowsFor(repo).length, 0);
  assert.equal(subOf(owner)!.reviewsUsed, 0);
});

test("two org owners are counted independently", () => {
  // Owner A on Max — the only tier whose gate (shouldAutoReviewOpenedPR) auto-
  // reviews team members' PRs, so member B's PR enters scope and is counted to
  // B rather than dropped. Max still meters usage (recordReviewUsage increments
  // reviewsUsed even at the Infinity cap), so the per-user counts below hold.
  const a = seedUser(3301, "owner-x", "max");
  const b = seedUser(3302, "owner-y");
  const { install, repo } = seedLinkedRepo(a, { members: [b] });
  // A opens PR #7, B opens PR #8 on the same shared org repo.
  deliver(prEvent(repo, install.installationId, { number: 7, user: { login: "owner-x", id: 3301, type: "User" }, author_association: "MEMBER" }));
  deliver(prEvent(repo, install.installationId, { number: 8, user: { login: "owner-y", id: 3302, type: "User" }, author_association: "MEMBER" }));
  assert.equal(rowsFor(repo, 7)[0].attributedUserId, a.id);
  assert.equal(rowsFor(repo, 8)[0].attributedUserId, b.id);
  assert.equal(subOf(a)!.reviewsUsed, 1, "A charged for their PR only");
  assert.equal(subOf(b)!.reviewsUsed, 1, "B charged for their PR only");
});

test("unlinked install keeps the grace window (reviews, attributes nobody)", () => {
  // Repo whose installationId points at no install row → unlinked.
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(),
    owner: "acme",
    name: `grace-${seq++}`,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
  deliver(prEvent(repo, 4242, { user: { login: "anyone", id: 4242, type: "User" }, author_association: "NONE" }));
  const rows = rowsFor(repo);
  assert.equal(rows.length, 1, "grace window still reviews");
  assert.equal(rows[0].attributedUserId ?? null, null, "no attribution yet");
});
