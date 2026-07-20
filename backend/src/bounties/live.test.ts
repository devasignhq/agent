// Live-signal fan-out for the contributor app (bounties/live.ts): who gets told
// a bounty moved, which writes are deliberately silent, and that a multi-write
// transition collapses into one frame. Drives the real db + stream registry with
// a fake Response, so this exercises the actual emitter → audience → socket path.
// Run: node --import tsx/esm --test src/bounties/live.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { db } from "../db.js";
import {
  addClient,
  closeAllStreams,
} from "../notifications-stream.js";
import type { Bounty, BountyApplication, EscrowTransaction, Installation } from "../types.js";
import { contributorAudience, startBountyLiveSignals } from "./live.js";

// Records frames; `types` is the sequence of frame types this socket received.
function fakeRes() {
  const r: any = {
    writes: [] as string[],
    write(s: string) {
      r.writes.push(s);
      return true;
    },
    end() {},
    get types() {
      return r.writes
        .filter((w: string) => w.startsWith("data: "))
        .map((w: string) => JSON.parse(w.slice(6)).type as string);
    },
  };
  return r as Response & { writes: string[]; types: string[] };
}

let seq = 0;
function mkBounty(over: Partial<Bounty> = {}): Bounty {
  seq++;
  const row = {
    id: `b-${seq}`,
    seq,
    code: `BNTY-${seq}`,
    source: "github",
    installationId: 1,
    repo: "acme/app",
    issueNumber: seq,
    issueUrl: "https://example.test/1",
    title: "t",
    description: "",
    acceptance: [],
    taskId: `task-${seq}`.padEnd(25, "0"),
    contractId: "C",
    amountStroops: "1",
    amountUsdc: 1,
    deliveryDays: 2,
    status: "OPEN",
    onchainStatus: "Open",
    applications: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Bounty;
  return db.insert("bounties", row);
}

function app(githubId: number, status: BountyApplication["status"]): BountyApplication {
  return { githubId, githubLogin: `u${githubId}`, appliedAt: 1, status };
}

// Frames are sent on a microtask, so a test has to yield before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | null = null;
beforeEach(() => {
  closeAllStreams();
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  db.remove("installations", () => true);
  stop = startBountyLiveSignals();
});
afterEach(() => {
  stop?.();
  stop = null;
  closeAllStreams();
});

// ── audience ────────────────────────────────────────────────────────────────

test("the audience is the assignee plus applicants still in the running", () => {
  const b = mkBounty({
    assigneeGithubId: 100,
    applications: [app(100, "accepted"), app(200, "pending"), app(300, "approved"), app(400, "rejected")],
  });
  assert.deepEqual(contributorAudience(b).sort((x, y) => x - y), [100, 200, 300]);
});

test("a rejected applicant is not signalled about the winner's progress", async () => {
  const loser = fakeRes();
  addClient("u-loser", loser, { githubId: 400 });
  const b = mkBounty({ assigneeGithubId: 100, applications: [app(400, "rejected")] });

  db.update("bounties", (x) => x.id === b.id, { status: "IN_REVIEW" });
  await settle();
  assert.deepEqual(loser.types, []);
});

test("a bounty change reaches every watching contributor exactly once", async () => {
  const assignee = fakeRes();
  const applicant = fakeRes();
  const stranger = fakeRes();
  addClient("u1", assignee, { githubId: 100 });
  addClient("u2", applicant, { githubId: 200 });
  addClient("u3", stranger, { githubId: 999 });
  const b = mkBounty({ assigneeGithubId: 100, applications: [app(200, "pending")] });

  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  await settle();

  assert.deepEqual(assignee.types, ["bounties-changed"]);
  assert.deepEqual(applicant.types, ["bounties-changed"]);
  assert.deepEqual(stranger.types, [], "an unrelated contributor hears nothing");
});

// ── sponsor audience ────────────────────────────────────────────────────────

function mkInstall(installationId: number, over: Partial<Installation> = {}): Installation {
  seq++;
  return db.insert("installations", {
    id: `i-${seq}`,
    userId: `owner-${seq}`,
    installationId,
    accountId: 1,
    accountLogin: "acme",
    createdAt: 1,
    ...over,
  } as Installation);
}

test("the sponsor is reached by sponsorUserId when the bounty carries one", async () => {
  const sponsor = fakeRes();
  addClient("sponsor-1", sponsor);
  const b = mkBounty({ sponsorUserId: "sponsor-1", installationId: 0 });
  await settle();
  sponsor.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  await settle();
  assert.deepEqual(sponsor.types, ["bounties-changed"]);
});

test("a comment-created bounty (no sponsorUserId) still reaches every install member", async () => {
  // This is the case that makes the installation lookup mandatory: bounties
  // created from a GitHub issue comment never get a sponsorUserId.
  const owner = fakeRes();
  const colleague = fakeRes();
  addClient("u-owner", owner);
  addClient("u-colleague", colleague);
  mkInstall(9090, { userId: "u-owner", userIds: ["u-owner", "u-colleague"] });
  const b = mkBounty({ sponsorUserId: null, installationId: 9090 });
  await settle();
  owner.writes.length = 0;
  colleague.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "IN_REVIEW" });
  await settle();
  assert.deepEqual(owner.types, ["bounties-changed"]);
  assert.deepEqual(colleague.types, ["bounties-changed"], "an org install has several sponsors");
});

