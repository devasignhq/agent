// Auth + flow gating on the timeline-extension endpoints, through the real
// Express router with real signed session cookies (same harness as
// bounties-submission.test.ts). Chain-free by design: extensions never touch
// Soroban. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-extension.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import type { Bounty } from "../types.js";
import { bounties as bountiesRouter } from "./bounties.js";
import { contributorBountyView } from "./contributor.js";

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

const DEV = { id: uuid(), githubId: 100, githubLogin: "devon" };
const SPONSOR = { id: uuid(), githubId: 300, githubLogin: "maya" };
const RIVAL = { id: uuid(), githubId: 200, githubLogin: "rival" };

let seq = 0;
function mkBounty(patch: Partial<Bounty> = {}): Bounty {
  seq++;
  return db.insert("bounties", {
    id: uuid(), seq, code: `BNTY-${seq}`, source: "github", installationId: 1,
    repo: "acme/pay", issueNumber: seq, issueUrl: `https://github.com/acme/pay/issues/${seq}`,
    title: `Bounty ${seq}`, description: "", acceptance: ["works"],
    sponsorUserId: SPONSOR.id, sponsorAddress: "GSPONSOR", taskId: "T".repeat(25),
    contractId: "C1", amountStroops: "5000000000", amountUsdc: 500, deliveryDays: 7,
    status: "DELEGATED", onchainStatus: "Open",
    applications: [
      { githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" },
      { githubId: RIVAL.githubId, githubLogin: RIVAL.githubLogin, appliedAt: 1, status: "pending" },
    ],
    assigneeGithubId: DEV.githubId, assigneeGithubLogin: DEV.githubLogin,
    assigneeAddress: "GDEV", acceptedAt: Date.now(), deadlineAt: Date.now() + 86_400_000,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...patch,
  } as Bounty);
}

beforeEach(() => {
  db.remove("users", () => true);
  db.remove("bounties", () => true);
  db.remove("notifications", () => true);
  for (const u of [DEV, SPONSOR, RIVAL]) {
    db.insert("users", { id: u.id, githubId: u.githubId, githubLogin: u.githubLogin, email: `${u.githubLogin}@e.com`, plan: "free", createdAt: Date.now() } as any);
  }
});

test("request-extension: 401 unauthenticated, 403 non-assignee, 400 bad payload", async () => {
  const b = mkBounty();
  assert.equal((await dispatch("POST", `/bounties/${b.id}/request-extension`)).statusCode, 401);

  const rival = await dispatch("POST", `/bounties/${b.id}/request-extension`, { userId: RIVAL.id, body: { days: 2, reason: "x" } });
  assert.equal(rival.statusCode, 403);
  assert.equal(rival.body.error, "not_assignee");

  const badDays = await dispatch("POST", `/bounties/${b.id}/request-extension`, { userId: DEV.id, body: { days: 9, reason: "x" } });
  assert.equal(badDays.statusCode, 400);
  assert.equal(badDays.body.error, "invalid_days");

  const noReason = await dispatch("POST", `/bounties/${b.id}/request-extension`, { userId: DEV.id, body: { days: 2, reason: " " } });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.body.error, "missing_reason");
});

test("request → sponsor bell → approve moves the deadline → contributor bell", async () => {
  const b = mkBounty();
  const originalDeadline = b.deadlineAt!;

  const r = await dispatch("POST", `/bounties/${b.id}/request-extension`, {
    userId: DEV.id, body: { days: 3, reason: "upstream API slipped" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.bounty.extension.status, "pending");

  // The sponsor got a bell notification.
  const sponsorBells = db.filter("notifications", (n: any) => n.userId === SPONSOR.id);
  assert.equal(sponsorBells.length, 1);
  assert.match(sponsorBells[0].title, /requested a 3-day extension/);

  // A rival can't respond; the sponsor can.
  assert.equal((await dispatch("POST", `/bounties/${b.id}/extension/approve`, { userId: RIVAL.id })).statusCode, 403);
  assert.equal((await dispatch("POST", `/bounties/${b.id}/extension/bogus`, { userId: SPONSOR.id })).body.error, "bad_action");

  const ok = await dispatch("POST", `/bounties/${b.id}/extension/approve`, { userId: SPONSOR.id });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.bounty.extension.status, "approved");
  assert.equal(ok.body.bounty.deadlineAt, originalDeadline + 3 * 86_400_000);

  // The contributor got the approval bell.
  const devBells = db.filter("notifications", (n: any) => n.userId === DEV.id);
  assert.equal(devBells.length, 1);
  assert.match(devBells[0].title, /approved/);

  // Second approval attempt 400s — nothing pending anymore.
  assert.equal((await dispatch("POST", `/bounties/${b.id}/extension/approve`, { userId: SPONSOR.id })).statusCode, 400);
});

test("decline keeps the deadline and notifies the contributor", async () => {
  const b = mkBounty();
  const originalDeadline = b.deadlineAt!;
  await dispatch("POST", `/bounties/${b.id}/request-extension`, { userId: DEV.id, body: { days: 2, reason: "busy" } });

  const r = await dispatch("POST", `/bounties/${b.id}/extension/decline`, { userId: SPONSOR.id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.bounty.extension.status, "declined");
  assert.equal(r.body.bounty.deadlineAt, originalDeadline);
  assert.match(db.filter("notifications", (n: any) => n.userId === DEV.id)[0].title, /declined/);
});

test("contributor view: assignee sees the extension + its events; a rival sees neither", async () => {
  const b = mkBounty();
  await dispatch("POST", `/bounties/${b.id}/request-extension`, { userId: DEV.id, body: { days: 2, reason: "I was sick" } });
  const row = db.find("bounties", (x) => x.id === b.id)!;

  const mine = contributorBountyView(row, DEV.githubId);
  assert.equal(mine.extension!.reason, "I was sick");
  assert.ok(mine.events.some((e) => e.kind === "extension_requested"));

  const theirs = contributorBountyView(row, RIVAL.githubId);
  assert.equal(theirs.extension, null);
  assert.ok(!theirs.events.some((e) => e.kind === "extension_requested"), "reason must not leak to rivals");
});
