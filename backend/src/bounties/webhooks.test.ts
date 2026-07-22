// Webhook guards for the money-moving bounty paths. The load-bearing guarantee:
// a merged PR only releases escrow to the *delegate who authored it*, and never
// when the PR wasn't merged or the delegate is unknown; the in-review transition
// is gated the same way. Runs against the in-memory store with the chain stubbed
// (no network). Run:
//   node --import tsx/esm --test src/bounties/webhooks.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { db } from "../db.js";
import {
  createBounty,
  recordFunding,
  applyToBounty,
  delegateToApplicant,
  getBounty,
  applyTxnOutcome,
  defaultChain,
  type EscrowChain,
} from "./service.js";
import {
  handleBountyPRMerge,
  handleBountyPROpened,
  maybeHandleBountyComment,
} from "./webhooks.js";

// handleBountyPRMerge no-ops unless the escrow is "configured", so make it so —
// then stub the on-chain release to record a call instead of hitting a node.
// (Test files run in their own process, so this doesn't leak to other suites.)
config.stellar.rpcUrl ||= "https://soroban-testnet.stellar.org";
config.stellar.contractId ||= "C_TEST";
config.stellar.usdcSac ||= "C_TEST";
config.stellar.adminSecret ||= "S_TEST";

// Keep the GitHub side hermetic: with no App credentials, appJWT() throws, so
// the confirm-comment path fails locally (no network) — exactly the swallowed-
// failure scenario the diagnostics below assert on.
config.github.appId = "";
config.github.privateKey = "";

let releaseCalls = 0;
defaultChain.adminRelease = async () => {
  releaseCalls++;
  return { hash: `H_REL_${releaseCalls}`, status: "pending" };
};

const DELEGATE = 999;
const ADDR = () => Keypair.random().publicKey();

const fakeChain: EscrowChain = {
  async buildCreateEscrowXdr() { return "X"; },
  async buildReleaseXdr() { return "X"; },
  async adminRelease() { return { hash: "H", status: "pending" }; },
  async adminRefund() { return { hash: "H", status: "pending" }; },
  async hasUsdcTrustline() { return true; },
  async getEscrow() { return null; },
};

// Create → fund/confirm → apply/approve/accept, leaving a DELEGATED bounty
// assigned to githubId 999 (mirrors the service.test lifecycle helpers).
async function seedDelegated(issueNumber = 7) {
  const b = createBounty({
    source: "github",
    installationId: 42,
    repo: "acme/app",
    issueNumber,
    issueUrl: `https://github.com/acme/app/issues/${issueNumber}`,
    title: "Fix the thing",
    amountUsdc: 100,
    deliveryDays: 2,
  });
  recordFunding(b.id, ADDR(), { hash: "H_ESCROW", status: "pending" });
  const txn = db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${b.taskId}`)!;
  applyTxnOutcome(txn.id, { status: "success", ledger: 1 });
  await applyToBounty(b.id, { githubId: DELEGATE, githubLogin: "dev", address: ADDR() }, fakeChain);
  await delegateToApplicant(b.id, DELEGATE, "sponsor", fakeChain);
  return getBounty(b.id)!;
}

// A pull_request webhook payload closing the bounty's issue. `merged` and the
// author id are what the guards key off of.
const prEvent = (
  bounty: { repo: string; issueNumber: number },
  opts: { merged: boolean; authorId?: number },
) => ({
  repository: { full_name: bounty.repo },
  installation: { id: 42 },
  pull_request: {
    number: 11,
    merged: opts.merged,
    body: `closes #${bounty.issueNumber}`,
    user: opts.authorId === undefined ? {} : { id: opts.authorId },
    merged_by: { id: 5, login: "maintainer" },
  },
});

// The release fires from a fire-and-forget async IIFE; let it settle.
const flush = () => new Promise((r) => setTimeout(r, 20));
const payoutTxn = (taskId: string) =>
  db.find("escrowTransactions", (t) => t.idempotencyKey === `release:${taskId}`);

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("users", () => true);
  releaseCalls = 0;
});

// ── handleBountyPRMerge: escrow release (money) ──────────────────────────────

test("release refused: PR closed without being merged", async () => {
  const b = await seedDelegated();
  handleBountyPRMerge(prEvent(b, { merged: false, authorId: DELEGATE }));
  await flush();
  assert.equal(releaseCalls, 0);
  assert.equal(payoutTxn(b.taskId), null);
  assert.equal(getBounty(b.id)!.status, "DELEGATED");
});

test("release refused: no delegate on record (assigneeGithubId unset)", async () => {
  const b = await seedDelegated();
  db.update("bounties", (x) => x.id === b.id, { assigneeGithubId: null });
  handleBountyPRMerge(prEvent(b, { merged: true, authorId: DELEGATE }));
  await flush();
  assert.equal(releaseCalls, 0);
  assert.equal(payoutTxn(b.taskId), null);
});

