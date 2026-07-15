// Stellar/Soroban client singletons. Config-guarded and lazily constructed —
// the same module-level-singleton idiom as llm.ts / statsig.ts / github/app.ts —
// so importing this module never touches the network and every getter throws a
// clear error (rather than a cryptic SDK one) when the chain isn't configured.
//
// The ONLY key held here is the platform admin keypair (for admin_release /
// admin_refund). Sponsor funding + in-app release are signed client-side with
// the sponsor's own Freighter wallet, so no user seed ever reaches the server.
import * as Stellar from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { config, isStellarConfigured } from "../config.js";

let _server: Server | null = null;
let _admin: Stellar.Keypair | null = null;

export function isStellarLive(): boolean {
  return isStellarConfigured();
}

export function networkPassphrase(): string {
  return config.stellar.networkPassphrase;
}

export function escrowContractId(): string {
  if (!config.stellar.contractId) throw new Error("STELLAR_ESCROW_CONTRACT_ID not configured");
  return config.stellar.contractId;
}

export function usdcSacId(): string {
  if (!config.stellar.usdcSac) throw new Error("STELLAR_USDC_SAC_ID not configured");
  return config.stellar.usdcSac;
}

export function server(): Server {
  if (!config.stellar.rpcUrl) throw new Error("STELLAR_RPC_URL not configured");
  if (!_server) {
    _server = new Server(config.stellar.rpcUrl, {
      allowHttp: config.stellar.rpcUrl.startsWith("http://"),
    });
  }
  return _server;
}

export function adminKeypair(): Stellar.Keypair {
  if (!config.stellar.adminSecret) throw new Error("STELLAR_ADMIN_SECRET not configured");
  if (!_admin) _admin = Stellar.Keypair.fromSecret(config.stellar.adminSecret);
  return _admin;
}

export function adminAddress(): string {
  return adminKeypair().publicKey();
}

// Reset the cached singletons — for tests that swap config between cases.
export function _resetStellarClientForTests(): void {
  _server = null;
  _admin = null;
}
