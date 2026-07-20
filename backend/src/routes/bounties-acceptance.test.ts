// Auth + lock gating on PATCH /bounties/:id/acceptance. This endpoint edits the
// contract a contributor is PAID against, so the two properties that matter are
// (a) only the sponsor can write it and (b) it slams shut the moment the money
// is committed. Fully offline: the real Express router, real signed session
// cookies, no chain or GitHub calls. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-acceptance.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { MAX_CRITERIA, MAX_CRITERION_CHARS } from "../bounties/acceptance.js";
import type { Bounty } from "../types.js";
import { bounties as bountiesRouter } from "./bounties.js";

function dispatch(method: string, url: string, opts: { userId?: string; body?: unknown } = {}) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      method,
      url,
      body: opts.body ?? {},
      cookies: opts.userId ? { devasign_session: signSession(opts.userId) } : {},
      headers: {},
      query: {},
      ip: "127.0.0.1",
      app: { get: () => undefined },
      get: () => undefined,
    };
    const res: any = { statusCode: 200, headersSent: false };
    res.status = (n: number) => { res.statusCode = n; return res; };
    res.json = (b: unknown) => { resolve({ statusCode: res.statusCode, body: b }); return res; };
    res.setHeader = () => res;
    res.getHeader = () => undefined;
    res.end = () => resolve({ statusCode: res.statusCode, body: undefined });
    bountiesRouter(req, res, (err: unknown) =>
      err ? reject(err) : resolve({ statusCode: 404, body: { error: "unrouted" } })
    );
  });
}

const SPONSOR = { id: uuid(), githubId: 300, githubLogin: "maya" };
const STRANGER = { id: uuid(), githubId: 200, githubLogin: "rival" };

let seq = 0;
function mkBounty(patch: Partial<Bounty> = {}): Bounty {
  seq++;
  return db.insert("bounties", {
    id: uuid(), seq, code: `BNTY-${seq}`, source: "github", installationId: 1,
    repo: "acme/pay", issueNumber: seq, issueUrl: `https://github.com/acme/pay/issues/${seq}`,
    title: `Bounty ${seq}`, description: "", acceptance: ["drafted by the agent"],
    acceptanceState: "ready",
    sponsorUserId: SPONSOR.id, sponsorAddress: null, taskId: `T${seq}`.padEnd(25, "x"),
    contractId: "C1", amountStroops: "5000000000", amountUsdc: 500, deliveryDays: 7,
    status: "PENDING_FUNDING", onchainStatus: null,
    applications: [], events: [],
    createdAt: Date.now(), updatedAt: Date.now(),
    ...patch,
  } as Bounty);
}

beforeEach(() => {
  for (const t of ["users", "bounties", "escrowTransactions", "installations"] as const) {
    db.remove(t as any, () => true);
  }
  for (const u of [SPONSOR, STRANGER]) {
    db.insert("users", {
      id: u.id, githubId: u.githubId, githubLogin: u.githubLogin,
      email: `${u.githubLogin}@e.com`, plan: "free", createdAt: Date.now(),
    } as any);
  }
});

const url = (b: Bounty) => `/bounties/${b.id}/acceptance`;

// ── auth ─────────────────────────────────────────────────────────────────────

test("401 when signed out", async () => {
  const b = mkBounty();
  const r = await dispatch("PATCH", url(b), { body: { acceptance: ["x"] } });
  assert.equal(r.statusCode, 401);
});

test("403 for a signed-in non-sponsor", async () => {
  const b = mkBounty();
  const r = await dispatch("PATCH", url(b), { userId: STRANGER.id, body: { acceptance: ["x"] } });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(db.find("bounties", (x) => x.id === b.id)!.acceptance, ["drafted by the agent"]);
});

test("404 for an unknown bounty", async () => {
  const r = await dispatch("PATCH", `/bounties/${uuid()}/acceptance`, {
    userId: SPONSOR.id,
    body: { acceptance: ["x"] },
  });
  assert.equal(r.statusCode, 404);
});