test("a legacy install row with no userIds falls back to its single userId", async () => {
  const owner = fakeRes();
  addClient("u-legacy", owner);
  mkInstall(7070, { userId: "u-legacy", userIds: undefined });
  const b = mkBounty({ sponsorUserId: null, installationId: 7070 });
  await settle();
  owner.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  await settle();
  assert.deepEqual(owner.types, ["bounties-changed"]);
});

test("the install join uses the GITHUB numeric id, not the row id", async () => {
  // Bounty.installationId joins Installation.installationId (numeric), while
  // Repository.installationId joins Installation.id (uuid). Copying the repo
  // join here would resolve the wrong install — or none — and silently deliver
  // to nobody. Pin the distinction.
  const wrong = fakeRes();
  addClient("u-wrong", wrong);
  const install = mkInstall(5050, { userId: "u-wrong" });
  // Point the bounty at the ROW id's numeric-looking twin: a bounty whose
  // installationId matches nothing must reach no sponsor at all.
  const b = mkBounty({ sponsorUserId: null, installationId: 4040 });
  await settle();
  wrong.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  await settle();
  assert.deepEqual(wrong.types, [], "no install matches 4040, so no sponsor frame");
  assert.equal(install.installationId, 5050);
});

test("a Linear bounty (installationId 0) resolves via sponsorUserId only", async () => {
  const sponsor = fakeRes();
  addClient("u-linear", sponsor);
  mkInstall(0, { userId: "u-should-not-match" }); // a 0 must not join this
  const b = mkBounty({ sponsorUserId: "u-linear", installationId: 0 });
  await settle();
  sponsor.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "CANCELLED" });
  await settle();
  assert.deepEqual(sponsor.types, ["bounties-changed"]);
});

test("someone who is both sponsor and applicant is written to once", async () => {
  const both = fakeRes();
  addClient("u-both", both, { githubId: 321 });
  const b = mkBounty({
    sponsorUserId: "u-both",
    installationId: 0,
    applications: [app(321, "pending")],
  });
  await settle();
  both.writes.length = 0;

  db.update("bounties", (x) => x.id === b.id, { status: "IN_REVIEW" });
  await settle();
  assert.deepEqual(both.types, ["bounties-changed"], "named by both identities, one frame");
});

// ── silence on invisible writes ─────────────────────────────────────────────

test("a write touching only bookkeeping fields sends nothing", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100 });
  await settle();
  r.writes.length = 0; // ignore the row's creation; we're measuring the patches

  // The bot-comment id and the single-flight guard are invisible to every
  // contributor projection; updatedAt is stamped by every patch, so it can
  // never be the thing that makes a write worth reporting.
  db.update("bounties", (x) => x.id === b.id, { botCommentId: 555, updatedAt: Date.now() });
  db.update("bounties", (x) => x.id === b.id, { pendingOp: "releasing" });
  await settle();
  assert.deepEqual(r.types, []);

  // …but a real field alongside them still reports.
  db.update("bounties", (x) => x.id === b.id, { botCommentId: 556, status: "PAID" });
  await settle();
  assert.deepEqual(r.types, ["bounties-changed"]);
});

