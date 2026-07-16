// Broadcast + confirm transactions. Submission and confirmation are DECOUPLED:
// send() returns as soon as the tx is accepted into the mempool (returning the
// hash), and confirm() is a single non-blocking status poll the keeper drives.
// Nothing here blocks a request thread waiting for ledger inclusion — the
// bounty's escrowTransactions row is the durable record the keeper reconciles.
import * as Stellar from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { server, networkPassphrase } from "./client.js";

export type SendResult = { hash: string; status: "pending" | "error"; error?: string };

export type ConfirmResult =
  | { status: "success"; ledger?: number }
  | { status: "failed"; error: string }
  | { status: "not_found" };

/** Broadcast an already-signed transaction. Returns the hash + whether the node accepted it. */
export async function sendSignedTx(
  tx: Stellar.Transaction | Stellar.FeeBumpTransaction
): Promise<SendResult> {
  // TRY_AGAIN_LATER means the node did NOT durably queue the tx — its hash would
  // poll not_found forever if we recorded it as "pending". Resend the same (still
  // valid) envelope a few times before giving up; a persistent TRY_AGAIN_LATER is
  // returned as an error so the caller records a RETRYABLE `failed` row instead of
  // a dead-hash `pending` row. (For admin txns the keeper also rebuilds+resubmits
  // a fresh envelope — this just avoids stranding the first attempt.)
  const MAX_TRY_AGAIN = 3;
  let send = await server().sendTransaction(tx);
  for (let attempt = 1; send.status === "TRY_AGAIN_LATER" && attempt <= MAX_TRY_AGAIN; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    send = await server().sendTransaction(tx);
  }
  if (send.status === "ERROR") {
    return {
      hash: send.hash,
      status: "error",
      error: safeJson(send.errorResult) || "sendTransaction returned ERROR",
    };
  }
  if (send.status === "TRY_AGAIN_LATER") {
    return { hash: send.hash, status: "error", error: "try_again_later" };
  }
  // PENDING / DUPLICATE both mean "submitted"; the keeper polls getTransaction.
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

// Cap a confirmation poll so a hung RPC socket can't stall the keeper tick (the
// SDK's rpc Server sets no HTTP timeout). Well above a healthy getTransaction.
const CONFIRM_TIMEOUT_MS = 15_000;

type RawTxStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";
type RawGetTransaction = { status: RawTxStatus; ledger?: number; resultXdr?: string };

/**
 * Read the RPC's raw `getTransaction` JSON and return ONLY the top-level
 * `status`/`ledger`/`resultXdr` — deliberately never decoding `resultMetaXdr`.
 *
 * Since Protocol 23 the RPC returns transaction metadata as `TransactionMetaV4`,
 * which older @stellar/stellar-sdk builds can't parse: `server().getTransaction`
 * eagerly decodes the meta and throws `TypeError: Bad union switch: 4`, which
 * wedged confirmation for every funded bounty (it never reached SUCCESS, so the
 * bounty never left PENDING_FUNDING). The keeper only needs the status, so we
 * skip the meta entirely — this also stays resilient to future meta-version bumps.
 * Returns null on any transport error / timeout / malformed body; the caller
 * treats that as "not yet confirmed" and retries on the next tick.
 */
async function rawGetTransaction(hash: string): Promise<RawGetTransaction | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const res = await fetch(config.stellar.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
      signal: controller.signal,
    });
    if (!res.ok) return null; // transient RPC/proxy error — retry next tick
    const body = (await res.json()) as { result?: RawGetTransaction };
    if (!body?.result || typeof body.result.status !== "string") return null;
    return body.result;
  } catch {
    return null; // network error / timeout / abort — retry next tick
  } finally {
    clearTimeout(timer);
  }
}

/** One non-blocking status check for a submitted tx hash. Never throws. */
export async function confirmTransaction(hash: string): Promise<ConfirmResult> {
  const raw = await rawGetTransaction(hash);
  if (!raw) return { status: "not_found" }; // couldn't reach/parse the RPC — retryable
  if (raw.status === "SUCCESS") return { status: "success", ledger: raw.ledger };
  if (raw.status === "FAILED") return { status: "failed", error: raw.resultXdr || "transaction FAILED" };
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
