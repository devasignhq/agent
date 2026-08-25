// The fund/cancel link tokens are published in a PUBLIC GitHub issue comment
// (botcomment.ts:renderConfirmBody), so a token proves nothing about who is
// holding it. These routes must authorize on the sponsor's session and use the
// token only to scope the action to one bounty. Regression cover for the case
// where the token alone cancelled a funded escrow.
// Same harness as bounties-apply.test.ts (throwaway app, real signed cookies).
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-link-auth.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import type { Server, AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { db } from "../db.js";
import { config } from "../config.js";
import { signSession } from "../github/oauth.js";
import { mintBountyLinkToken } from "../bounties/links.js";
import type { Bounty } from "../types.js";
import { bounties } from "./bounties.js";

let server: Server;
let base = "";

const INSTALL = 4242;
const SPONSOR = { id: "sponsor-m", githubId: 500 };
const STRANGER = { id: "stranger-m", githubId: 900 };

before(async () => {
  // Left unconfigured on purpose: a PENDING_FUNDING cancel then skips the on-chain
  // orphan probe, and every assertion here is about authorization, not the chain.
  config.stellar.rpcUrl = "";
  config.stellar.contractId = "";
  config.stellar.usdcSac = "";
  config.stellar.adminSecret = "";

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

function mkUser(id: string, githubId: number) {
  db.insert("users", {
    id, githubId, githubLogin: id, email: `${id}@e.com`,
    plan: "free", createdAt: Date.now(), accountKind: "maintainer",
  } as any);
}

function mkPendingBounty(): Bounty {
  return db.insert("bounties", {
    id: uuid(), seq: 1, code: "BNTY-1", source: "github", installationId: INSTALL,
    repo: "acme/app", issueNumber: 7, issueUrl: "https://github.com/acme/app/issues/7",
    title: "Fix the thing", description: "", acceptance: ["works"],
    sponsorUserId: SPONSOR.id, sponsorAddress: "GSPONSOR", taskId: "T".repeat(25),
    contractId: "C1", amountStroops: "1000000000", amountUsdc: 100, deliveryDays: 7,
    status: "PENDING_FUNDING", onchainStatus: null, applications: [],
    botCommentId: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
}

const statusOf = (id: string) => db.find("bounties", (b: any) => b.id === id)?.status;

// `cookie: null` is the attacker who scraped the token out of the public comment.
function post(path: string, body: Record<string, unknown>, userId: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: config.webOrigin };
  if (userId) headers.Cookie = `devasign_session=${signSession(userId)}`;
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(path: string, userId: string | null) {
  const headers: Record<string, string> = { Origin: config.webOrigin };
  if (userId) headers.Cookie = `devasign_session=${signSession(userId)}`;
  return fetch(`${base}${path}`, { headers });
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("users", () => true);
  db.remove("installations", () => true);
  mkUser(SPONSOR.id, SPONSOR.githubId);
  mkUser(STRANGER.id, STRANGER.githubId);
  db.insert("installations", {
    id: uuid(), userId: SPONSOR.id, accountId: 1, accountLogin: "acme",
    installationId: INSTALL, repoIds: [],
  } as any);
});

test("cancel: a valid public token with no session cannot cancel", async () => {
  const b = mkPendingBounty();
  const token = mintBountyLinkToken(b.id, "cancel");
  const res = await post(`/api/bounties/${b.id}/cancel`, { token }, null);
  assert.equal(res.status, 401);
  assert.equal(statusOf(b.id), "PENDING_FUNDING");
});

test("cancel: a signed-in non-sponsor holding the token cannot cancel", async () => {
  const b = mkPendingBounty();
  const token = mintBountyLinkToken(b.id, "cancel");
  const res = await post(`/api/bounties/${b.id}/cancel`, { token }, STRANGER.id);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
  assert.equal(statusOf(b.id), "PENDING_FUNDING");
});

test("cancel: the sponsor still cancels normally", async () => {
  const b = mkPendingBounty();
  const token = mintBountyLinkToken(b.id, "cancel");
  const res = await post(`/api/bounties/${b.id}/cancel`, { token }, SPONSOR.id);
  assert.equal(res.status, 200);
  assert.notEqual(statusOf(b.id), "PENDING_FUNDING");
});

test("cancel: a sponsor's token for one bounty does not cancel another", async () => {
  const mine = mkPendingBounty();
  const other = mkPendingBounty();
  const token = mintBountyLinkToken(mine.id, "cancel");
  const res = await post(`/api/bounties/${other.id}/cancel`, { token }, SPONSOR.id);
  assert.equal(res.status, 403);
  assert.equal(statusOf(other.id), "PENDING_FUNDING");
});

test("funding-tx: the public fund token does not authorize a build", async () => {
  const b = mkPendingBounty();
  const token = mintBountyLinkToken(b.id, "fund");
  const anon = await get(`/api/bounties/${b.id}/funding-tx?token=${encodeURIComponent(token)}&address=GX`, null);
  assert.equal(anon.status, 401);
  const stranger = await get(`/api/bounties/${b.id}/funding-tx?token=${encodeURIComponent(token)}&address=GX`, STRANGER.id);
  assert.equal(stranger.status, 403);
});

test("funding-submit: the public fund token does not authorize a submit", async () => {
  const b = mkPendingBounty();
  const token = mintBountyLinkToken(b.id, "fund");
  const anon = await post(`/api/bounties/${b.id}/funding-submit`, { token, signedXdr: "AAAA" }, null);
  assert.equal(anon.status, 401);
  const stranger = await post(`/api/bounties/${b.id}/funding-submit`, { token, signedXdr: "AAAA" }, STRANGER.id);
  assert.equal(stranger.status, 403);
});
