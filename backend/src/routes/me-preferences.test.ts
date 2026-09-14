// PATCH /api/me persists per-user preferences. In-memory, driven through the
// exported handler with a signed session cookie. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/me-preferences.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { updateMeHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function seedUser() {
  const id = uuid();
  db.insert("users", { id, githubId: Math.floor(Math.random() * 1e9), githubLogin: "octo", email: "o@e.com", plan: "free", createdAt: Date.now() } as any);
  return id;
}

const reqFor = (userId: string, body: unknown): any => ({ cookies: { devasign_session: signSession(userId) }, body });

test("PATCH /me: 401 without a session", () => {
  const res = fakeRes();
  updateMeHandler({ cookies: {}, body: { bountiesEnabled: true } } as any, res);
  assert.equal(res.statusCode, 401);
});

test("PATCH /me: a non-boolean bountiesEnabled is rejected and nothing is written", () => {
  const id = seedUser();
  try {
    const res = fakeRes();
    updateMeHandler(reqFor(id, { bountiesEnabled: "yes" }), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "invalid_preferences" });
    assert.equal(db.find("users", (u) => u.id === id)?.bountiesEnabled, undefined);
  } finally {
    db.remove("users", (u) => u.id === id);
  }
});

test("PATCH /me: bountiesEnabled persists and the response echoes the updated user", () => {
  const id = seedUser();
  try {
    const on = fakeRes();
    updateMeHandler(reqFor(id, { bountiesEnabled: true }), on);
    assert.equal(on.statusCode, 200);
    assert.equal(on.body.user.bountiesEnabled, true);
    assert.equal(db.find("users", (u) => u.id === id)?.bountiesEnabled, true);
    const off = fakeRes();
    updateMeHandler(reqFor(id, { bountiesEnabled: false }), off);
    assert.equal(off.body.user.bountiesEnabled, false);
    assert.equal("subscription" in off.body, true, "same shape as GET /me so the client can reuse it");
  } finally {
    db.remove("users", (u) => u.id === id);
  }
});
