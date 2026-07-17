// Guards the rule that decides whether SESSION_SECRET may sign production
// sessions. It is worth a test because every way of getting this wrong fails
// SILENTLY and identically: the app boots, sessions work, and anyone who reads
// this repo can mint a cookie for any user id — or a bounty fund/cancel/approve
// link, which bounties/links.ts signs with the same key. The two placeholders
// below are the whole point: matching only the code default would still wave
// through a .env.example copied onto a server, which is the likelier mistake.
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/session-secret.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_SESSION_SECRET,
  isProductionLike,
  isSessionSecretShort,
  sessionSecretProblem,
} from "./config.js";

const STRONG = "a".repeat(16) + "bcdef"; // 21 chars: passes the floor, under the recommendation
const GENERATED = "f3a9".repeat(16); // 64 hex chars, what the docs tell you to generate

test("both committed placeholders are rejected", () => {
  // The code fallback...
  assert.ok(sessionSecretProblem(DEV_SESSION_SECRET));
  // ...and the one .env.example ships. Public is public: neither may sign.
  assert.ok(sessionSecretProblem("replace-me-with-a-long-random-string"));
});

test("empty / whitespace-only secrets are rejected", () => {
  assert.ok(sessionSecretProblem(""));
  assert.ok(sessionSecretProblem("   "));
});

test("secrets short enough to grind offline are rejected", () => {
  assert.ok(sessionSecretProblem("x"));
  assert.ok(sessionSecretProblem("hunter2"));
  assert.ok(sessionSecretProblem("a".repeat(15)));
});

test("a real secret is accepted", () => {
  assert.equal(sessionSecretProblem(STRONG), null);
  assert.equal(sessionSecretProblem(GENERATED), null);
});

test("short-but-usable secrets warn instead of failing the boot", () => {
  // The distinction that keeps this guard from taking a live deploy down: 21
  // random chars is safe, so it boots and nags rather than refusing.
  assert.equal(isSessionSecretShort(STRONG), true);
  assert.equal(isSessionSecretShort(GENERATED), false);
  // A rejected secret is never merely "short" — it's a hard failure.
  assert.equal(isSessionSecretShort(DEV_SESSION_SECRET), false);
});

test("NODE_ENV=production is a prod signal on its own", () => {
  // Without this, a deploy that forgets WEB_ORIGIN falls back to
  // http://localhost:5173 and disarms the guard exactly when it is needed.
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(isProductionLike(), true);
    process.env.NODE_ENV = "test";
    // WEB_ORIGIN is http under the test runner, so the other signal is off too.
    assert.equal(isProductionLike(), false);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});
