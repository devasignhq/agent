// releaseEnvelopeMismatch guards the sponsor in-app "Approve payment" path:
// submitSponsorRelease broadcasts a Freighter-signed XDR AND records a payout row
// from the bounty's own fields, so a mismatched envelope would let the backend
// mark this bounty paid off a transaction that released something else. These
// build real release envelopes offline (no RPC) and assert every axis is checked.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/bounties/release-validation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Stellar from "@stellar/stellar-sdk";
import type { Bounty } from "../types.js";
import { releaseEnvelopeMismatch } from "./service.js";

const { Keypair, Account, TransactionBuilder, Contract, StrKey, Address, nativeToScVal, BASE_FEE, Networks } = Stellar;

const SPONSOR = Keypair.random().publicKey();
const ASSIGNEE = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
const TASK_ID = "T".repeat(25);

// The bounty the release is being recorded against.
const bounty = {
  taskId: TASK_ID,
  contractId: CONTRACT,
  sponsorAddress: SPONSOR,
  assigneeAddress: ASSIGNEE,
} as Bounty;

// Build a signed release envelope, defaulting to the CORRECT parameters; each
// test overrides exactly one axis to prove that axis is enforced.
function releaseXdr(o: { source?: string; contract?: string; fn?: string; taskId?: string; contributor?: string } = {}): string {
  const contract = new Contract(o.contract ?? CONTRACT);
  const tx = new TransactionBuilder(new Account(o.source ?? SPONSOR, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        o.fn ?? "release",
        nativeToScVal(o.taskId ?? TASK_ID, { type: "string" }),
        new Address(o.contributor ?? ASSIGNEE).toScVal()
      )
    )
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

test("a correct release(task, assignee) on the right contract by the sponsor matches", () => {
  assert.equal(releaseEnvelopeMismatch(releaseXdr(), bounty), null);
});

test("wrong task id is rejected", () => {
  assert.equal(releaseEnvelopeMismatch(releaseXdr({ taskId: "Z".repeat(25) }), bounty), "xdr_mismatch");
});

test("wrong contributor is rejected (the payout-redirect case)", () => {
  const attacker = Keypair.random().publicKey();
  assert.equal(releaseEnvelopeMismatch(releaseXdr({ contributor: attacker }), bounty), "xdr_mismatch");
});

test("wrong source (not the sponsor) is rejected", () => {
  assert.equal(releaseEnvelopeMismatch(releaseXdr({ source: Keypair.random().publicKey() }), bounty), "xdr_mismatch");
});

test("wrong contract is rejected", () => {
  const other = StrKey.encodeContract(Buffer.alloc(32, 1));
  assert.equal(releaseEnvelopeMismatch(releaseXdr({ contract: other }), bounty), "xdr_mismatch");
});

test("a different function (e.g. admin_release) is rejected", () => {
  assert.equal(releaseEnvelopeMismatch(releaseXdr({ fn: "admin_release" }), bounty), "xdr_mismatch");
});

test("the cross-bounty replay: bounty A's valid envelope submitted for bounty B", () => {
  // Envelope is a perfectly valid release for A — but B has a different task,
  // assignee and (here) sponsor, so recording it under B must be refused.
  const bountyB = {
    taskId: "B".repeat(25),
    contractId: CONTRACT,
    sponsorAddress: Keypair.random().publicKey(),
    assigneeAddress: Keypair.random().publicKey(),
  } as Bounty;
  assert.equal(releaseEnvelopeMismatch(releaseXdr(), bountyB), "xdr_mismatch");
});

test("garbage / unparseable XDR is bad_xdr, not a throw", () => {
  assert.equal(releaseEnvelopeMismatch("not-an-xdr", bounty), "bad_xdr");
});

test("a bounty with no sponsor/assignee recorded cannot be matched → xdr_mismatch", () => {
  const incomplete = { taskId: TASK_ID, contractId: CONTRACT, sponsorAddress: null, assigneeAddress: null } as Bounty;
  assert.equal(releaseEnvelopeMismatch(releaseXdr(), incomplete), "xdr_mismatch");
});
