// Contributor route scoping: a contributor sees only bounties they applied to
// or were assigned, only their OWN application entry (never other applicants),
// wallet fields only when they're the assignee, and only their own payout rows.
// Runs fully in-memory with real signed session cookies (the me-auth pattern).
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/contributor.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import type { Bounty } from "../types.js";
import {
  contributorBountiesHandler,
  contributorTransactionsHandler,
  contributorBountyView,
  contributorSummary,
} from "./contributor.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const reqFor = (userId: string): any => ({ cookies: { devasign_session: signSession(userId) } });

const DEV = { id: uuid(), githubId: 100, githubLogin: "devon" };
const OTHER = { id: uuid(), githubId: 200, githubLogin: "rival" };

function mkUser(u: typeof DEV) {
  db.insert("users", { id: u.id, githubId: u.githubId, githubLogin: u.githubLogin, email: `${u.githubLogin}@e.com`, plan: "free", createdAt: Date.now() } as any);
}

let seq = 0;
function mkBounty(patch: Partial<Bounty>): Bounty {
  seq++;
  return db.insert("bounties", {
    id: uuid(),
    seq,
    code: `BNTY-${seq}`,
    source: "github",
    installationId: 1,
    repo: "acme/pay",
    issueNumber: seq,
    issueUrl: `https://github.com/acme/pay/issues/${seq}`,
    title: `Bounty ${seq}`,
    description: "",
    acceptance: ["works"],
    sponsorUserId: "sponsor-user",
    sponsorAddress: "GSPONSOR",
    taskId: "T".repeat(25),
    contractId: "C1",
    amountStroops: "5000000000",
    amountUsdc: 500,
    deliveryDays: 7,
    status: "OPEN",
    onchainStatus: "Open",
    applications: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  } as Bounty);
}

beforeEach(() => {
  db.remove("users", () => true);
  db.remove("bounties", () => true);
  db.remove("escrowTransactions", () => true);
  mkUser(DEV);
  mkUser(OTHER);
});

test("401 without a session; 400 without a GitHub identity", () => {
  const res = fakeRes();
  contributorBountiesHandler({ cookies: {} } as any, res);
  assert.equal(res.statusCode, 401);

  const ghost = { id: uuid(), githubId: null, githubLogin: "", email: "x@e.com", plan: "free", createdAt: 0 };
  db.insert("users", ghost as any);
  const res2 = fakeRes();
  contributorBountiesHandler(reqFor(ghost.id), res2);
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.error, "no_github_identity");
});

test("list is scoped to my applications/assignments and hides other applicants", () => {
  // Mine (applied), mine (assigned), and someone else's — only two come back.
  mkBounty({
    applications: [
      { githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "pending" },
      { githubId: OTHER.githubId, githubLogin: OTHER.githubLogin, appliedAt: 2, status: "pending" },
    ],
  });
  mkBounty({
    status: "DELEGATED",
    assigneeGithubId: DEV.githubId,
    assigneeGithubLogin: DEV.githubLogin,
    assigneeAddress: "GDEVWALLET",
    assigneeMemo: "devon-memo",
    applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
  });
  mkBounty({
    applications: [{ githubId: OTHER.githubId, githubLogin: OTHER.githubLogin, appliedAt: 1, status: "pending" }],
  });

  const res = fakeRes();
  contributorBountiesHandler(reqFor(DEV.id), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bounties.length, 2);
  const json = JSON.stringify(res.body);
  assert.ok(!json.includes(OTHER.githubLogin), "other applicants must not appear");
  for (const b of res.body.bounties) {
    assert.equal(b.myApplication.githubId, DEV.githubId);
    assert.equal(b.applications, undefined, "raw applications array never serialized");
  }
});

test("wallet fields surface only for the assignee", () => {
  const assigned = mkBounty({
    status: "DELEGATED",
    assigneeGithubId: DEV.githubId,
    assigneeGithubLogin: DEV.githubLogin,
    assigneeAddress: "GDEVWALLET",
    assigneeMemo: "devon-memo",
    applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
  });
  const asAssignee = contributorBountyView(assigned, DEV.githubId);
  assert.equal(asAssignee.assigneeAddress, "GDEVWALLET");
  assert.equal(asAssignee.assigneeMemo, "devon-memo");
  // A different applicant on the same bounty must not see the assignee's wallet.
  const asOther = contributorBountyView(assigned, OTHER.githubId);
  assert.equal(asOther.assigneeAddress, null);
  assert.equal(asOther.assigneeMemo, null);
});

