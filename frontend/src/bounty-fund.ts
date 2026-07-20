// The Freighter funding handshake, lifted out of React so it can be unit-tested
// without a DOM or a wallet extension — see bounty-fund.test.ts.
//
// The branch that matters is the `not_durable` 503 AFTER submit. By that point
// the signed transaction has ALREADY been broadcast to Stellar: the backend
// submits before it records anything, so a 503 means only that it couldn't
// persist its own row yet (its heartbeat retries, and the keeper reconciles
// against the chain). Reporting that as a failure would tell a sponsor their
// funding failed while their USDC is moving into escrow. It becomes
// "confirming" instead, and the caller polls the bounty until it opens.

export type FundPhase = "loading" | "ready" | "working" | "confirming" | "done" | "error";

export type FundDeps = {
  /** Freighter: connect + return the sponsor's G-address. */
  getAddress: () => Promise<string>;
  /** Backend: build the unsigned create_escrow XDR for that address. */
  buildTx: (address: string) => Promise<{ xdr: string; networkPassphrase: string }>;
  /** Freighter: sign it against the passphrase the XDR was built for. */
  sign: (xdr: string, address: string, networkPassphrase: string) => Promise<string>;
  /** Backend: broadcast the signed envelope. */
  submit: (signedXdr: string) => Promise<{ hash?: string }>;
  setPhase: (phase: FundPhase) => void;
  setMsg: (msg: string | null) => void;
  setHash: (hash: string | null) => void;
};

function isTransientNotDurable(e: any): boolean {
  return e?.status === 503 && (e?.message === "not_durable" || e?.body?.error === "not_durable");
}

export async function runFund(deps: FundDeps): Promise<void> {
  deps.setPhase("working");
  deps.setMsg(null);
  try {
    const address = await deps.getAddress();
    const { xdr, networkPassphrase } = await deps.buildTx(address);
    const signedXdr = await deps.sign(xdr, address, networkPassphrase);
    try {
      const res = await deps.submit(signedXdr);
      deps.setHash(res.hash || null);
      deps.setPhase("done");
    } catch (e) {
      // Broadcast already happened — see the module comment. Never surface this
      // as an error.
      if (isTransientNotDurable(e)) {
        deps.setPhase("confirming");
        return;
      }
      throw e;
    }
  } catch (e: any) {
    deps.setMsg(e?.message || "Funding failed.");
    deps.setPhase("error");
  }
}
