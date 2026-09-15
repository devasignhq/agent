// A signed session token: the login script mints it, the API accepts nothing else.
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = "two-server-fixture-secret";
export const COOKIE = "fixture_session";

const sign = (user) => createHmac("sha256", SECRET).update(user).digest("hex");

export function mint(user) {
  return `${user}.${sign(user)}`;
}

export function userOf(token) {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const user = token.slice(0, i);
  const got = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(user));
  return got.length === want.length && timingSafeEqual(got, want) ? user : null;
}

export function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