test("release refused: merged PR authored by someone other than the delegate", async () => {
  const b = await seedDelegated();
  handleBountyPRMerge(prEvent(b, { merged: true, authorId: 1234 }));
  await flush();
  assert.equal(releaseCalls, 0);
  assert.equal(payoutTxn(b.taskId), null);
  assert.equal(getBounty(b.id)!.status, "DELEGATED");
});

test("release refused: merged PR with a missing author id", async () => {
  const b = await seedDelegated();
  handleBountyPRMerge(prEvent(b, { merged: true, authorId: undefined }));
  await flush();
  assert.equal(releaseCalls, 0);
  assert.equal(payoutTxn(b.taskId), null);
});

test("release allowed: delegate's own merged PR releases the escrow once", async () => {
  const b = await seedDelegated();
  handleBountyPRMerge(prEvent(b, { merged: true, authorId: DELEGATE }));
  await flush();
  assert.equal(releaseCalls, 1);
  assert.ok(payoutTxn(b.taskId), "a payout txn is recorded");
});

test("delegate identity match is type-robust (string-stored id vs numeric author)", async () => {
  const b = await seedDelegated();
  // Simulate a serialized/string id to prove the String() coercion holds.
  db.update("bounties", (x) => x.id === b.id, { assigneeGithubId: String(DELEGATE) as unknown as number });
  handleBountyPRMerge(prEvent(b, { merged: true, authorId: DELEGATE }));
  await flush();
  assert.equal(releaseCalls, 1, "string-stored delegate id still matches the numeric PR author");
});

// ── handleBountyPROpened: in-review transition (display state) ────────────────

test("in-review refused: PR opened by someone other than the delegate", async () => {
  const b = await seedDelegated();
  handleBountyPROpened(prEvent(b, { merged: false, authorId: 1234 }));
  await flush();
  assert.equal(getBounty(b.id)!.status, "DELEGATED");
});

test("in-review allowed: delegate's opened PR advances to in-review", async () => {
  const b = await seedDelegated();
  handleBountyPROpened(prEvent(b, { merged: false, authorId: DELEGATE }));
  await flush();
  assert.equal(getBounty(b.id)!.status, "IN_REVIEW");
});

// ── maybeHandleBountyComment: the `bounty $X $Nd` issue command ───────────────

// An issue_comment.created payload carrying a bounty command from a maintainer.
const commentEvent = (body: string, over: Record<string, unknown> = {}) => ({
  comment: { body, author_association: "OWNER", user: { login: "owner" } },
  sender: { type: "User" },
  issue: { number: 5, title: "Fix the thing", html_url: "https://github.com/acme/app/issues/5", body: "desc" },
  repository: { full_name: "acme/app" },
  installation: { id: 42 },
  ...over,
});

const issueBounty = () =>
  db.find("bounties", (b) => b.repo === "acme/app" && b.issueNumber === 5);

test("bounty command creates a PENDING_FUNDING bounty even when the confirm comment fails, and diagnoses why", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const handled = maybeHandleBountyComment(commentEvent("bounty $100 5 days"));
  assert.equal(handled, true);
  const b = issueBounty();
  assert.ok(b, "bounty row created synchronously");
  assert.equal(b!.status, "PENDING_FUNDING");
  assert.equal(b!.amountUsdc, 100);
  assert.equal(b!.deliveryDays, 5);
  await flush();
  // The comment could not be posted (no App credentials) — the bounty must
  // survive, botCommentId stays null, and the log names the likely permission
  // gap plus the in-app fallback instead of failing silently.
  assert.equal(getBounty(b!.id)!.botCommentId, null);
  const diag = errors.find((e) => e.includes(b!.code));
  assert.ok(diag, "an operator-visible error is logged");
  assert.match(diag!, /"Issues" permission/);
  assert.match(diag!, /Bounties page/);
});

test("bounty command ignored on PR comments, from bots, and from non-maintainers", () => {
  assert.equal(
    maybeHandleBountyComment(
      commentEvent("bounty $100 5 days", {
        issue: { number: 5, pull_request: { url: "x" } },
      })
    ),
    false
  );
  assert.equal(
    maybeHandleBountyComment(
      commentEvent("bounty $100 5 days", { sender: { type: "Bot" } })
    ),
    false
  );
  assert.equal(
    maybeHandleBountyComment(
      commentEvent("bounty $100 5 days", {
        comment: { body: "bounty $100 5 days", author_association: "NONE", user: { login: "drive-by" } },
      })
    ),
    false
  );
  assert.equal(issueBounty(), null, "no bounty row for any of the rejected commands");
});

test("second bounty command on the same issue is a no-op while one is active", async () => {
  maybeHandleBountyComment(commentEvent("bounty $100 5 days"));
  const handled = maybeHandleBountyComment(commentEvent("bounty $200 3 days"));
  assert.equal(handled, true, "still consumed as a bounty command");
  await flush();
  const all = db.filter("bounties", (b) => b.repo === "acme/app" && b.issueNumber === 5);
  assert.equal(all.length, 1, "only the first bounty exists");
  assert.equal(all[0].amountUsdc, 100);
});