test("nothing is sent when no client is connected", async () => {
  const b = mkBounty({ assigneeGithubId: 100 });
  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  await settle();
  // Nothing to assert on a socket — the point is that it doesn't throw and the
  // emitter bails before doing any resolution work.
  assert.equal(db.find("bounties", (x) => x.id === b.id)!.status, "PAID");
});

// ── coalescing ──────────────────────────────────────────────────────────────

test("a multi-write transition collapses into a single frame", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100 });

  // What a real transition looks like: the status patch, then recordBountyEvent's
  // own patch for the activity log, then another field, all in one turn.
  db.update("bounties", (x) => x.id === b.id, { status: "PAID" });
  db.update("bounties", (x) => x.id === b.id, { events: [{ at: 1, kind: "paid" }] as any });
  db.update("bounties", (x) => x.id === b.id, { payoutTxHash: "H" });
  await settle();

  assert.deepEqual(r.types, ["bounties-changed"], "three writes, one frame");
});

test("the flush re-reads the row, so an audience change mid-burst is honoured", async () => {
  const latecomer = fakeRes();
  addClient("u2", latecomer, { githubId: 200 });
  const b = mkBounty({ assigneeGithubId: 100, applications: [] });

  // First write has an empty audience; the second adds the applicant. Because
  // the flush re-reads rather than trusting the row captured at write time, the
  // applicant added mid-burst still gets the frame.
  db.update("bounties", (x) => x.id === b.id, { status: "IN_REVIEW" });
  db.update("bounties", (x) => x.id === b.id, { applications: [app(200, "pending")] });
  await settle();

  assert.deepEqual(latecomer.types, ["bounties-changed"]);
});

// ── the wallet ledger ───────────────────────────────────────────────────────

function mkTxn(over: Partial<EscrowTransaction>): EscrowTransaction {
  seq++;
  return db.insert("escrowTransactions", {
    id: `t-${seq}`,
    kind: "payout",
    idempotencyKey: `k-${seq}`,
    signer: "admin",
    status: "pending",
    amountStroops: "1",
    dir: "out",
    createdAt: 1,
    ...over,
  } as EscrowTransaction);
}

test("a payout confirming sends wallet-changed to the assignee", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100, assigneeGithubLogin: "u100" });
  const t = mkTxn({ bountyId: b.id, githubLogin: "u100" });
  await settle();
  r.writes.length = 0; // ignore the insert's own frame

  db.update("escrowTransactions", (x) => x.id === t.id, { status: "confirmed", confirmedAt: 2 });
  await settle();
  assert.deepEqual(r.types, ["wallet-changed"]);
});

test("a rebroadcast rewriting the tx hash refreshes the ledger's explorer link", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100 });
  const t = mkTxn({ bountyId: b.id, hash: "OLD" });
  await settle();
  r.writes.length = 0;

  db.update("escrowTransactions", (x) => x.id === t.id, { hash: "NEW", error: null });
  await settle();
  assert.deepEqual(r.types, ["wallet-changed"]);
});

test("escrow and refund rows never reach a contributor's ledger", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100 });
  const escrow = mkTxn({ bountyId: b.id, kind: "escrow" });
  const refund = mkTxn({ bountyId: b.id, kind: "refund", dir: "in" });
  await settle();
  r.writes.length = 0;

  db.update("escrowTransactions", (x) => x.id === escrow.id, { status: "confirmed" });
  db.update("escrowTransactions", (x) => x.id === refund.id, { status: "confirmed" });
  await settle();
  assert.deepEqual(r.types, [], "those are sponsor-facing rows");
});

test("a ledger write that changes nothing renderable is silent", async () => {
  const r = fakeRes();
  addClient("u1", r, { githubId: 100 });
  const b = mkBounty({ assigneeGithubId: 100 });
  const t = mkTxn({ bountyId: b.id, status: "pending", note: "a" });
  await settle();
  r.writes.length = 0;

  db.update("escrowTransactions", (x) => x.id === t.id, { note: "b" });
  await settle();
  assert.deepEqual(r.types, []);
});
