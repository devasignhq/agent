// verify.login.script for DevAsign's browser tests: signs in as the seeded ephemeral user by minting
// the dev-secret session cookie, and writes it as a Playwright storage state. Local ephemeral boots only.
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const base = process.env.DEVASIGN_BASE_URL || "";
const out = process.env.DEVASIGN_STORAGE_STATE || "";
// The dev secret is public (backend/src/config.ts), so the cookie must never point anywhere but a local boot.
if (!/^http:\/\/localhost(:\d+)?\/?$/.test(base) || !out) {
  console.error("devasign-login: refusing — needs DEVASIGN_STORAGE_STATE and a DEVASIGN_BASE_URL of http://localhost");
  process.exit(1);
}

// Kept in step with backend/src/config.ts (DEV_SESSION_SECRET), github/oauth.ts (signSession,
// devasign_session) and scripts/ephemeral-dev.ts (the seeded user, SESSION_SECRET pinned empty).
const DEV_SESSION_SECRET = "dev-secret-replace-me";
const USER_ID = "ephemeral-user-1";
const TTL_SECONDS = 3600;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER_ID, iat: now, exp: now + TTL_SECONDS })}`;
const token = `${unsigned}.${createHmac("sha256", DEV_SESSION_SECRET).update(unsigned).digest("base64url")}`;

writeFileSync(
  out,
  JSON.stringify({
    cookies: [{ name: "devasign_session", value: token, domain: "localhost", path: "/", expires: now + TTL_SECONDS, httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [],
  })
);
console.log(`devasign-login: signed in as ${USER_ID} for ${base}`);
