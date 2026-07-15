// Sponsor reads must carry the signed Fund/Cancel links for a PENDING_FUNDING
// bounty — the in-app fallback when the GitHub confirm comment can't be posted
// (e.g. the App lacks Issues:write). Applicants must NOT receive the links (the
// cancel token would let them kill the bounty), and non-pending bounties carry
// none. Drives the exported handlers with a fake session req/res (signed-JWT
// cookie via signSession), in-memory, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-links.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { verifyBountyLinkToken } from "../bounties/links.js";
import { createBounty, applyToBounty, recordFunding, applyTxnOutcome } from "../bounties/service.js";
import { config } from "../config.js";
import { getBountyHandler, listBountiesHandler } from "./bounties.js";

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

test("sponsor detail carries the links; an applicant's detail does not", () => {
  const { sponsorId, applicantId, applicantGh, bounty } = seed();
  // Fund + confirm so the applicant can apply (links must then be absent for
  // everyone — the bounty is no longer PENDING_FUNDING).
  const sres = fakeRes();
  getBountyHandler(authedReq(sponsorId, { id: bounty.id }), sres);
  assert.ok(sres.body.bounty.fundingUrl, "sponsor sees fundingUrl while pending");

  recordFunding(bounty.id, "G".padEnd(56, "A"), { hash: "H", status: "pending" } as any);
  const txn = db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${bounty.taskId}`)!;
  applyTxnOutcome(txn.id, { status: "success", ledger: 1 });
  applyToBounty(bounty.id, { githubId: applicantGh, githubLogin: "applicant" });

  const ares = fakeRes();
  getBountyHandler(authedReq(applicantId, { id: bounty.id }), ares);
  assert.equal(ares.statusCode, 200, "applicant can read the bounty");
  assert.equal(ares.body.bounty.fundingUrl, undefined);
  assert.equal(ares.body.bounty.cancelUrl, undefined);

  const sres2 = fakeRes();
  getBountyHandler(authedReq(sponsorId, { id: bounty.id }), sres2);
  assert.equal(sres2.body.bounty.fundingUrl, undefined, "no links once funded (OPEN)");
});