test("the signed fund-link token does NOT authorize an edit", async () => {
  // The token rides in a PUBLIC GitHub comment. It can fund (which costs the
  // actor their own USDC) but must never let a passer-by reword the contract.
  const b = mkBounty();
  const r = await dispatch("PATCH", url(b), { body: { acceptance: ["vandalized"], token: "anything" } });
  assert.equal(r.statusCode, 401, "no session means no edit, token or not");
});

// ── the lock ─────────────────────────────────────────────────────────────────

test("the sponsor can edit while the bounty is unfunded", async () => {
  const b = mkBounty();
  const r = await dispatch("PATCH", url(b), {
    userId: SPONSOR.id,
    body: { acceptance: ["  the endpoint returns 409  ", "", "the bot comment is rewritten"] },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.bounty.acceptance, ["the endpoint returns 409", "the bot comment is rewritten"]);

  const after = db.find("bounties", (x) => x.id === b.id)!;
  assert.equal(after.acceptanceState, "ready", "so an in-flight draft stands down");
  assert.ok(after.events?.some((e) => e.kind === "criteria_edited" && e.actor === SPONSOR.githubLogin));
});

test("409 once the funding tx hash is recorded", async () => {
  const b = mkBounty({ escrowTxHash: "deadbeef" });
  const r = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: ["too late"] } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_funded");
});

test("409 once an escrow ledger row exists, even with no hash yet", async () => {
  // recordFunding writes the txn row BEFORE it patches the hash; a partial
  // flush can leave the hash absent while the money is already moving.
  const b = mkBounty();
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: b.id, kind: "escrow", idempotencyKey: `escrow:${b.taskId}`,
    signer: "sponsor", status: "pending", dir: "out", amountStroops: b.amountStroops,
    createdAt: Date.now(),
  } as any);

  const r = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: ["too late"] } });
  assert.equal(r.statusCode, 409);
});

test("a FAILED escrow row does not lock — that funding never landed", async () => {
  const b = mkBounty();
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: b.id, kind: "escrow", idempotencyKey: `escrow:${b.taskId}`,
    signer: "sponsor", status: "failed", dir: "out", amountStroops: b.amountStroops,
    createdAt: Date.now(),
  } as any);

  const r = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: ["still mine"] } });
  assert.equal(r.statusCode, 200);
});

test("409 for every status past PENDING_FUNDING", async () => {
  for (const status of ["OPEN", "DELEGATED", "IN_REVIEW", "PAID", "CANCELLED"] as const) {
    const b = mkBounty({ status });
    const r = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: ["nope"] } });
    assert.equal(r.statusCode, 409, `${status} must be locked`);
  }
});

// ── validation ───────────────────────────────────────────────────────────────

test("400 on a non-array, too many, or an over-long criterion", async () => {
  const b = mkBounty();
  const bad = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: "not an array" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "not_an_array");

  const many = await dispatch("PATCH", url(b), {
    userId: SPONSOR.id,
    body: { acceptance: Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => `criterion ${i}`) },
  });
  assert.equal(many.statusCode, 400);
  assert.equal(many.body.error, "too_many");

  const long = await dispatch("PATCH", url(b), {
    userId: SPONSOR.id,
    body: { acceptance: ["ok", "z".repeat(MAX_CRITERION_CHARS + 1)] },
  });
  assert.equal(long.statusCode, 400);
  assert.equal(long.body.error, "too_long");
  assert.equal(long.body.index, 1);
});

test("clearing the list is allowed", async () => {
  const b = mkBounty();
  const r = await dispatch("PATCH", url(b), { userId: SPONSOR.id, body: { acceptance: [] } });
  assert.equal(r.statusCode, 200, "a sponsor deleting every criterion is a valid choice");
  assert.deepEqual(db.find("bounties", (x) => x.id === b.id)!.acceptance, []);
});
