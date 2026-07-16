// Build + simulate escrow-contract invocations.
//
// Every escrow op is designed so the required authorizer IS the transaction
// source (sponsor's Freighter account for create_escrow/release, the admin
// account for admin_release/admin_refund). That means a single envelope
// signature covers the contract invoke AND its USDC-transfer sub-invocation —
// no separate Soroban auth-entry signing (authorizeEntry/signAuthEntry) is ever
// needed. `prepareTransaction` runs the simulation and stamps the footprint +
// resource fee onto the returned transaction, ready to sign.
import * as Stellar from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { server, escrowContractId, networkPassphrase } from "./client.js";
import { fromScVal } from "./scval.js";

const { Contract, TransactionBuilder, BASE_FEE } = Stellar;

/**
 * Build + simulate an invoke of `method(...args)` on the escrow contract with
 * `sourceAddress` as the transaction source (and sole authorizer). Returns the
 * prepared transaction — footprint/auth/resource-fee populated — ready to sign
 * (locally with the admin key, or client-side via Freighter over its XDR).
 * Throws if `sourceAddress` doesn't exist on-chain or the simulation reverts.
 */
export async function buildEscrowInvoke(
  sourceAddress: string,
  method: string,
  args: Stellar.xdr.ScVal[],
  opts: { timeoutSeconds?: number; fee?: string } = {}
): Promise<Stellar.Transaction> {
  // Admin-signed ops (admin_refund/admin_release) pass a higher inclusion fee and
  // shorter timebounds so a dropped tx is provably dead sooner and the keeper can
  // safely rebuild+resubmit a fresh envelope. Client-signed builds keep the
  // BASE_FEE / 300s defaults (the sponsor pays and re-signs on their own retry).
  const { timeoutSeconds = 300, fee = BASE_FEE } = opts;
  const srv = server();
  const account = await srv.getAccount(sourceAddress);
  const contract = new Contract(escrowContractId());
  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(timeoutSeconds)
    .build();
  // prepareTransaction simulates and, on success, returns an assembled tx. On a
  // simulation error it throws — surface a readable message.
  return await srv.prepareTransaction(tx);
}

/**
 * Simulate a read-only escrow method and return its decoded native return value.
 * Uses the admin address as a throwaway source (simulation needs no signature).
 * `null` when the simulation produced no return value.
 */
export async function simulateEscrowRead(
  sourceAddress: string,
  method: string,
  args: Stellar.xdr.ScVal[]
): Promise<unknown> {
  const srv = server();
  const account = await srv.getAccount(sourceAddress);
  const contract = new Contract(escrowContractId());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`simulation of ${method} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? fromScVal(retval) : null;
}
