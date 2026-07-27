// The apply route under the two-account model: a CONTRIBUTOR-origin request
// resolves the contributor account, and you can't apply to a bounty you sponsor
// or maintain — checked in githubId-space, since the sponsor (maintainer account)
// and the applicant (contributor account) are different user ids for one human.
// Same harness as bounties-delegate.test.ts (throwaway app, real signed cookies,
// Stellar configured just enough that the trustline probe short-circuits to true).
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-apply.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import type { Server, AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import { config } from "../config.js";
import { signSession } from "../github/oauth.js";
import type { Bounty } from "../types.js";
import { bounties } from "./bounties.js";

const ADDR = () => Keypair.random().publicKey();

let server: Server;
let base = "";

before(async () => {
  config.stellar.rpcUrl ||= "http://rpc.test";
  config.stellar.contractId ||= "C_TEST";
  config.stellar.usdcSac ||= "C_SAC_TEST";
  config.stellar.adminSecret ||= "S_ADMIN_TEST";
  config.stellar.usdcIssuer = ""; // trustline probe returns true without Horizon

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", bounties);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// The bounty's sponsor: a maintainer account (M) and — same human, same githubId
// 500 — their contributor account (C).
const SPONSOR_M = { id: "sponsor-m", githubId: 500, kind: "maintainer" as const };
const SPONSOR_C = { id: "sponsor-c", githubId: 500, kind: "contributor" as const };
// A maintainer of the bounty's repo (installation member) + their contributor account.
const REPO_MAINT_M = { id: "maint-m", githubId: 600, kind: "maintainer" as const };
const REPO_MAINT_C = { id: "maint-c", githubId: 600, kind: "contributor" as const };
// An unrelated contributor (no maintainer account, not the sponsor).
const DEV_C = { id: "dev-c", githubId: 101, kind: "contributor" as const };

function mkUser(u: { id: string; githubId: number; kind: "maintainer" | "contributor" }) {
  db.insert("users", {
    id: u.id, githubId: u.githubId, githubLogin: u.id, email: `${u.id}@e.com`,
    plan: "free", createdAt: Date.now(), accountKind: u.kind,
  } as any);
}

function mkOpenBounty(): Bounty {
  return db.insert("bounties", {
    id: uuid(), seq: 1, code: "BNTY-1", source: "github", installationId: 1,
    repo: "acme/app", issueNumber: 7, issueUrl: "https://github.com/acme/app/issues/7",
    title: "Fix the thing", description: "", acceptance: ["works"],
    sponsorUserId: SPONSOR_M.id, sponsorAddress: "GSPONSOR", taskId: "T".repeat(25),
    contractId: "C1", amountStroops: "1000000000", amountUsdc: 100, deliveryDays: 7,
    status: "OPEN", onchainStatus: "Open", applications: [],
    botCommentId: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
}

// A contributor-app apply: contributor Origin + the contributor session cookie.
function applyAs(bountyId: string, userId: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/bounties/${bountyId}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.contributorOrigin,
      Cookie: `devasign_session_contributor=${signSession(userId)}`,
    },
    body: JSON.stringify(body),
  });
}

// A sponsor-app action: sponsor Origin + the maintainer session cookie.
function sponsorPost(path: string, userId: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.webOrigin, Cookie: `devasign_session=${signSession(userId)}` },
    body: "{}",
  });
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("users", () => true);
  db.remove("installations", () => true);
  db.remove("notifications", () => true);
  [SPONSOR_M, SPONSOR_C, REPO_MAINT_M, REPO_MAINT_C, DEV_C].forEach(mkUser);
  // REPO_MAINT_M maintains the bounty's repo (installation 1).
  db.insert("installations", {
    id: "inst-1", installationId: 1, userId: REPO_MAINT_M.id, userIds: [REPO_MAINT_M.id],
    accountId: 1, accountLogin: "acme", accountType: "Organization", repoIds: [],
  } as any);
});

test("the bounty's sponsor cannot apply through their contributor account", async () => {
  const b = mkOpenBounty();
  const res = await applyAs(b.id, SPONSOR_C.id, { address: ADDR() });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error?: string }).error, "own_bounty");
  assert.equal(db.find("bounties", (x) => x.id === b.id)!.applications.length, 0);
});

test("a maintainer of the bounty's repo cannot apply through their contributor account", async () => {
  const b = mkOpenBounty();
  const res = await applyAs(b.id, REPO_MAINT_C.id, { address: ADDR() });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error?: string }).error, "own_bounty");
});

test("an unrelated contributor applies successfully, wallet cached on the contributor account", async () => {
  const b = mkOpenBounty();
  const addr = ADDR();
  const res = await applyAs(b.id, DEV_C.id, { address: addr, memo: "m1" });
  assert.equal(res.status, 200);
  const applied = db.find("bounties", (x) => x.id === b.id)!;
  assert.equal(applied.applications.find((a) => a.githubId === 101)!.address, addr);
  // applyToBounty mirrors the wallet onto the CONTRIBUTOR account (the session's id).
  assert.equal(db.find("users", (u) => u.id === DEV_C.id)!.stellarPayoutAddress, addr);
});

test("delegate resolves the applicant's CONTRIBUTOR wallet, not a same-githubId maintainer's", async () => {
  // DEV_C (contributor) applies with the right wallet; a same-githubId maintainer
  // account carries a decoy wallet the money path must never pick.
  const b = mkOpenBounty();
  const right = ADDR();
  db.insert("users", {
    id: "dev-maint", githubId: 101, githubLogin: "dev-maint", email: "dm@e.com",
    plan: "free", createdAt: Date.now(), accountKind: "maintainer", stellarPayoutAddress: ADDR(),
  } as any);
  assert.equal((await applyAs(b.id, DEV_C.id, { address: right })).status, 200);

  const res = await sponsorPost(`/api/bounties/${b.id}/applications/101/approve`, SPONSOR_M.id);
  assert.equal(res.status, 200);
  const delegated = db.find("bounties", (x) => x.id === b.id)!;
  assert.equal(delegated.status, "DELEGATED");
  assert.equal(delegated.assigneeAddress, right, "the contributor's applied wallet was snapshotted");
});