// Supporting links are the assignee's submitted work evidence — an unlisted
// demo, a preview deploy, a design doc. involvesContributor() keeps every
// rejected applicant subscribed to the bounty, so without a gate they keep
// receiving whoever won it delivering it.
test("submitted work links surface only for the assignee", () => {
  const assigned = mkBounty({
    status: "IN_REVIEW",
    assigneeGithubId: DEV.githubId,
    assigneeGithubLogin: DEV.githubLogin,
    prNumber: 42,
    submittedAt: Date.now(),
    supportingLinks: [{ type: "Demo", url: "https://preview.example.com/unlisted", addedAt: 1 }],
    applications: [
      { githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" },
      { githubId: OTHER.githubId, githubLogin: OTHER.githubLogin, appliedAt: 2, status: "rejected" },
    ],
  });
  const asAssignee = contributorBountyView(assigned, DEV.githubId);
  assert.deepEqual(
    asAssignee.supportingLinks.map((l) => l.url),
    ["https://preview.example.com/unlisted"],
    "the assignee still gets their own links (the submit modal prefills from them)"
  );

  const asOther = contributorBountyView(assigned, OTHER.githubId);
  assert.deepEqual(asOther.supportingLinks, [], "a losing applicant must not receive them");
  assert.ok(
    !JSON.stringify(asOther).includes("preview.example.com"),
    "the URL must not survive anywhere in the payload"
  );
});

test("summary: active/applied/completed and escrow/earned sums", () => {
  const mine = (patch: Partial<Bounty>) =>
    mkBounty({
      assigneeGithubId: DEV.githubId,
      applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
      ...patch,
    });
  const list = [
    mine({ status: "DELEGATED", amountUsdc: 100 }),
    mine({ status: "IN_REVIEW", amountUsdc: 200 }),
    mine({ status: "PAID", amountUsdc: 300 }),
    mkBounty({ status: "OPEN", applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "pending" }] }),
    // Rejected application on an OPEN bounty does NOT count as applied.
    mkBounty({ status: "OPEN", applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "rejected" }] }),
  ];
  const s = contributorSummary(list, DEV.githubId);
  assert.deepEqual(s, { active: 2, applied: 1, completed: 1, inEscrowUsdc: 300, lifetimeEarnedUsdc: 300 });
});

test("events: rival applicants' application events are filtered; lifecycle events pass", () => {
  const bounty = mkBounty({
    applications: [
      { githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "pending" },
      { githubId: OTHER.githubId, githubLogin: OTHER.githubLogin, appliedAt: 2, status: "pending" },
    ],
    events: [
      { at: 1, kind: "created", actor: "maya" },
      { at: 2, kind: "funded", actor: "system" },
      { at: 3, kind: "applied", actor: DEV.githubLogin, subject: DEV.githubLogin },
      { at: 4, kind: "applied", actor: OTHER.githubLogin, subject: OTHER.githubLogin },
      { at: 5, kind: "application_rejected", actor: "maya", subject: OTHER.githubLogin },
    ],
  } as any);
  const v = contributorBountyView(bounty, DEV.githubId);
  const kinds = v.events.map((e: any) => `${e.kind}:${e.subject ?? e.actor ?? ""}`);
  assert.deepEqual(kinds, ["created:maya", "funded:system", `applied:${DEV.githubLogin}`]);
});

// The activity-log filter keys on subjectGithubId, not the login: applying
// again after a GitHub rename rewrites the application row (applyToBounty
// replaces it wholesale), and GitHub hands abandoned usernames to new accounts.
const evKinds = (b: Bounty, githubId: number) =>
  contributorBountyView(b, githubId).events.map((e: any) => e.kind);

test("events: re-applying under a new login keeps the earlier application history", () => {
  // Applied as "devon-old", was rejected, renamed, applied again. The row now
  // carries the new login; the first two events still carry the old one.
  const bounty = mkBounty({
    applications: [
      { githubId: DEV.githubId, githubLogin: "devon-new", appliedAt: 3, status: "pending" },
    ],
    events: [
      { at: 1, kind: "applied", actor: "devon-old", subject: "devon-old", subjectGithubId: DEV.githubId },
      { at: 2, kind: "application_rejected", actor: "maya", subject: "devon-old", subjectGithubId: DEV.githubId },
      { at: 3, kind: "applied", actor: "devon-new", subject: "devon-new", subjectGithubId: DEV.githubId },
    ],
  } as any);

  assert.deepEqual(evKinds(bounty, DEV.githubId), ["applied", "application_rejected", "applied"]);
  assert.deepEqual(evKinds(bounty, OTHER.githubId), [], "still nothing for a rival");
});

