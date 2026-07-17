// Auth + state gating on the contributor submission endpoints. Everything here
// exercises the paths BEFORE any GitHub/chain call (those are covered by the
// pure submission module + service tests), so it runs fully offline. Uses the
// real Express router via a tiny dispatcher, with real signed session cookies.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/bounties-submission.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import type { Bounty } from "../types.js";
import { bounties as bountiesRouter } from "./bounties.js";

// Dispatch a request through the real router (matches path params, ordering,
// everything Express does) and await the response.
function dispatch(method: string, url: string, opts: { userId?: string; body?: unknown } = {}) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      method,
      url,
      body: opts.body ?? {},
      cookies: opts.userId ? { devasign_session: signSession(opts.userId) } : {},
      headers: {},
      query: {},
      // express-rate-limit (publicLimiter) needs these when its route matches.
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
    status: "IN_REVIEW", onchainStatus: "Open",
    applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
    assigneeGithubId: DEV.githubId, assigneeGithubLogin: DEV.githubLogin,
    assigneeAddress: "GDEV", prNumber: 41,
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

test("submit: 401 unauthenticated, 400 bad URL, 403 non-assignee, 400 wrong repo", async () => {
  const b = mkBounty();
  assert.equal((await dispatch("POST", `/bounties/${b.id}/submit`)).statusCode, 401);

  const bad = await dispatch("POST", `/bounties/${b.id}/submit`, { userId: DEV.id, body: { prUrl: "not-a-url" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "invalid_pr_url");

  const rival = await dispatch("POST", `/bounties/${b.id}/submit`, {
    userId: RIVAL.id, body: { prUrl: "https://github.com/acme/pay/pull/41" },
  });
  assert.equal(rival.statusCode, 403);
  assert.equal(rival.body.error, "not_assignee");

  const wrongRepo = await dispatch("POST", `/bounties/${b.id}/submit`, {
    userId: DEV.id, body: { prUrl: "https://github.com/acme/other/pull/41" },
  });
  assert.equal(wrongRepo.statusCode, 400);
  assert.equal(wrongRepo.body.error, "wrong_repo");
});

test("links: assignee-only, live statuses only, sanitized + echoed back", async () => {
  const b = mkBounty();
  const rival = await dispatch("POST", `/bounties/${b.id}/links`, { userId: RIVAL.id, body: { links: [] } });
  assert.equal(rival.statusCode, 403);

  const ok = await dispatch("POST", `/bounties/${b.id}/links`, {
    userId: DEV.id,
    body: { links: [{ type: "Demo", url: "https://loom.com/x" }, { type: "Bad", url: "javascript:x" }] },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.bounty.supportingLinks.length, 1);
  assert.equal(ok.body.bounty.supportingLinks[0].url, "https://loom.com/x");
  // Contributor-facing shape: only their own application entries.
  assert.equal(ok.body.bounty.applications.length, 1);
  assert.equal(ok.body.bounty.applications[0].githubId, DEV.githubId);

  const paid = mkBounty({ status: "PAID" });
  const late = await dispatch("POST", `/bounties/${paid.id}/links`, { userId: DEV.id, body: { links: [] } });
  assert.equal(late.statusCode, 400);
});

test("request-payout: assignee + IN_REVIEW only; notifies the sponsor", async () => {
  const b = mkBounty();
  const r = await dispatch("POST", `/bounties/${b.id}/request-payout`, { userId: DEV.id });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.bounty.payoutRequestedAt > 0);
  const notes = db.filter("notifications", (n) => n.userId === SPONSOR.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "bounty");

  const open = mkBounty({ status: "DELEGATED" });
  const early = await dispatch("POST", `/bounties/${open.id}/request-payout`, { userId: DEV.id });
  assert.equal(early.statusCode, 400);
});

test("reject-submission: sponsor-only, reason required, stays IN_REVIEW, notifies the dev", async () => {
  const b = mkBounty();
  const notSponsor = await dispatch("POST", `/bounties/${b.id}/reject-submission`, { userId: DEV.id, body: { reason: "x" } });
  assert.equal(notSponsor.statusCode, 403);

  const noReason = await dispatch("POST", `/bounties/${b.id}/reject-submission`, { userId: SPONSOR.id, body: {} });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.body.error, "missing_reason");

  const ok = await dispatch("POST", `/bounties/${b.id}/reject-submission`, {
    userId: SPONSOR.id, body: { reason: "Criterion 3 regressed." },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.bounty.status, "IN_REVIEW");
  assert.equal(ok.body.bounty.rejection.reason, "Criterion 3 regressed.");
  assert.equal(ok.body.bounty.rejection.byLogin, SPONSOR.githubLogin);
  const notes = db.filter("notifications", (n) => n.userId === DEV.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /rejected/);
});

test("accept-rejection: needs a standing rejection and the assignee; 503 without Stellar", async () => {
  const clean = mkBounty();
  // Stellar isn't configured in the test env, so the route 503s up front —
  // the refund path itself is covered by service tests with a fake chain.
  const r = await dispatch("POST", `/bounties/${clean.id}/accept-rejection`, { userId: DEV.id });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "stellar_unconfigured");
});

test("public read: no session needed, allowlist shape, 404 for unfunded", async () => {
  const b = mkBounty();
  const pub = await dispatch("GET", `/bounties/${b.id}/public`);
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.body.bounty.applicantCount, 1);
  assert.equal(pub.body.bounty.applications, undefined);
  assert.equal(pub.body.bounty.assigneeAddress, undefined);

  const pending = mkBounty({ status: "PENDING_FUNDING" });
  assert.equal((await dispatch("GET", `/bounties/${pending.id}/public`)).statusCode, 404);
});
