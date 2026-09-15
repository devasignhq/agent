// Writes a signed-in Playwright storage state for the runner to start browser tests with.
import { writeFileSync } from "node:fs";
import { COOKIE, mint } from "../session.mjs";

const out = process.env.DEVASIGN_STORAGE_STATE;
if (!out) {
  console.error("DEVASIGN_STORAGE_STATE is not set");
  process.exit(1);
}
const value = mint("ada");
writeFileSync(out, JSON.stringify({ cookies: [{ name: COOKIE, value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }], origins: [] }));
console.log(`signed in as ada for ${process.env.DEVASIGN_BASE_URL}: ${COOKIE}=${value}`);