test("events: a recycled login sees neither applicant's application events", () => {
  // Legacy events (no subjectGithubId) whose login matches TWO applications —
  // the previous holder of the name and whoever claimed it. Ambiguous, so it
  // resolves to nobody rather than to both.
  const bounty = mkBounty({
    applications: [
      { githubId: DEV.githubId, githubLogin: "shared", appliedAt: 1, status: "rejected" },
      { githubId: OTHER.githubId, githubLogin: "shared", appliedAt: 2, status: "pending" },
    ],
    events: [
      { at: 1, kind: "funded", actor: "system" },
      { at: 2, kind: "applied", actor: "shared", subject: "shared" },
      { at: 3, kind: "application_rejected", actor: "maya", subject: "shared" },
      { at: 4, kind: "applied", actor: "shared", subject: "shared" },
    ],
  } as any);

  assert.deepEqual(evKinds(bounty, DEV.githubId), ["funded"]);
  assert.deepEqual(evKinds(bounty, OTHER.githubId), ["funded"]);
});

test("events: a stamped subject disambiguates a shared login exactly", () => {
  // Same collision, but the events know who they are: each side sees only its
  // own, and the withholding above is confined to pre-stamp events.
  const bounty = mkBounty({
    applications: [
      { githubId: DEV.githubId, githubLogin: "shared", appliedAt: 1, status: "rejected" },
      { githubId: OTHER.githubId, githubLogin: "shared", appliedAt: 2, status: "pending" },
    ],
    events: [
      { at: 1, kind: "applied", actor: "shared", subject: "shared", subjectGithubId: DEV.githubId },
      { at: 2, kind: "application_rejected", actor: "maya", subject: "shared", subjectGithubId: DEV.githubId },
      { at: 3, kind: "applied", actor: "shared", subject: "shared", subjectGithubId: OTHER.githubId },
    ],
  } as any);

  assert.deepEqual(evKinds(bounty, DEV.githubId), ["applied", "application_rejected"]);
  assert.deepEqual(evKinds(bounty, OTHER.githubId), ["applied"]);
});

test("derived timestamps: awardedAt from events, paid/funded fall back to ledger confirms", () => {
  const bounty = mkBounty({
    status: "PAID",
    assigneeGithubId: DEV.githubId,
    assigneeGithubLogin: DEV.githubLogin,
    applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
    events: [
      { at: 10, kind: "funded", actor: "system" },
      { at: 20, kind: "application_approved", actor: "maya", subject: DEV.githubLogin },
    ],
  } as any);
  // No "paid" event (legacy) — the confirmed release txn supplies paidAt.
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: bounty.id, githubLogin: DEV.githubLogin, kind: "payout",
    idempotencyKey: `release:${bounty.taskId}`, signer: "admin", status: "confirmed",
    amountStroops: "1", dir: "out", createdAt: 30, confirmedAt: 42,
  } as any);
  const v = contributorBountyView(bounty, DEV.githubId);
  assert.equal(v.fundedAt, 10);
  assert.equal(v.awardedAt, 20);
  assert.equal(v.paidAt, 42, "legacy paidAt from the release txn confirm");
});

test("sponsorLogin resolves the creator's user, else the installation account", () => {
  db.insert("users", { id: "sponsor-user", githubId: 300, githubLogin: "maya", email: "m@e.com", plan: "free", createdAt: 0 } as any);
  const viaUser = contributorBountyView(mkBounty({}), DEV.githubId);
  assert.equal(viaUser.sponsorLogin, "maya");

  db.remove("users", (u) => u.id === "sponsor-user");
  db.insert("installations", { id: "i1", userId: "", accountId: 1, accountLogin: "acme", accountType: "Organization", installationId: 1, repoIds: [] } as any);
  const viaInstall = contributorBountyView(mkBounty({}), DEV.githubId);
  assert.equal(viaInstall.sponsorLogin, "acme");
  db.remove("installations", () => true);
});

