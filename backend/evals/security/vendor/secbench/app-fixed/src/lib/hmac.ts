import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function signatureMatches(secret: string, body: string, header: string | undefined): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(signBody(secret, body), "utf8");
  const received = Buffer.from(header, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
