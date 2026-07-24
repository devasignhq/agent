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

test("backfill stamps only un-stamped rows, by installation presence, idempotently", () => {
  mkUser("has-install", undefined);
  mkUser("no-install", undefined);
  mkUser("already", "contributor");
  const installed = new Set(["has-install"]);
  const stamped = backfillAccountKinds((userId) => (installed.has(userId) ? 1 : 0));
  assert.equal(stamped, 2, "only the two un-stamped rows are touched");
  assert.equal(db.find("users", (u) => u.id === "has-install")!.accountKind, "maintainer");
  assert.equal(db.find("users", (u) => u.id === "no-install")!.accountKind, "contributor");
  assert.equal(db.find("users", (u) => u.id === "already")!.accountKind, "contributor", "pre-stamped untouched");
  assert.equal(backfillAccountKinds(() => 1), 0, "second run is a no-op");
});
