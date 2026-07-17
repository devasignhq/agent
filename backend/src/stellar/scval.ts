// ScVal encode/decode helpers for the escrow contract's arguments. Keeps the
// exact type mapping (and the hard 25-char task_id assertion + address validation)
// in one place so the escrow wrappers read cleanly and can't accidentally pass a
// bad task_id or a malformed address into a transaction that would revert.
import * as Stellar from "@stellar/stellar-sdk";
import { isValidTaskId } from "../bounties/taskid.js";

const { nativeToScVal, scValToNative, Address, StrKey, xdr } = Stellar;

export function taskIdScVal(taskId: string): Stellar.xdr.ScVal {
  if (!isValidTaskId(taskId)) throw new Error(`task_id must be exactly 25 chars, got "${taskId}"`);
  return nativeToScVal(taskId, { type: "string" });
}

export function stringScVal(s: string): Stellar.xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}

export function assertValidAddress(addr: string): void {
  if (!StrKey.isValidEd25519PublicKey(addr) && !StrKey.isValidContract(addr)) {
    throw new Error(`invalid Stellar address: ${addr}`);
  }
}

/** True only for a well-formed classic account id (G…). Narrower than
 * assertValidAddress (which also accepts C… contracts) — used where the value is
 * interpolated into a classic-account URL (Horizon /accounts/{id}). */
export function isValidPublicKey(addr: string): boolean {
  return StrKey.isValidEd25519PublicKey(addr);
}

/** True only for a well-formed Soroban contract address (C…). Contracts hold
 * token balances directly (via the asset contract), so they never use the
 * classic trustline model — callers that gate on trustlines treat them as
 * always-receivable. */
export function isValidContract(addr: string): boolean {
  return StrKey.isValidContract(addr);
}

export function addressScVal(addr: string): Stellar.xdr.ScVal {
  assertValidAddress(addr);
  return new Address(addr).toScVal();
}

export function i128ScVal(amountStroops: bigint): Stellar.xdr.ScVal {
  return nativeToScVal(amountStroops, { type: "i128" });
}

export function fromScVal(v: Stellar.xdr.ScVal): unknown {
  return scValToNative(v);
}

// Re-export for callers that need the raw xdr namespace (events, etc.).
export { xdr };
