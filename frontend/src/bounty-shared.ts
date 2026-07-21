// Bits shared by the bounties dashboard (screen-bounties.tsx) and the focused
// funding page (screen-fund-bounty.tsx). Its own module so the funding page —
// reached cold from a GitHub comment link — doesn't pull the whole dashboard
// in for three formatters.
import { isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

export const money = (n: number) => `$${n.toLocaleString("en-US")}`;
export const shortHash = (h: string) => (h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);

// Explorer base comes from the backend (`explorerBase` on the bounty response
// envelopes) so the network lives in exactly one place — backend config. The
// default only covers the instant before the first API response lands.
let explorerBase = "https://stellar.expert/explorer/public";
export const setExplorerBase = (base: string) => {
  if (base) explorerBase = base;
};
export const stellarTxUrl = (h: string) => `${explorerBase}/tx/${h}`;

// ─── Freighter (browser wallet) bridge ────────────────────────────────────────
// We talk to Freighter through its official `@stellar/freighter-api` package
// rather than sniffing for an injected `window` global: current Freighter builds
// don't expose a reliable page global, and the extension's content script is
// injected asynchronously — so global detection produced false "not detected"
// errors even when the wallet was installed. The package handles the postMessage
// bridge (and its readiness) for us.
export async function freighterAddress(): Promise<string> {
  const conn = await isConnected();
  if (!conn.isConnected) {
    throw new Error("Freighter wallet not detected. Install it from freighter.app, then reload this page.");
  }
  const access = await requestAccess();
  if (access.error || !access.address) {
    throw new Error(access.error?.message || "Couldn't read your Freighter wallet address.");
  }
  return access.address;
}

export async function freighterSign(
  xdr: string,
  address: string,
  networkPassphrase: string
): Promise<string> {
  const signed = await signTransaction(xdr, { address, networkPassphrase });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error(signed.error?.message || "Transaction signing was cancelled.");
  }
  return signed.signedTxXdr;
}
