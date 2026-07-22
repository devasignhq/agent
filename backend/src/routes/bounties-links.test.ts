// Sponsor reads must carry the signed Fund/Cancel links for a PENDING_FUNDING
// bounty — the in-app fallback when the GitHub confirm comment can't be posted
// (e.g. the App lacks Issues:write). A funded (OPEN) bounty keeps its Cancel
// link (cancelling refunds the escrow) but loses the Fund link. Applicants must
// NOT receive the links (the cancel token would let them kill the bounty).
// Drives the exported handlers with a fake session req/res (signed-JWT
// cookie via signSession), in-memory, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-links.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { verifyBountyLinkToken } from "../bounties/links.js";
import { createBounty, applyToBounty, recordFunding, applyTxnOutcome, type EscrowChain } from "../bounties/service.js";
import { config } from "../config.js";
import { getBountyHandler, listBountiesHandler } from "./bounties.js";

// Apply now binds a wallet and probes the trustline; these projection tests only
// need an application to exist, so a stub chain that always has a trustline.
const ADDR = () => Keypair.random().publicKey();
const okChain = { hasUsdcTrustline: async () => true } as unknown as EscrowChain;

// createBounty stamps config.stellar.contractId onto the row; give it a value
// so rows are well-formed (no chain calls happen in these tests).
config.stellar.contractId ||= "C_TEST";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function authedReq(userId: string, params: any = {}): any {
  return { cookies: { devasign_session: signSession(userId) }, params };
}

// Sponsor (installation member) + an applicant with a GitHub identity but no
// installation access, and one PENDING_FUNDING bounty on the sponsor's install.
function seed() {
  const sponsorId = uuid(), applicantId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  const installationId = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: sponsorId, githubId: gh, githubLogin: "sponsor", email: "s@x.z", plan: "pro", createdAt: Date.now() } as any);
  db.insert("users", { id: applicantId, githubId: gh + 1, githubLogin: "applicant", email: "a@x.z", plan: "free", createdAt: Date.now() } as any);
  db.insert("installations", { id: uuid(), userId: sponsorId, accountId: 1, accountLogin: "sponsor", installationId, repoIds: [] } as any);
  const bounty = createBounty({
    source: "github",
    installationId,
    repo: "acme/app",
    issueNumber: 9,
    issueUrl: "https://github.com/acme/app/issues/9",
    title: "Fix the thing",
    amountUsdc: 50,
    deliveryDays: 3,
  });
  return { sponsorId, applicantId, applicantGh: gh + 1, bounty };
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("users", () => true);
  db.remove("installations", () => true);
});

test("sponsor list carries verifiable Fund/Cancel links on a PENDING_FUNDING bounty", () => {
  const { sponsorId, bounty } = seed();
  const res = fakeRes();
  listBountiesHandler(authedReq(sponsorId), res);
  assert.equal(res.statusCode, 200);
  const row = res.body.bounties.find((b: any) => b.id === bounty.id);
  assert.ok(row.fundingUrl, "fundingUrl present");
  assert.ok(row.cancelUrl, "cancelUrl present");
  // The links embed tokens that actually authorize their purpose for this bounty.
  const fundToken = new URL(row.fundingUrl).searchParams.get("token")!;
  const cancelToken = new URL(row.cancelUrl).searchParams.get("token")!;
  assert.equal(verifyBountyLinkToken(fundToken, "fund"), bounty.id);
  assert.equal(verifyBountyLinkToken(cancelToken, "cancel"), bounty.id);
  assert.equal(verifyBountyLinkToken(fundToken, "cancel"), null, "purposes don't cross");
});

test("sponsor detail carries the links; an applicant's detail does not", async () => {
  const { sponsorId, applicantId, applicantGh, bounty } = seed();
  // Fund + confirm so the applicant can apply (links must then be absent for
  // everyone — the bounty is no longer PENDING_FUNDING).
  const sres = fakeRes();
  getBountyHandler(authedReq(sponsorId, { id: bounty.id }), sres);
  assert.ok(sres.body.bounty.fundingUrl, "sponsor sees fundingUrl while pending");

  recordFunding(bounty.id, "G".padEnd(56, "A"), { hash: "H", status: "pending" } as any);
  const txn = db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${bounty.taskId}`)!;
  applyTxnOutcome(txn.id, { status: "success", ledger: 1 });
  await applyToBounty(bounty.id, { githubId: applicantGh, githubLogin: "applicant", address: ADDR() }, okChain);

  const ares = fakeRes();
  getBountyHandler(authedReq(applicantId, { id: bounty.id }), ares);
  assert.equal(ares.statusCode, 200, "applicant can read the bounty");
  assert.equal(ares.body.bounty.fundingUrl, undefined);
  assert.equal(ares.body.bounty.cancelUrl, undefined);

  const sres2 = fakeRes();
  getBountyHandler(authedReq(sponsorId, { id: bounty.id }), sres2);
  assert.equal(sres2.body.bounty.fundingUrl, undefined, "no fundingUrl once funded (OPEN)");
  assert.ok(sres2.body.bounty.cancelUrl, "cancelUrl persists once funded — cancel refunds the escrow");
  const openCancelToken = new URL(sres2.body.bounty.cancelUrl).searchParams.get("token")!;
  assert.equal(verifyBountyLinkToken(openCancelToken, "cancel"), bounty.id);
});

test("any signed-in user can read a bounty; applications stay scoped", async () => {
  const { sponsorId, applicantId, applicantGh, bounty } = seed();
  recordFunding(bounty.id, "G".padEnd(56, "A"), { hash: "H", status: "pending" } as any);
  const txn = db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${bounty.taskId}`)!;
  applyTxnOutcome(txn.id, { status: "success", ledger: 1 });
  await applyToBounty(bounty.id, { githubId: applicantGh, githubLogin: "applicant", address: ADDR() }, okChain);

  // A stranger (no installation, never applied) can read the bounty — this is
  // where the bot comment's Apply CTA lands — but gets no sponsor links and no
  // other user's applications.
  const strangerId = uuid();
  db.insert("users", { id: strangerId, githubId: 424242, githubLogin: "stranger", email: "x@x.z", plan: "free", createdAt: Date.now() } as any);
  const res = fakeRes();
  getBountyHandler(authedReq(strangerId, { id: bounty.id }), res);
  assert.equal(res.statusCode, 200, "stranger can read the advertised bounty");
  assert.equal(res.body.bounty.fundingUrl, undefined);
  assert.equal(res.body.bounty.cancelUrl, undefined);
  assert.deepEqual(res.body.bounty.applications, [], "another user's application is not leaked");

  // The applicant sees exactly their own application (drives "already applied").
  const ares = fakeRes();
  getBountyHandler(authedReq(applicantId, { id: bounty.id }), ares);
  assert.equal(ares.body.bounty.applications.length, 1);
  assert.equal(ares.body.bounty.applications[0].githubId, applicantGh);

  // The sponsor still sees the full list.
  const sres = fakeRes();
  getBountyHandler(authedReq(sponsorId, { id: bounty.id }), sres);
  assert.equal(sres.body.bounty.applications.length, 1);
});
