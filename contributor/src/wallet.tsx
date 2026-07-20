// Contributor wallet — the contributor registers THEIR OWN external Stellar
// USDC wallet (address + memo); every approved bounty pays out straight to it,
// so there is no DevAsign-held balance and nothing to withdraw. The ledger
// records the exact destination wallet per payout (snapshotted server-side),
// so history stays truthful even after the registered wallet changes.
// Ported from the design's c-wallet.jsx, wired to the real API.
import React from "react";
import { api } from "./api";
import type { PayoutTransaction } from "./api";
import { useAuth } from "./auth-context";
import { useBounties } from "./data-context";
import { useLiveTopic } from "./live-context";
import { Icon } from "./icons";
import { cmoney, cmoney2, fmtDate, isStellarAddr, isValidMemo } from "./model.ts";

type Wallet = { addr: string; memo: string };

// ── Add / change wallet modal ────────────────────────────────────────────────
const WalletModal = ({
  wallet,
  onClose,
  onSaved,
}: {
  wallet: Wallet | null;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [addr, setAddr] = React.useState(wallet ? wallet.addr : "");
  const [memo, setMemo] = React.useState(wallet ? wallet.memo : "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);
  const ok = isStellarAddr(addr);
  const memoOk = isValidMemo(memo);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clear the pending auto-close timer on unmount only. Kept OUT of the keydown
  // effect above on purpose: onClose is an inline prop (fresh ref every parent
  // render), so folding this into that effect would let a parent re-render
  // mid-countdown cancel the timer and leave the modal stuck open.
  React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.setPayoutWallet(addr.trim(), memo.trim());
      if (!r.trustline) {
        // Saved, but flag it: a payout to a trustline-less account would trap.
        setWarning("Saved — but this wallet doesn't hold a USDC trustline yet. Add one in your wallet app before a payout is due.");
        timerRef.current = setTimeout(() => { onSaved(); onClose(); }, 2600);
        return;
      }
      onSaved();
      onClose();
    } catch (err: any) {
      const code = (err?.body as any)?.error || "save_failed";
      setError(
        code === "invalid_address" ? "Not a valid Stellar address." :
        code === "invalid_memo" ? "Memo is too long — 28 bytes max." :
        "Couldn't save the wallet — try again."
      );
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal c-accept" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><Icon name="x" size={13} /></button>
        <div className="c-accept-head">
          <div className="c-accept-eyebrow">your payout wallet · Stellar</div>
          <h2 className="c-accept-title" style={{ fontSize: 20 }}>{wallet ? "Change your payout wallet" : "Add your payout wallet"}</h2>
          <div className="c-accept-sub">
            This is <b>your own</b> <span style={{ fontSize: 12 }}>Stellar wallet. Approved bounties pay out here directly in USDC — DevAsign never holds your funds.</span>
          </div>
        </div>

        <div className="c-accept-body">
          <label className="label">Stellar wallet address (USDC)</label>
          <div className="c-addr-field">
            <input
              className="input mono"
              placeholder="G… (56 characters)"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              style={{ height: 42, fontSize: 12, paddingRight: ok ? 96 : 12 }}
            />
            {ok && <span className="c-addr-valid"><Icon name="check" size={12} /> valid</span>}
          </div>
          {addr && !ok && (
            <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>
              Not a valid Stellar address — should start with G and be 56 characters.
            </div>
          )}

          <label className="label" style={{ marginTop: 16 }}>
            Memo <span className="mute mono" style={{ fontSize: 11, marginLeft: 6, textTransform: "none", letterSpacing: 0 }}>optional</span>
          </label>
          <input
            className="input mono"
            placeholder="e.g. exchange deposit memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            style={{ height: 40, fontSize: 12 }}
          />
          {!memoOk && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>Memo is limited to 28 bytes.</div>}
          <div className="c-submit-help">Leave blank if you're paying into a self-custody wallet. Add it when your exchange or custodian assigns you a deposit memo — note that some exchanges don't credit contract transfers; a self-custody wallet is safest.</div>
          {error && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 10 }}>{error}</div>}
          {warning && <div className="mono" style={{ color: "var(--warn)", fontSize: 11, marginTop: 10 }}>{warning}</div>}
        </div>

        <div className="c-accept-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok || !memoOk || busy} onClick={() => void save()}>
            <Icon name="check" size={13} /> {busy ? "Saving…" : wallet ? "Save wallet" : "Add wallet"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Payout-history wallet cell ───────────────────────────────────────────────
const TxnWalletCell = ({
  dest,
  isPrev,
  hidden,
}: {
  dest: { address: string | null; memo: string | null };
  isPrev: boolean;
  hidden: boolean;
}) => {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const addr = dest.address || "";
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.clipboard && addr) navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (hidden) {
    return (
      <div className="c-txn-wallet">
        <span className="addr">••••••{isPrev && <span className="tag">previous</span>}</span>
        <span className="memo">••••</span>
      </div>
    );
  }
  if (!addr) {
    return (
      <div className="c-txn-wallet">
        <span className="addr mute">—</span>
        <span className="memo">no record</span>
      </div>
    );
  }

  return (
    <div className={`c-txn-wallet ${open ? "open" : ""}`}>
      <span className="addr">
        <button className="c-waddr" onClick={() => setOpen((o) => !o)} title={open ? "Show less" : "View full address"}>
          {open ? addr : <>{addr.slice(0, 6)}…{addr.slice(-4)}</>}
        </button>
        {isPrev && <span className="tag" title="A wallet you used before — kept on record for this payout">previous</span>}
        <button className="c-wcopy" onClick={copy} title="Copy full address" aria-label="Copy full address">
          <Icon name={copied ? "check" : "copy"} size={11} color={copied ? "var(--success)" : "currentColor"} />
        </button>
      </span>
      <span className="memo">{dest.memo ? <>memo · {dest.memo}</> : "no memo"}</span>
    </div>
  );
};

// ── Wallet page ──────────────────────────────────────────────────────────────
const C_TXN_PAGE = 12;

export function WalletPage() {
  const auth = useAuth();
  const { summary, reload: reloadBounties } = useBounties();
  const [txns, setTxns] = React.useState<PayoutTransaction[]>([]);
  const [explorerBase, setExplorerBase] = React.useState("https://stellar.expert/explorer/testnet");
  const [modal, setModal] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const dot = "••••••";
  const addrDot = "••••••••••••••••••••";

  const wallet: Wallet | null = auth.user?.stellarPayoutAddress
    ? { addr: auth.user.stellarPayoutAddress, memo: auth.user.stellarPayoutMemo || "" }
    : null;
  const trustlineWarning = wallet && auth.user?.stellarPayoutTrustline === false;

  const loadTxns = React.useCallback(async () => {
    try {
      const d = await api.contributorTransactions();
      setTxns(d.transactions);
      setExplorerBase(d.explorerBase);
    } catch (err) {
      console.warn("[wallet] transactions load failed:", err);
    }
  }, []);
  React.useEffect(() => {
    if (auth.status === "signed_in") void loadTxns();
  }, [auth.status, loadTxns]);
  // Keep the ledger current when a payout confirms on-chain while the page is
  // open. Scoped to this component, so no transaction fetches happen off /wallet.
  useLiveTopic("wallet", () => void loadTxns());

  const removeWallet = async () => {
    try {
      await api.removePayoutWallet();
      await auth.reload();
    } catch (err) {
      console.warn("[wallet] remove failed:", err);
    }
    setRemoving(false);
  };

  const confirmed = txns.filter((t) => t.status !== "failed");
  const received = confirmed.filter((t) => t.status === "confirmed").reduce((s, t) => s + t.amountUsdc, 0);
  const pages = Math.max(1, Math.ceil(confirmed.length / C_TXN_PAGE));
  const pg = Math.min(page, pages - 1);
  const start = pg * C_TXN_PAGE;
  const slice = confirmed.slice(start, start + C_TXN_PAGE);

  return (
    <div className="c-wal">
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Wallet</h1>
          <div className="page-sub">Your own Stellar USDC wallet — every bounty pays out directly to it. No withdrawals, no DevAsign-held balance.</div>
        </div>
        <button className="btn ghost sm" onClick={() => setHidden((h) => !h)} aria-label={hidden ? "Show details" : "Hide details"}>
          <Icon name={hidden ? "eye-off" : "eye"} size={13} /> {hidden ? "Show" : "Hide"} details
        </button>
      </div>

      {/* Registered payout wallet */}
      <div className={`c-wal-wallet ${wallet ? "" : "empty"}`}>
        <div className="c-wal-wallet-head">
          <span className="k" style={{ alignItems: "flex-start" }}><Icon name="coins" size={12} /> your payout wallet · Stellar</span>
          {wallet && (trustlineWarning
            ? <span className="pill warn"><i className="dot"></i> no USDC trustline</span>
            : <span className="pill ok"><i className="dot"></i> active</span>)}
        </div>

        {wallet ? (
          <>
            <div className="c-wal-wallet-body">
              <div className="ic"><img src="/stellar-icon.png" alt="Stellar" style={{ width: 26, height: 26, display: "block" }} /></div>
              <div className="fields" style={{ flexDirection: "column", gap: 5 }}>
                <div className="wrow">
                  <span className="lbl">address</span>
                  <span className="val mono" style={{ fontSize: 12 }}>{hidden ? addrDot : wallet.addr}</span>
                </div>
                <div className="wrow">
                  <span className="lbl">memo</span>
                  <span className="val mono" style={{ fontSize: 12 }}>{hidden ? dot : (wallet.memo ? wallet.memo : <span className="none">— none —</span>)}</span>
                </div>
              </div>
            </div>

            {removing ? (
              <div className="c-wal-wallet-confirm">
                <span>Remove this wallet? Bounty payouts pause until you add a new one.</span>
                <div className="acts">
                  <button className="btn ghost sm" onClick={() => setRemoving(false)}>Cancel</button>
                  <button className="btn danger sm" onClick={() => void removeWallet()}><Icon name="trash" size={12} /> Remove wallet</button>
                </div>
              </div>
            ) : (
              <div className="c-wal-wallet-foot">
                <span className="note" style={{ alignItems: "flex-start" }}>
                  <Icon name="shield" size={12} />
                  {trustlineWarning
                    ? " This wallet can't receive USDC yet — add a USDC trustline in your wallet app."
                    : " Approved bounties pay out here directly — you never withdraw."}
                </span>
                <div className="acts">
                  <button className="btn ghost sm" onClick={() => setModal(true)}><Icon name="edit" size={11} /> Change</button>
                  <button className="btn ghost sm danger-ghost" onClick={() => setRemoving(true)}><Icon name="trash" size={11} /> Remove</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="c-wal-wallet-empty">
            <div className="ei"><Icon name="coins" size={20} /></div>
            <div className="etext">
              <div className="t">No payout wallet on file</div>
              <div className="d">Add your own Stellar USDC wallet (address + optional memo) so approved bounties can pay out directly to you.</div>
            </div>
            <button className="btn primary" onClick={() => setModal(true)}><Icon name="plus" size={13} /> Add wallet</button>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="c-stats c-wal-stats">
        <div className="c-stat">
          <div className="c-stat-k">total received</div>
          <div className="c-stat-v">{hidden ? dot : cmoney(received)}<span className="u">USDC</span></div>
        </div>
        <div className="c-stat">
          <div className="c-stat-k">pending in escrow</div>
          <div className="c-stat-v">{hidden ? dot : cmoney(summary.inEscrowUsdc)}<span className="u">USDC</span></div>
        </div>
        <div className="c-stat">
          <div className="c-stat-k">bounties paid</div>
          <div className="c-stat-v">{confirmed.filter((t) => t.status === "confirmed").length}</div>
        </div>
      </div>

      {/* Transactions */}
      <div className="c-block-h" style={{ marginBottom: 12 }}>
        <span className="t">Payout history</span>
        <span className="ct">{confirmed.length}</span>
        <span className="line"></span>
      </div>
      {confirmed.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <div className="mono mute" style={{ fontSize: 12 }}>No payouts yet — finish a bounty and it lands here.</div>
        </div>
      ) : (
        <div className="row-table" style={{ overflowX: "auto" }}>
          <div className="c-txn head">
            <span>bounty</span>
            <span>transaction</span>
            <span>paid to wallet</span>
            <span style={{ textAlign: "left" }}>amount</span>
            <span className="c-txn-when">date</span>
          </div>
          {slice.map((t) => {
            const shortTx = t.hash ? t.hash.slice(0, 8) + "…" + t.hash.slice(-4) : "pending";
            const isPrev = !!wallet && !!t.dest.address && t.dest.address !== wallet.addr;
            const when = t.confirmedAt ?? t.createdAt;
            return (
              <div key={t.id} className="c-txn">
                <div className="c-txn-main">
                  <div className="c-txn-t">{t.title || t.code || "Bounty payout"}</div>
                  <div className="c-txn-s">{t.repo ? `${t.repo}#${t.issueNumber}` : ""} · bounty payout{t.status === "pending" ? " · confirming" : ""}</div>
                </div>
                {t.hash ? (
                  <a className="c-txn-url" href={`${explorerBase}/tx/${t.hash}`} target="_blank" rel="noopener noreferrer" title={t.hash}>
                    {shortTx} <Icon name="external" size={10} color="var(--fg-mute)" />
                  </a>
                ) : (
                  <span className="c-txn-url mute">{shortTx}</span>
                )}
                <TxnWalletCell dest={t.dest} isPrev={isPrev} hidden={hidden} />
                <span className="c-txn-amt in">{hidden ? dot : <>+{cmoney2(t.amountUsdc)} <span className="u">USDC</span></>}</span>
                <span className="c-txn-when">{fmtDate(when)}<span className="t">{new Date(when).getFullYear()} · {String(new Date(when).getHours()).padStart(2, "0")}:{String(new Date(when).getMinutes()).padStart(2, "0")}</span></span>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {confirmed.length > C_TXN_PAGE && (
        <div className="c-pager">
          <span className="c-pager-info">
            Showing <b>{start + 1}–{Math.min(start + C_TXN_PAGE, confirmed.length)}</b> of {confirmed.length}
          </span>
          <div className="c-pager-ctrls">
            <button className="btn ghost sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>
              <Icon name="chevron-r" size={12} style={{ transform: "rotate(180deg)" }} /> Prev
            </button>
            <span className="c-pager-pages">
              {Array.from({ length: pages }, (_, i) => (
                <button key={i} className={`c-pager-num ${i === pg ? "on" : ""}`} onClick={() => setPage(i)}>{i + 1}</button>
              ))}
            </span>
            <button className="btn ghost sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>
              Next <Icon name="chevron-r" size={12} />
            </button>
          </div>
        </div>
      )}

      {modal && (
        <WalletModal
          wallet={wallet}
          onClose={() => setModal(false)}
          onSaved={() => { void auth.reload(); void reloadBounties(); void loadTxns(); }}
        />
      )}
    </div>
  );
}
