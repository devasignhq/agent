// Webhook guards for the money-moving bounty paths. The load-bearing guarantee:
// a merged PR only releases escrow to the *delegate who authored it*, and never
// when the PR wasn't merged or the delegate is unknown; the in-review transition
// is gated the same way. Runs against the in-memory store with the chain stubbed
// (no network). Run:
//   node --import tsx/esm --test src/bounties/webhooks.test.ts
import { test, beforeEach, afterEach } from "node:test";
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
  maybeHandleBountyLinearComment,
  handleLinearBountyCommand,
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

// ── Linear command authority ─────────────────────────────────────────────────
// A Linear bounty is charged to whoever connected the workspace, so the comment
// that mints it must come from someone entitled to spend that money: the
// connector, or a workspace admin. Linear's payload carries only an author id, so
// the gate makes a GraphQL lookup — stubbed here on globalThis.fetch, which is
// what linearGraphQL uses.

const CONNECTOR = "lin_connector";
const ORG = "org_test";
const realFetch = globalThis.fetch;
let roles: Record<string, { admin: boolean; guest: boolean; active: boolean }> = {};
let graphqlCalls: string[] = [];
let roleLookupFails = false;

function seedIntegration(workspaceMeta: Record<string, string> = { organizationId: ORG }) {
  db.insert("integrations", {
    id: "int_lin", userId: "u_sponsor", type: "linear",
    tokens: { accessToken: "tok" }, workspaceMeta, createdAt: Date.now(),
  } as any);
}

// A Comment.create webhook. `authorId` null omits the author entirely, which is
// the "who sent this?" case the gate must refuse rather than guess at.
const linearEvent = (authorId: string | null, body = "bounty $500 7d") => ({
  type: "Comment",
  action: "create",
  organizationId: ORG,
  ...(authorId ? { actor: { id: authorId, type: "user" } } : {}),
  data: {
    id: "cmt_1",
    body,
    issueId: "issue_lin",
    ...(authorId ? { user: { id: authorId } } : {}),
    issue: { id: "issue_lin", identifier: "ENG-1", title: "Ticket", url: "https://linear.app/i/ENG-1" },
  },
});

const linearIntegration = () => db.find("integrations", (i) => i.id === "int_lin")!;
const linearBounty = () => db.find("bounties", (b) => b.source === "linear" && b.externalKey === "issue_lin");

beforeEach(() => {
  db.remove("integrations", () => true);
  roles = {};
  graphqlCalls = [];
  roleLookupFails = false;
  globalThis.fetch = (async (_url: string, init: any) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    const query: string = payload.query || "";
    graphqlCalls.push(query.includes("viewer") ? "viewer" : query.includes("user(id:") ? "user" : "other");
    const ok = (data: unknown) => ({ ok: true, status: 200, async json() { return { data }; }, async text() { return ""; } });
    if (query.includes("viewer")) return ok({ viewer: { id: CONNECTOR } });
    if (query.includes("user(id:")) {
      if (roleLookupFails) return { ok: false, status: 500, async text() { return "linear is down"; } };
      const role = roles[payload.variables?.id];
      return ok({ user: role ? { id: payload.variables.id, ...role } : null });
    }
    return ok({ commentCreate: { success: true } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Linear bounty refused from a guest, a plain member, and a deactivated user", async () => {
  seedIntegration();
  roles = {
    lin_guest: { admin: false, guest: true, active: true },
    lin_member: { admin: false, guest: false, active: true },
    lin_gone: { admin: true, guest: false, active: false },
    lin_stranger: undefined as any, // not in the workspace at all
  };
  for (const author of ["lin_guest", "lin_member", "lin_gone", "lin_stranger"]) {
    assert.equal(await handleLinearBountyCommand(linearEvent(author), linearIntegration()), null, author);
    assert.equal(linearBounty(), null, `${author} must not create a bounty`);
  }
});

test("Linear bounty allowed for a workspace admin, sponsored by the connector's account", async () => {
  seedIntegration();
  roles = { lin_admin: { admin: true, guest: false, active: true } };
  const bounty = await handleLinearBountyCommand(linearEvent("lin_admin"), linearIntegration());
  assert.ok(bounty, "admin's command creates the bounty");
  assert.equal(bounty!.sponsorUserId, "u_sponsor");
  assert.equal(bounty!.amountUsdc, 500);
  assert.equal(bounty!.deliveryDays, 7);
  assert.equal(bounty!.status, "PENDING_FUNDING");
});

test("the connector's own command stands without an admin role, and the id is cached", async () => {
  seedIntegration();
  roles = {}; // no role would authorize; identity as the connector is the whole basis
  assert.ok(await handleLinearBountyCommand(linearEvent(CONNECTOR), linearIntegration()));
  assert.equal(
    linearIntegration().workspaceMeta.connectorUserId,
    CONNECTOR,
    "resolved once and cached onto the integration"
  );
  assert.deepEqual(graphqlCalls.filter((c) => c === "user"), [], "no per-author lookup needed");

  // Second command on a fresh issue: the cached id means no viewer lookup either.
  db.remove("bounties", () => true);
  graphqlCalls = [];
  assert.ok(await handleLinearBountyCommand(linearEvent(CONNECTOR), linearIntegration()));
  assert.deepEqual(graphqlCalls.filter((c) => c === "viewer"), [], "connector id came from the cache");
});

test("Linear bounty refused when the payload names no author — without any lookup", async () => {
  seedIntegration();
  assert.equal(await handleLinearBountyCommand(linearEvent(null), linearIntegration()), null);
  assert.equal(linearBounty(), null);
  assert.deepEqual(graphqlCalls, [], "an unattributable command is refused before we ask Linear anything");
});

test("Linear bounty refused when the authority lookup fails (fails closed)", async () => {
  seedIntegration();
  roleLookupFails = true;
  assert.equal(await handleLinearBountyCommand(linearEvent("lin_admin"), linearIntegration()), null);
  assert.equal(linearBounty(), null, "a Linear outage must not open the money path");
});

test("a non-human actor is refused, so our own confirm comment can't re-trigger", async () => {
  seedIntegration();
  roles = { lin_app: { admin: true, guest: false, active: true } };
  const echo = { ...linearEvent("lin_app"), actor: { id: "lin_app", type: "integration" } };
  assert.equal(await handleLinearBountyCommand(echo, linearIntegration()), null);
  assert.equal(linearBounty(), null);
});

test("the receiver's sync answer claims commands only, and creation still needs authority", async () => {
  seedIntegration();
  roles = { lin_member: { admin: false, guest: false, active: true } };
  assert.equal(
    maybeHandleBountyLinearComment({ ...linearEvent("lin_member"), data: { ...linearEvent("lin_member").data, body: "looks good to me" } }, linearIntegration()),
    false,
    "an ordinary comment is not claimed"
  );
  assert.equal(
    maybeHandleBountyLinearComment(linearEvent("lin_member"), linearIntegration()),
    true,
    "a command is claimed even though the author turns out to be unauthorized"
  );
  await flush();
  assert.equal(linearBounty(), null, "…and no bounty is created for them");
});
