// Broadcast + confirm transactions. Submission and confirmation are DECOUPLED:
// send() returns as soon as the tx is accepted into the mempool (returning the
// hash), and confirm() is a single non-blocking status poll the keeper drives.
// Nothing here blocks a request thread waiting for ledger inclusion — the
// bounty's escrowTransactions row is the durable record the keeper reconciles.
import * as Stellar from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { server, networkPassphrase } from "./client.js";

export type SendResult = { hash: string; status: "pending" | "error"; error?: string };

export type ConfirmResult =
  | { status: "success"; ledger?: number; returnValue?: Stellar.xdr.ScVal }
  | { status: "failed"; error: string }
  | { status: "not_found" };

/** Broadcast an already-signed transaction. Returns the hash + whether the node accepted it. */
export async function sendSignedTx(
  tx: Stellar.Transaction | Stellar.FeeBumpTransaction
): Promise<SendResult> {
  const send = await server().sendTransaction(tx);
  if (send.status === "ERROR") {
    return {
      hash: send.hash,
      status: "error",
      error: safeJson(send.errorResult) || "sendTransaction returned ERROR",
    };
  }
  // PENDING (and the transient TRY_AGAIN_LATER / DUPLICATE) all mean "submitted";
  // the keeper polls getTransaction from here.
  return { hash: send.hash, status: "pending" };
}

/** Broadcast a signed transaction envelope XDR (e.g. one signed client-side by Freighter). */
export async function sendSignedXdr(signedXdr: string): Promise<SendResult> {
  const tx = Stellar.TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  return sendSignedTx(tx as Stellar.Transaction);
}

/** The source account (= the signer) of a transaction envelope XDR. */
export function parseTxSource(signedXdr: string): string {
  const tx = Stellar.TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  return (tx as Stellar.Transaction).source;
}

/** One non-blocking status check for a submitted tx hash. */
export async function confirmTransaction(hash: string): Promise<ConfirmResult> {
  const r = await server().getTransaction(hash);
  if (r.status === Api.GetTransactionStatus.SUCCESS) {
    return { status: "success", ledger: r.ledger, returnValue: r.returnValue };
  }
  if (r.status === Api.GetTransactionStatus.FAILED) {
    return { status: "failed", error: safeJson(r.resultXdr) || "transaction FAILED" };
  }
  return { status: "not_found" };
}

function safeJson(v: unknown): string {
  try {
    if (v == null) return "";
    // xdr objects expose toXDR("base64"); fall back to JSON for plain values.
    const anyV = v as { toXDR?: (fmt: string) => string };
    if (typeof anyV.toXDR === "function") return anyV.toXDR("base64");
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
