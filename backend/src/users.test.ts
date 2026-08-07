// The two-account resolver helpers: the same githubId owns a maintainer and a
// contributor row, so these must resolve the RIGHT one (and a legacy un-stamped
// row must read as maintainer). Run:
//   DATABASE_URL= node --import tsx/esm --test src/users.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.js";
import {
  accountKindOf,
  maintainerByGithubId,
  contributorByGithubId,
  contributorNotifyTarget,
  backfillAccountKinds,
} from "./users.js";

const GH = 4242;

function mkUser(id: string, kind: "maintainer" | "contributor" | undefined, extra: Record<string, unknown> = {}) {
  db.insert("users", {
    id, githubId: GH, githubLogin: id, email: `${id}@e.com`, plan: "free",
    createdAt: 1, ...(kind ? { accountKind: kind } : {}), ...extra,
  } as any);
}

const NO_INSTALLS = () => 0;
const NO_BOUNTY_ACTIVITY = () => false;

beforeEach(() => {
  db.remove("users", () => true);
  db.remove("installations", () => true);
});

test("accountKindOf treats a missing kind as maintainer, else passes through", () => {
  assert.equal(accountKindOf({ accountKind: undefined } as any), "maintainer");
  assert.equal(accountKindOf({ accountKind: "maintainer" } as any), "maintainer");
  assert.equal(accountKindOf({ accountKind: "contributor" } as any), "contributor");
});

test("maintainerByGithubId finds the maintainer (and legacy) row, never the contributor", () => {
  mkUser("m", "maintainer");
  mkUser("c", "contributor");
  assert.equal(maintainerByGithubId(GH)!.id, "m");
  assert.equal(contributorByGithubId(GH)!.id, "c");
});

test("a legacy un-stamped row resolves as the maintainer, not the contributor", () => {
  mkUser("legacy", undefined);
  assert.equal(maintainerByGithubId(GH)!.id, "legacy");
  assert.equal(contributorByGithubId(GH), null, "un-stamped is NOT a contributor");
});

test("contributorNotifyTarget prefers the contributor, falls back to the maintainer", () => {
  mkUser("m", "maintainer");
  assert.equal(contributorNotifyTarget(GH)!.id, "m", "fallback to maintainer when no contributor yet");
  mkUser("c", "contributor");
  assert.equal(contributorNotifyTarget(GH)!.id, "c", "contributor wins once it exists");
  db.remove("users", () => true);
  assert.equal(contributorNotifyTarget(GH), null, "nobody → null");
});

test("backfill stamps only un-stamped rows, on positive evidence, idempotently", () => {
  mkUser("has-install", undefined);
  mkUser("bare", undefined); // no install, no wallet, no bounty activity
  mkUser("has-wallet", undefined, { githubId: 77, stellarPayoutAddress: "G" + "A".repeat(55) });
  mkUser("applicant", undefined, { githubId: 88 });
  mkUser("already", "contributor");
  const installed = new Set(["has-install"]);
  const stamped = backfillAccountKinds(
    (userId) => (installed.has(userId) ? 1 : 0),
    (githubId) => githubId === 88, // "applicant" applied to / was delegated a bounty
  );
  assert.equal(stamped, 4, "only the un-stamped rows are touched");
  assert.equal(db.find("users", (u) => u.id === "has-install")!.accountKind, "maintainer");
  assert.equal(db.find("users", (u) => u.id === "has-wallet")!.accountKind, "contributor", "a payout wallet is contributor evidence");
  assert.equal(db.find("users", (u) => u.id === "applicant")!.accountKind, "contributor", "bounty activity is contributor evidence");
  assert.equal(db.find("users", (u) => u.id === "already")!.accountKind, "contributor", "pre-stamped untouched");
  // The one that matters: no install is NOT evidence of anything, so the row keeps
  // the legacy default rather than being converted into a contributor.
  assert.equal(db.find("users", (u) => u.id === "bare")!.accountKind, "maintainer");
  assert.equal(backfillAccountKinds(() => 1, () => true), 0, "second run is a no-op");
});

test("backfill never turns an install-less legacy row into a money-path contributor", () => {
  // A pre-split sponsor with no current installation — the App was removed, or the
  // row predates install linking. Stamping it "contributor" would make it the
  // resolution target for this githubId's payout wallet (contributorByGithubId is
  // the strict money-path resolver) and would hide the sponsor from their own
  // account on next sign-in. Absence of installs is not contributor evidence.
  mkUser("legacy-sponsor", undefined);
  assert.equal(backfillAccountKinds(NO_INSTALLS, NO_BOUNTY_ACTIVITY), 1);
  assert.equal(contributorByGithubId(GH), null, "must NOT become a contributor");
  assert.equal(maintainerByGithubId(GH)!.id, "legacy-sponsor", "stays the sponsor account");
});
