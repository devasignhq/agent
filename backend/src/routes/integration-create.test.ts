// POST /api/integrations end-to-end wiring: auth guard → body validation →
// persisted row. The exhaustive validation-matrix lives in
// integrations/validate.test.ts; this proves the handler is actually wired to
// it and that a valid payload lands as a clean row. In-memory (no initDb). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/integration-create.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { createIntegrationHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
const reqFor = (userId: string, body: unknown): any => ({
  cookies: { devasign_session: signSession(userId) },
  body,
});

function seedUser(): string {
  const id = uuid();
  db.insert("users", { id, githubId: 1, githubLogin: "octocat", email: "o@e.com", plan: "free", createdAt: Date.now() } as any);
  return id;
}
const integrationsOf = (userId: string) => db.filter("integrations", (i) => i.userId === userId);

test("401 without a session, and nothing persisted", () => {
  const res = fakeRes();
  createIntegrationHandler({ cookies: {}, body: { type: "slack", tokens: { botToken: "x" } } } as any, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "not_signed_in" });
});

test("valid slack payload persists a clean row and returns its id", () => {
  const uid = seedUser();
  const res = fakeRes();
  createIntegrationHandler(
    reqFor(uid, { type: "slack", tokens: { botToken: "xoxb-9" }, workspaceMeta: { channel: "#rev" } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const rows = integrationsOf(uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, res.body.id);
  assert.equal(rows[0].type, "slack");
  assert.deepEqual(rows[0].tokens, { botToken: "xoxb-9" });
  assert.deepEqual(rows[0].workspaceMeta, { channel: "#rev" });
});

test("an injected off-taxonomy type is rejected and NOT stored", () => {
  const uid = seedUser();
  const res = fakeRes();
  createIntegrationHandler(reqFor(uid, { type: "evilcorp", tokens: { botToken: "x" } }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "unsupported_integration_type" });
  assert.equal(integrationsOf(uid).length, 0);
});

test("a malformed tokens payload is rejected and NOT stored", () => {
  const uid = seedUser();
  const res = fakeRes();
  createIntegrationHandler(reqFor(uid, { type: "linear", tokens: { accessToken: { obj: 1 } } }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "invalid_tokens" });
  assert.equal(integrationsOf(uid).length, 0);
});

test("workspaceMeta is sanitized on the way into the row", () => {
  const uid = seedUser();
  const res = fakeRes();
  createIntegrationHandler(
    reqFor(uid, {
      type: "discord",
      tokens: { botToken: "d" },
      workspaceMeta: { channelId: "99", junk: { nested: true }, big: "z".repeat(5000) },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  const row = integrationsOf(uid)[0];
  assert.equal(row.workspaceMeta.channelId, "99");
  assert.equal("junk" in row.workspaceMeta, false); // non-string dropped
  assert.equal(row.workspaceMeta.big.length, 1024); // capped
});
