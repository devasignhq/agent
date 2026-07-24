// App-scoped session resolution: the same api host serves both apps, so
// getSessionUser must pick the cookie by the request Origin AND refuse to resolve
// a row of the wrong kind (so a legacy maintainer cookie can't leak a contributor
// row into the sponsor app, or vice-versa). Run:
//   DATABASE_URL= node --import tsx/esm --test src/github/oauth-session.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { db } from "../db.js";
import { config } from "../config.js";
import { signSession, getSessionUser } from "./oauth.js";

const MAINTAINER_COOKIE = "devasign_session";
const CONTRIBUTOR_COOKIE = "devasign_session_contributor";

// A minimal Request stand-in: getSessionUser only reads req.cookies and
// req.headers.origin.
function req(cookies: Record<string, string>, origin?: string): Request {
  return { cookies, headers: origin ? { origin } : {} } as unknown as Request;
}

function mkUser(id: string, kind: "maintainer" | "contributor") {
  db.insert("users", {
    id, githubId: 900, githubLogin: id, email: `${id}@e.com`, plan: "free",
    createdAt: 1, accountKind: kind,
  } as any);
}

beforeEach(() => db.remove("users", () => true));

test("contributor Origin + contributor cookie resolves the contributor account", () => {
  mkUser("c", "contributor");
  const r = req({ [CONTRIBUTOR_COOKIE]: signSession("c") }, config.contributorOrigin);
  assert.equal(getSessionUser(r)!.id, "c");
});

test("sponsor Origin + maintainer cookie resolves the maintainer account", () => {
  mkUser("m", "maintainer");
  const r = req({ [MAINTAINER_COOKIE]: signSession("m") }, config.webOrigin);
  assert.equal(getSessionUser(r)!.id, "m");
});

test("no Origin (a top-level callback) falls back to the maintainer cookie", () => {
  mkUser("m", "maintainer");
  const r = req({ [MAINTAINER_COOKIE]: signSession("m") });
  assert.equal(getSessionUser(r)!.id, "m");
});

test("a maintainer cookie on the contributor Origin resolves NOBODY", () => {
  mkUser("m", "maintainer");
  // The contributor app reads devasign_session_contributor, which isn't set here,
  // so a stray maintainer cookie can't sign the person into the contributor app.
  const r = req({ [MAINTAINER_COOKIE]: signSession("m") }, config.contributorOrigin);
  assert.equal(getSessionUser(r), null);
});

test("kind-match: a valid session for the WRONG-kind row resolves NOBODY", () => {
  // A contributor-named cookie whose JWT points at a maintainer row (e.g. a stale
  // cross-wired cookie) must not resolve — accountKind must match the cookie.
  mkUser("m", "maintainer");
  const r = req({ [CONTRIBUTOR_COOKIE]: signSession("m") }, config.contributorOrigin);
  assert.equal(getSessionUser(r), null);
});

test("two accounts, one identity: each Origin resolves its own account", () => {
  mkUser("m", "maintainer");
  mkUser("c", "contributor");
  const sponsor = req({ [MAINTAINER_COOKIE]: signSession("m") }, config.webOrigin);
  const contributor = req({ [CONTRIBUTOR_COOKIE]: signSession("c") }, config.contributorOrigin);
  assert.equal(getSessionUser(sponsor)!.id, "m");
  assert.equal(getSessionUser(contributor)!.id, "c");
});