test("review projection joins the PR review server-side (prTitle, summary, counts)", () => {
  const bounty = mkBounty({
    status: "IN_REVIEW",
    prNumber: 7,
    assigneeGithubId: DEV.githubId,
    applications: [{ githubId: DEV.githubId, githubLogin: DEV.githubLogin, appliedAt: 1, status: "accepted" }],
  });
  const repo = db.insert("repositories", { id: uuid(), installationId: "x", owner: "acme", name: "pay", private: false, reviewsEnabled: true, indexState: "none" } as any);
  db.insert("prReviews", {
    id: uuid(), repoId: repo.id, prNumber: 7, prTitle: "feat: idempotency keys",
    headSha: "abc", baseSha: "def", status: "changes_requested",
    verdict: "Core is solid; one test missing.", bountyId: bounty.id,
    criteria: [
      { id: "bounty-1", text: "a", met: true, evidence: "ok" },
      { id: "bounty-2", text: "b", met: false, evidence: "missing" },
    ],
    taskId: null, additions: 1, deletions: 1, changedFiles: 1,
    createdAt: 0, updatedAt: 1,
  } as any);
  const v = contributorBountyView(bounty, DEV.githubId);
  assert.equal(v.review!.prTitle, "feat: idempotency keys");
  assert.equal(v.review!.summary, "Core is solid; one test missing.");
  assert.deepEqual(v.review!.counts, { met: 1, unmet: 1, pending: 0, total: 2 });
  db.remove("repositories", () => true);
  db.remove("prReviews", () => true);
});

test("transactions: only my payouts, with dest snapshot and bounty join", () => {
  const b = mkBounty({
    status: "PAID",
    assigneeGithubId: DEV.githubId,
    assigneeGithubLogin: DEV.githubLogin,
    assigneeAddress: "GFALLBACK",
    assigneeMemo: "fallback-memo",
  });
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: b.id, githubLogin: DEV.githubLogin, kind: "payout",
    idempotencyKey: `release:${b.taskId}-1`, signer: "admin", status: "confirmed",
    hash: "PAYHASH", amountStroops: "5000000000", dir: "out",
    createdAt: 10, confirmedAt: 11, destAddress: "GSNAPSHOT", destMemo: "snap-memo",
  } as any);
  // A legacy payout row without a dest snapshot → falls back to the bounty's.
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: b.id, githubLogin: DEV.githubLogin, kind: "payout",
    idempotencyKey: `release:${b.taskId}-2`, signer: "admin", status: "confirmed",
    hash: "PAYHASH2", amountStroops: "5000000000", dir: "out", createdAt: 5,
  } as any);
  // Someone else's payout and my escrow-kind row must both be excluded. The
  // other payout hangs off a bounty assigned to OTHER — a payout to OTHER on a
  // bounty delegated to DEV is not a state the lifecycle can produce.
  const otherBounty = mkBounty({
    status: "PAID",
    assigneeGithubId: OTHER.githubId,
    assigneeGithubLogin: OTHER.githubLogin,
  });
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: otherBounty.id, githubId: OTHER.githubId,
    githubLogin: OTHER.githubLogin, kind: "payout",
    idempotencyKey: "release:other", signer: "admin", status: "confirmed",
    amountStroops: "1", dir: "out", createdAt: 1,
  } as any);
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: b.id, githubLogin: DEV.githubLogin, kind: "escrow",
    idempotencyKey: "escrow:x", signer: "sponsor", status: "confirmed",
    amountStroops: "1", dir: "out", createdAt: 1,
  } as any);

  const res = fakeRes();
  contributorTransactionsHandler(reqFor(DEV.id), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.transactions.length, 2);
  const [snap, legacy] = res.body.transactions; // newest first
  assert.equal(snap.dest.address, "GSNAPSHOT");
  assert.equal(snap.dest.memo, "snap-memo");
  assert.equal(snap.amountUsdc, 500);
  assert.equal(snap.repo, "acme/pay");
  assert.equal(legacy.dest.address, "GFALLBACK");
  assert.equal(legacy.dest.memo, "fallback-memo");
  assert.ok(res.body.explorerBase.startsWith("https://stellar.expert/explorer/"));
});

// ── ledger identity ──────────────────────────────────────────────────────────
// The ledger keys on the stable numeric githubId, never the login: logins are
// rewritten on sign-in after a GitHub rename, and GitHub recycles abandoned
// logins to new accounts. Both directions are money-visible, so both are pinned.

// A payout row against a bounty delegated to DEV, in either vintage: `stamped`
// carries the githubId written at send time, `legacy` predates that field and
// must resolve through the bounty.
function mkPaidBountyFor(who: typeof DEV, assigneeLogin = who.githubLogin) {
  return mkBounty({
    status: "PAID",
    assigneeGithubId: who.githubId,
    assigneeGithubLogin: assigneeLogin,
  });
}
function mkPayout(bountyId: string, patch: Record<string, unknown> = {}) {
  return db.insert("escrowTransactions", {
    id: uuid(), bountyId, kind: "payout", idempotencyKey: `release:${uuid()}`,
    signer: "admin", status: "confirmed", hash: "PAYHASH",
    amountStroops: "5000000000", dir: "out", createdAt: 10, confirmedAt: 11,
    ...patch,
  } as any);
}
function ledgerFor(userId: string) {
  const res = fakeRes();
  contributorTransactionsHandler(reqFor(userId), res);
  return res;
}

