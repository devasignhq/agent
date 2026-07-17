// The public bounty view is a strict allowlist — this test pins the EXACT key
// set so a future Bounty field (or a careless spread) can never leak into the
// unauthenticated payload without failing here first. Run:
//   node --import tsx/esm --test src/bounties/public-view.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bounty, EscrowTransaction } from "../types.js";
import { publicBountyView } from "./public-view.js";

// A fully-populated bounty: every sensitive field set, so anything that leaks
// is guaranteed to be present in the input.
const FULL: Bounty = {
  id: "b-1",
  seq: 9,
  code: "BNTY-9",
  source: "github",
  installationId: 1234,
  repo: "acme/pay",
  issueNumber: 492,
  issueUrl: "https://github.com/acme/pay/issues/492",
  externalKey: "LIN-1",
  title: "Add idempotency keys",
  description: "Make POST /v1/charges idempotent.",
  acceptance: ["Reads an Idempotency-Key header", "Replays return the cached response"],
  sponsorUserId: "user-sponsor-SECRET",
  sponsorAddress: "GSPONSORADDRESS-SECRET",
  taskId: "T".repeat(25),
  contractId: "CCONTRACT",
  amountStroops: "7500000000",
  amountUsdc: 750,
  deliveryDays: 10,
  status: "OPEN",
  onchainStatus: "Open",
  applications: [
    { githubId: 1, githubLogin: "applicant-one-SECRET", appliedAt: 1, status: "pending" },
    { githubId: 2, githubLogin: "applicant-two-SECRET", appliedAt: 2, status: "rejected" },
  ],
  assigneeGithubId: 77,
  assigneeGithubLogin: "assignee-SECRET",
  assigneeAddress: "GASSIGNEE-SECRET",
  assigneeMemo: "memo-SECRET",
  acceptedAt: 3,
  deadlineAt: 4,
  prNumber: 55,
  botCommentId: 999,
  escrowTxHash: "e3f9a1d7",
  payoutTxHash: "payout-SECRET",
  refundTxHash: "refund-SECRET",
  cancelReason: null,
  pendingOp: null,
  createdAt: 1000,
  updatedAt: 2000,
};

test("exact top-level and escrow key sets — nothing outside the allowlist", () => {
  const v = publicBountyView(FULL) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v).sort(), [
    "acceptance",
    "amountUsdc",
    "applicantCount",
    "code",
    "createdAt",
    "deliveryDays",
    "description",
    "escrow",
    "id",
    "issueNumber",
    "issueUrl",
    "repo",
    "status",
    "title",
  ]);
  assert.deepEqual(Object.keys(v.escrow as object).sort(), ["contractId", "fundedAt", "txHash"]);
});

test("no sensitive value survives serialization, even under renamed keys", () => {
  const json = JSON.stringify(publicBountyView(FULL));
  assert.ok(!json.includes("SECRET"), `sensitive value leaked: ${json}`);
  assert.ok(!json.includes(FULL.taskId));
});

test("applicants surface only as a count; escrow fundedAt comes from the txn row", () => {
  const txn = { confirmedAt: 4242 } as EscrowTransaction;
  const v = publicBountyView(FULL, txn);
  assert.equal(v.applicantCount, 2);
  assert.equal(v.escrow.fundedAt, 4242);
  assert.equal(v.escrow.txHash, "e3f9a1d7");
  assert.equal(publicBountyView(FULL).escrow.fundedAt, null);
});
