// Typed wrappers over the escrow contract — one function per method, in terms of
// plain JS args. Method names here MUST match the deployed contract:
//   create_escrow(creator, task_id, issue_url, bounty_amount)   [creator-signed]
//   release(task_id, contributor)                                [creator-signed]  ← sponsor in-app approve
//   admin_release(task_id, contributor)                          [admin-signed]    ← backend on PR merge
//   admin_refund(task_id)                                        [admin-signed]    ← backend on delete/expiry
//   reads: get_escrow(task_id), get_usdc_balance(address)
// (release/admin_release/admin_refund are the additions this feature requires in
// devasignhq/soroban-contract — see the plan's "Contract changes" section.)
import { config } from "../config.js";
import { adminAddress, adminKeypair } from "./client.js";
import { buildEscrowInvoke, simulateEscrowRead } from "./build.js";
import { sendSignedTx, type SendResult } from "./submit.js";
import { addressScVal, i128ScVal, isValidContract, isValidPublicKey, stringScVal, taskIdScVal } from "./scval.js";

// ── Client-signed builds (return unsigned prepared XDR for Freighter) ─────────

/** Prepared `create_escrow` XDR for the sponsor to sign with Freighter (funding). */
export async function buildCreateEscrowXdr(
  sponsorAddress: string,
  taskId: string,
  issueUrl: string,
  amountStroops: bigint
): Promise<string> {
  const tx = await buildEscrowInvoke(sponsorAddress, "create_escrow", [
    addressScVal(sponsorAddress),
    taskIdScVal(taskId),
    stringScVal(issueUrl),
    i128ScVal(amountStroops),
  ]);
  return tx.toXDR();
}

/** Prepared `release` XDR for the sponsor to sign with Freighter (in-app "Approve payment"). */
export async function buildReleaseXdr(
  sponsorAddress: string,
  taskId: string,
  contributorAddress: string,
  memoText: string = ""
): Promise<string> {
  const tx = await buildEscrowInvoke(
    sponsorAddress,
    "release",
    [taskIdScVal(taskId), addressScVal(contributorAddress)],
    { memoText }
  );
  return tx.toXDR();
}

// ── Admin-signed operations (signed server-side, broadcast immediately) ───────

// Admin settlement txns (admin_release/admin_refund) build with a higher inclusion
// fee and shorter timebounds than the BASE_FEE/300s default. Shorter timebounds
// make a dropped admin tx provably dead sooner, so the keeper can rebuild and
// resubmit a FRESH envelope without ever having two live at once (the invariant
// that keeps resubmit double-settle-safe). The 10× inclusion fee (~0.0001 XLM,
// paid by the platform admin account) improves inclusion odds under surge pricing.
const ADMIN_TX_TIMEOUT_S = 120;
const ADMIN_TX_FEE = "1000"; // 10 × the 100-stroop BASE_FEE minimum
const adminTxOpts = { timeoutSeconds: ADMIN_TX_TIMEOUT_S, fee: ADMIN_TX_FEE };

/** Backend releases the escrow to the contributor on PR merge (admin arbiter). */
export async function adminRelease(
  taskId: string,
  contributorAddress: string,
  memoText: string = ""
): Promise<SendResult> {
  const tx = await buildEscrowInvoke(
    adminAddress(),
    "admin_release",
    [taskIdScVal(taskId), addressScVal(contributorAddress)],
    { ...adminTxOpts, memoText }
  );
  tx.sign(adminKeypair());
  return sendSignedTx(tx);
}

/** Backend refunds the escrow to the sponsor on delete/expiry (admin arbiter, funds → creator only). */
export async function adminRefund(taskId: string): Promise<SendResult> {
  const tx = await buildEscrowInvoke(adminAddress(), "admin_refund", [taskIdScVal(taskId)], adminTxOpts);
  tx.sign(adminKeypair());
  return sendSignedTx(tx);
}

// ── Reads (simulation-only; admin address is a throwaway source) ──────────────

/**
 * The on-chain escrow record for a task, or null if it doesn't exist. A missing
 * escrow surfaces as a contract error in the simulation (get_escrow returns
 * Result<TaskEscrow, Error>); anything else — RPC down, network blip — rethrows,
 * because callers (cancel, orphan recovery) must not mistake it for "no escrow".
 */
export async function getEscrow(taskId: string): Promise<unknown> {
  try {
    return await simulateEscrowRead(adminAddress(), "get_escrow", [taskIdScVal(taskId)]);
  } catch (err) {
    if (err instanceof Error && /Error\(Contract/.test(err.message)) return null;
    throw err;
  }
}

/** USDC balance (in stroops) of an address, per the contract's view. */
export async function getUsdcBalance(address: string): Promise<bigint> {
  const v = await simulateEscrowRead(adminAddress(), "get_usdc_balance", [addressScVal(address)]);
  return typeof v === "bigint" ? v : BigInt((v as number | string) ?? 0);
}

/**
 * Best-effort check that `address` can RECEIVE USDC (a payout to a classic
 * account with no USDC trustline would trap). Only meaningful when the classic
 * issuer is configured; otherwise (pure Soroban token, or unconfigured) there is
 * no trustline model, so we return true. Network errors also return true — we
 * don't block a payout on a Horizon blip; the on-chain tx is the final backstop.
 */
export async function hasUsdcTrustline(address: string): Promise<boolean> {
  const issuer = config.stellar.usdcIssuer;
  if (!issuer) return true; // no classic trustline model configured
  // A contract (C…) holds USDC directly via the asset contract, never through a
  // classic trustline — so the trustline gate doesn't apply and it's always
  // "receivable" here (a truly unreceivable contract fails at release-time
  // simulation, the real backstop). Must come before the G-address check.
  if (isValidContract(address)) return true;
  // `address` is interpolated into the Horizon path, so reject anything that is
  // now neither a C-contract (handled above) nor a bare classic account id (G…)
  // before the fetch — a value with '/', '..', or query chars could otherwise
  // steer the request off /accounts/{id}. Both callers already validate; this is
  // the boundary that makes it safe regardless. Malformed input can't receive a
  // USDC payout, so false is also the correct answer.
  if (!isValidPublicKey(address)) return false;
  try {
    const res = await fetch(
      `${config.stellar.horizonUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(address)}`,
      { headers: { Accept: "application/json" } }
    );
    if (res.status === 404) return false; // account doesn't exist → can't receive
    if (!res.ok) return true; // transient Horizon issue → don't block
    const body = (await res.json()) as {
      balances?: Array<{ asset_code?: string; asset_issuer?: string }>;
    };
    return (body.balances || []).some(
      (b) => b.asset_code === config.stellar.usdcCode && b.asset_issuer === issuer
    );
  } catch {
    return true; // network error → don't block; the tx is the backstop
  }
}
