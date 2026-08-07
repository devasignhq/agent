// The escrow contract requires `task_id` to be EXACTLY 25 characters. We derive
// it deterministically from the bounty's immutable id so that retries and the
// reconciliation keeper always compute the SAME on-chain key (never a second
// escrow for the same bounty). base32 (RFC 4648 alphabet, [A-Z2-7]) keeps it
// alphanumeric — safe for the contract's task-id character validation.
import crypto from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TASK_ID_LENGTH = 25;

function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Deterministic exactly-25-char task id for a bounty. */
export function taskIdForBounty(bountyId: string): string {
  const hash = crypto.createHash("sha256").update(bountyId).digest();
  return ("BNTY" + base32(hash)).slice(0, TASK_ID_LENGTH);
}

export function isValidTaskId(taskId: string): boolean {
  return typeof taskId === "string" && /^[A-Z2-7]{25}$/.test(taskId);
}