test("ledger: a renamed contributor keeps their payout history", () => {
  // The row froze the old login at send time; the user row has since been
  // rewritten by the OAuth callback. Matching on login would return nothing.
  const b = mkPaidBountyFor(DEV, "devon-old");
  mkPayout(b.id, { githubLogin: "devon-old" });
  db.update("users", (u) => u.id === DEV.id, { githubLogin: "devon-new" } as any);

  const res = ledgerFor(DEV.id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.transactions.length, 1, "rename must not erase the ledger");
  assert.equal(res.body.transactions[0].hash, "PAYHASH");
});

test("ledger: a recycled login is served none of the previous holder's payouts", () => {
  // DEV renames away; a brand-new account claims the freed login. It shares
  // nothing with DEV but the string, and must see nothing.
  const b = mkPaidBountyFor(DEV);
  mkPayout(b.id, {
    githubId: DEV.githubId, githubLogin: DEV.githubLogin,
    destAddress: "GSECRETWALLET", destMemo: "secret-memo",
  });
  db.update("users", (u) => u.id === DEV.id, { githubLogin: "devon-renamed" } as any);
  const RECYCLER = { id: uuid(), githubId: 999, githubLogin: DEV.githubLogin };
  mkUser(RECYCLER);

  const stranger = ledgerFor(RECYCLER.id);
  assert.equal(stranger.statusCode, 200);
  assert.equal(stranger.body.transactions.length, 0);
  assert.ok(
    !JSON.stringify(stranger.body).includes("GSECRETWALLET"),
    "the previous holder's wallet address must not leak to a recycled login"
  );
  // ...and the rename did not cost DEV the row.
  assert.equal(ledgerFor(DEV.id).body.transactions.length, 1);
});

test("ledger: unstamped rows resolve through the bounty, never the row's login", () => {
  // Deliberately mismatched login on the row: if it were consulted at all this
  // would land in the wrong ledger (or no ledger).
  const b = mkPaidBountyFor(DEV);
  mkPayout(b.id, { githubLogin: "somebody-else" });

  assert.equal(ledgerFor(DEV.id).body.transactions.length, 1);
  assert.equal(ledgerFor(OTHER.id).body.transactions.length, 0);
});

test("ledger: the stamped counterparty wins over the bounty's current assignee", () => {
  // The row records who was actually paid; a later reassignment must not hand
  // the payment history to the new assignee.
  const b = mkPaidBountyFor(OTHER);
  mkPayout(b.id, { githubId: DEV.githubId, githubLogin: DEV.githubLogin });

  assert.equal(ledgerFor(DEV.id).body.transactions.length, 1);
  assert.equal(ledgerFor(OTHER.id).body.transactions.length, 0);
});

test("ledger: a payout that resolves to nobody is served to nobody", () => {
  // Fail closed. Neither a stamp nor a resolvable bounty, and a login that
  // would have matched DEV under the old filter — this is the shape a recycled
  // login exploits, so it must reach no one rather than fall back to the login.
  mkPayout("ghost-bounty-id", { githubLogin: DEV.githubLogin });
  db.insert("escrowTransactions", {
    id: uuid(), bountyId: null, githubLogin: DEV.githubLogin, kind: "payout",
    idempotencyKey: "release:orphan", signer: "admin", status: "confirmed",
    amountStroops: "1", dir: "out", createdAt: 9,
  } as any);

  assert.equal(ledgerFor(DEV.id).body.transactions.length, 0);
  assert.equal(ledgerFor(OTHER.id).body.transactions.length, 0);
});

test("ledger: an unresolvable payout warns once per row, not once per fetch", () => {
  // The check runs inside a db.filter, so an unthrottled warning would fire for
  // every contributor on every request for as long as the row exists.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  try {
    mkPayout("ghost-bounty-throttle", { githubLogin: DEV.githubLogin });
    ledgerFor(DEV.id);
    ledgerFor(DEV.id);
    ledgerFor(OTHER.id);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, "three fetches, one warning");
  assert.match(warnings[0], /no resolvable counterparty id/);
});
