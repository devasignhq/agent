// The merged apply → delegate flow over real HTTP. A contributor applies AND
// binds a payout wallet in one call; the sponsor's single "approve" delegates
// outright (accepts one application, rejects the rest, starts the clock). The
// old separate contributor /accept endpoint is gone.
//
// Mounts the actual `bounties` router on a throwaway app (like rate-limit.test)
// with real signed session cookies (like contributor.test). Stellar is
// configured just enough that requireStellar passes, but usdcIssuer is left
// empty so hasUsdcTrustline short-circuits to `true` with NO network call.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-delegate.test.ts
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
  // Enough for isStellarConfigured() to pass; usdcIssuer stays empty so the
  // trustline probe returns true without hitting Horizon.
  config.stellar.rpcUrl ||= "http://rpc.test";
  config.stellar.contractId ||= "C_TEST";
  config.stellar.usdcSac ||= "C_SAC_TEST";
  config.stellar.adminSecret ||= "S_ADMIN_TEST";
  config.stellar.usdcIssuer = "";

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

const SPONSOR = { id: uuid(), githubId: 500, githubLogin: "sponsor" };
const DEV1 = { id: uuid(), githubId: 101, githubLogin: "dev1" };
const DEV2 = { id: uuid(), githubId: 102, githubLogin: "dev2" };

function mkUser(u: { id: string; githubId: number; githubLogin: string }) {
  db.insert("users", {
    id: u.id, githubId: u.githubId, githubLogin: u.githubLogin,
    email: `${u.githubLogin}@e.com`, plan: "free", createdAt: Date.now(),
  } as any);
}

function mkOpenBounty(): Bounty {
  return db.insert("bounties", {
    id: uuid(), seq: 1, code: "BNTY-1", source: "github", installationId: 1,
    repo: "acme/app", issueNumber: 7, issueUrl: "https://github.com/acme/app/issues/7",
    title: "Fix the thing", description: "", acceptance: ["works"],
    sponsorUserId: SPONSOR.id, sponsorAddress: "GSPONSOR", taskId: "T".repeat(25),
    contractId: "C1", amountStroops: "1000000000", amountUsdc: 100, deliveryDays: 7,
    status: "OPEN", onchainStatus: "Open", applications: [],
    botCommentId: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
}

// A POST carrying `userId`'s signed session cookie.
function post(path: string, userId: string, body: unknown = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `devasign_session=${signSession(userId)}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.remove("bounties", () => true);
  db.remove("users", () => true);
  db.remove("notifications", () => true);
  mkUser(SPONSOR); mkUser(DEV1); mkUser(DEV2);
});

test("apply requires a valid wallet address", async () => {
  const b = mkOpenBounty();
  const res = await post(`/api/bounties/${b.id}/apply`, DEV1.id, {}); // no address
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error?: string }).error, "invalid_address");
  assert.equal(db.find("bounties", (x) => x.id === b.id)!.applications.length, 0);
});

test("apply binds the wallet, and one sponsor click delegates + rejects the rest", async () => {
  const b = mkOpenBounty();
  const addr1 = ADDR();

  // Two contributors apply, each binding a wallet.
  assert.equal((await post(`/api/bounties/${b.id}/apply`, DEV1.id, { address: addr1, memo: "m1" })).status, 200);
  assert.equal((await post(`/api/bounties/${b.id}/apply`, DEV2.id, { address: ADDR() })).status, 200);

  const applied = db.find("bounties", (x) => x.id === b.id)!;
  assert.equal(applied.applications.find((a) => a.githubId === 101)!.address, addr1);

  // The sponsor's single approve delegates outright.
  const res = await post(`/api/bounties/${b.id}/applications/101/approve`, SPONSOR.id);
  assert.equal(res.status, 200);
  const delegated = db.find("bounties", (x) => x.id === b.id)!;
  assert.equal(delegated.status, "DELEGATED");
  assert.equal(delegated.assigneeGithubId, 101);
  assert.equal(delegated.assigneeAddress, addr1, "the applied wallet is snapshotted");
  assert.ok(delegated.deadlineAt, "delivery clock started");
  assert.equal(delegated.applications.find((a) => a.githubId === 101)!.status, "accepted");
  assert.equal(delegated.applications.find((a) => a.githubId === 102)!.status, "rejected", "loser auto-rejected");
});

test("only the sponsor can delegate", async () => {
  const b = mkOpenBounty();
  await post(`/api/bounties/${b.id}/apply`, DEV1.id, { address: ADDR() });
  const res = await post(`/api/bounties/${b.id}/applications/101/approve`, DEV2.id); // not the sponsor
  assert.equal(res.status, 403);
});

test("the old contributor /accept endpoint is gone", async () => {
  const b = mkOpenBounty();
  const res = await post(`/api/bounties/${b.id}/accept`, DEV1.id, { address: ADDR() });
  assert.equal(res.status, 404);
});
