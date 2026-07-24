// Public bounty discovery page — where a developer lands from a GitHub link.
// Ported from the design's c-discovery.jsx, wired to the real API:
//   · GET /bounties/:id/public renders for anyone (no session)
//   · signed-in visitors also load their own application state
//   · "Apply" → GitHub auth gate → OAuth returns to /bounties/:id?apply=1 →
//     the ApplyModal auto-opens → wallet confirm → POST apply → submitted.
import React from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import type { PublicBounty } from "./api";
import { useAuth } from "./auth-context";
import { Icon, ChainLogo } from "./icons";
import { cmoney, isStellarAddr, isValidMemo, timeAgo } from "./model.ts";

// ── Public top nav ───────────────────────────────────────────────────────────
const PubNav = () => (
  <div className="c-pubnav">
    <img src="/devasign-logo.svg" alt="DevAsign" className="c-pubnav-logo" />
    <div className="c-pubnav-spacer"></div>
  </div>
);

// ── Escrow verification card ─────────────────────────────────────────────────
const EscrowCard = ({
  bounty,
  explorerBase,
  children,
}: {
  bounty: PublicBounty;
  explorerBase: string;
  children: React.ReactNode;
}) => {
  const e = bounty.escrow;
  const funded = bounty.status !== "PENDING_FUNDING";
  const explorerUrl = e.txHash ? `${explorerBase}/tx/${e.txHash}` : null;
  return (
    <div className="c-escrow-card">
      <div className="c-escrow-top">
        <div className="c-escrow-lbl">bounty reward</div>
        <div className="c-escrow-amt">{bounty.amountUsdc.toLocaleString()}<span className="u">USDC</span></div>
        <div className="c-escrow-chain">
          <span className="pip" style={{ background: "var(--accent)" }}></span>
          held in escrow on Stellar blockchain
        </div>
      </div>

      <div className="c-escrow-verify">
        <div className="c-escrow-row">
          <span className="ic"><Icon name="check" size={13} /></span>
          <span className="k">status</span>
          <span className="v" style={{ color: "var(--success)" }}>{funded ? "funded & locked" : "awaiting funding"}</span>
        </div>
        <div className="c-escrow-row">
          <span className="ic"><Icon name="coins" size={13} color="var(--fg-mute)" /></span>
          <span className="k">in escrow</span>
          <span className="v">{cmoney(bounty.amountUsdc)} USDC</span>
        </div>
        <div className="c-escrow-row">
          <span className="ic" style={{ color: "var(--fg-mute)" }}><Icon name="clock" size={12} /></span>
          <span className="k">funded</span>
          <span className="v">{e.fundedAt ? timeAgo(e.fundedAt) : "—"}</span>
        </div>
      </div>

      {children}

      {explorerUrl && (
        <a className="c-escrow-explorer" href={explorerUrl} target="_blank" rel="noopener noreferrer" title={explorerUrl}>
          <Icon name="external" size={12} /> Verify on Stellar block explorer
        </a>
      )}
    </div>
  );
};

// ── One-click apply modal ────────────────────────────────────────────────────
type Wallet = { addr: string; memo: string };

const ApplyModal = ({
  bounty,
  wallet,
  onClose,
  onApplied,
}: {
  bounty: PublicBounty;
  wallet: Wallet | null;
  onClose: () => void;
  onApplied: () => void;
}) => {
  const auth = useAuth();
  const [editing, setEditing] = React.useState(!wallet);
  const [addr, setAddr] = React.useState(wallet ? wallet.addr : "");
  const [memo, setMemo] = React.useState(wallet ? wallet.memo : "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ok = isStellarAddr(addr);
  const memoOk = isValidMemo(memo);
  const canApply = (wallet && !editing ? true : ok && memoOk) && !busy;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmApply = async () => {
    setBusy(true);
    setError(null);
    try {
      const finalAddr = (wallet && !editing ? wallet.addr : addr).trim();
      const finalMemo = (wallet && !editing ? wallet.memo : memo).trim();
      // The wallet is bound to the application; the backend also saves it as the
      // account default, so refresh the cached user afterwards.
      await api.applyToBounty(bounty.id, finalAddr, finalMemo);
      void auth.reload();
      onApplied();
    } catch (err: any) {
      const code = (err?.body as any)?.error || err?.message || "apply_failed";
      setError(
        code === "invalid_address" ? "That Stellar address doesn't validate — double-check it." :
        code === "invalid_memo" ? "Memo is too long — 28 bytes max." :
        code === "no_trustline" ? "That wallet can't receive USDC yet — add a USDC trustline in your wallet app, then apply." :
        code === "own_bounty" ? "You can't apply to a bounty you sponsor or maintain." :
        String(code).startsWith("not_open") ? "This bounty is no longer open for applications." :
        code === "stellar_unconfigured" ? "Bounties are momentarily unavailable — try again shortly." :
        "Couldn't submit your application — try again."
      );
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal c-accept" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><Icon name="x" size={13} /></button>
        <div className="c-accept-head">
          <div className="c-accept-eyebrow">apply · one click</div>
          <h2 className="c-accept-title">Apply with your GitHub profile</h2>
          <div className="c-accept-sub">
            The maintainer reviews your public GitHub work. Confirm the USDC wallet your payout would land in.
          </div>
        </div>
        <div className="c-accept-body">
          <div className="c-maint" style={{ marginBottom: 16 }}>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div className="c-maint-name" style={{ fontSize: 12 }}>
                @{auth.user?.githubLogin}
              </div>
              <div className="c-maint-meta">GitHub identity · applies as you</div>
            </div>
            <span className="pill ok"><i className="dot"></i> verified</span>
          </div>

          <div className="c-auth-bounty" style={{ margin: "0 0 16px" }}>
            <div className="c-auth-bounty-k">applying to</div>
            <div className="c-auth-bounty-row">
              <Icon name="git" size={13} color="var(--fg-mute)" />
              <span className="t">{bounty.repo}#{bounty.issueNumber} · {bounty.title}</span>
              <span className="amt">{cmoney(bounty.amountUsdc)}</span>
            </div>
          </div>

          {/* USDC payout wallet — required before applying */}
          <div className="c-apply-wallet">
            <div className="c-apply-wallet-h">
              <span>USDC payout wallet · Stellar</span>
            </div>

            {wallet && !editing ? (
              <>
                <div className="c-apply-wallet-card">
                  <div className="ic"><ChainLogo size={22} /></div>
                  <div className="body">
                    <div className="addr mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{wallet.addr}</div>
                    <div className="memo mono">{wallet.memo ? <>memo · {wallet.memo}</> : "no memo"}</div>
                  </div>
                </div>
                <div className="c-apply-wallet-ask" style={{ alignItems: "center", flexDirection: "row" }}>
                  <span style={{ fontSize: 11 }}>Your earnings go here</span>
                  <button className="c-linkbtn" onClick={() => setEditing(true)}>
                    <Icon name="edit" size={11} /> <span style={{ fontSize: 11 }}>Change wallet</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="c-apply-wallet-edit">
                <div className="c-apply-wallet-hint">
                  Enter the Stellar wallet where your <b>{cmoney(bounty.amountUsdc)}</b> payout should land.
                  It's saved as your default — change it any time. Use a self-custody wallet: exchange
                  deposit addresses may not detect contract transfers.
                </div>
                <div className="c-addr-field">
                  <input className="input mono" placeholder="G… (56 characters)" value={addr}
                    onChange={(e) => setAddr(e.target.value)} style={{ height: 40, fontSize: 12, paddingRight: ok ? 92 : 12 }} />
                  {ok && <span className="c-addr-valid"><Icon name="check" size={12} /> valid</span>}
                </div>
                {addr && !ok && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>Should start with G and be 56 characters.</div>}
                <input className="input mono" placeholder="Memo (optional)" value={memo}
                  onChange={(e) => setMemo(e.target.value)} style={{ height: 38, fontSize: 12, marginTop: 8 }} />
                {!memoOk && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>Memo is limited to 28 bytes.</div>}
                {wallet && (
                  <button className="c-linkbtn" style={{ marginTop: 10 }} onClick={() => { setEditing(false); setAddr(wallet.addr); setMemo(wallet.memo); }}>
                    <Icon name="chevron-r" size={11} style={{ transform: "rotate(180deg)" }} /> Use my saved wallet
                  </button>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 12 }}>{error}</div>
          )}
        </div>
        <div className="c-accept-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canApply} onClick={() => void confirmApply()}>
            <Icon name="send" size={13} /> {busy ? "Applying…" : `Apply as @${auth.user?.githubLogin}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Apply control (rail box) ─────────────────────────────────────────────────
const ApplyControl = ({
  authed,
  applied,
  onRequestAuth,
  onOpenApply,
  onGoDashboard,
}: {
  authed: boolean;
  applied: boolean;
  onRequestAuth: () => void;
  onOpenApply: () => void;
  onGoDashboard: () => void;
}) => {
  if (applied) {
    return (
      <div className="c-applied">
        <div className="c-applied-mark"><Icon name="check" size={20} /></div>
        <div className="c-applied-t">Application submitted</div>
        <div className="c-applied-d">You're in the running. We'll notify you the moment the maintainer decides.</div>
        <button className="btn primary c-apply-cta" onClick={onGoDashboard}>
          <Icon name="briefcase" size={13} /> View in dashboard
        </button>
      </div>
    );
  }
  return (
    <button className="btn primary c-apply-cta" onClick={authed ? onOpenApply : onRequestAuth}>
      {authed ? <><Icon name="send" size={14} /> Apply for this bounty</> : <>Proceed to Apply</>}
    </button>
  );
};

// ── Discovery page ───────────────────────────────────────────────────────────
export function Discovery({ bountyId }: { bountyId: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [bounty, setBounty] = React.useState<PublicBounty | null>(null);
  const [explorerBase, setExplorerBase] = React.useState("https://stellar.expert/explorer/testnet");
  const [missing, setMissing] = React.useState(false);
  const [applied, setApplied] = React.useState(false);
  const [showApply, setShowApply] = React.useState(false);

  const authed = auth.status === "signed_in";

  // Public read — renders for anyone.
  React.useEffect(() => {
    let alive = true;
    api.publicBounty(bountyId)
      .then((d) => { if (alive) { setBounty(d.bounty); setExplorerBase(d.explorerBase); } })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [bountyId]);

  // Signed-in read — did I already apply?
  React.useEffect(() => {
    if (!authed) return;
    let alive = true;
    api.bounty(bountyId)
      .then((d) => {
        if (!alive) return;
        const mine = (d.bounty.applications || []).find((a) => a.githubId === auth.user!.githubId);
        if (mine) setApplied(true);
      })
      .catch(() => { /* public view already covers the render */ });
    return () => { alive = false; };
  }, [authed, bountyId, auth.user]);

  // Post-OAuth return: /bounties/:id?apply=1&auth=ok → auto-open the modal,
  // then strip the params so refresh/back doesn't re-trigger it.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const wantsApply = url.searchParams.get("apply") === "1" || url.searchParams.get("auth") === "ok";
    if (!wantsApply) return;
    if (auth.status === "loading") return; // wait for the session check
    url.searchParams.delete("apply");
    url.searchParams.delete("auth");
    window.history.replaceState(null, "", url.pathname + (url.search || ""));
    if (auth.status === "signed_in" && !applied) setShowApply(true);
  }, [auth.status, applied]);

  const onRequestAuth = () => navigate(`/auth?bounty=${encodeURIComponent(bountyId)}`);
  const onGoDashboard = () => navigate("/dashboard");

  if (missing) {
    return (
      <div className="c-pub">
        <PubNav />
        <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
          <div style={{ textAlign: "center" }}>
            <div className="mono" style={{ fontSize: 13, color: "var(--fg)" }}>This bounty isn't available.</div>
            <div className="mono mute" style={{ fontSize: 11, marginTop: 8 }}>It may have been cancelled, paid out, or the link is wrong.</div>
          </div>
        </div>
      </div>
    );
  }
  if (!bounty) {
    return (
      <div className="c-pub">
        <PubNav />
        <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
          <span className="mono mute" style={{ fontSize: 12 }}>loading bounty…</span>
        </div>
      </div>
    );
  }

  const paragraphs = bounty.description.split(/\n{2,}|\r\n\r\n/).filter((p) => p.trim());
  const wallet: Wallet | null = auth.user?.stellarPayoutAddress
    ? { addr: auth.user.stellarPayoutAddress, memo: auth.user.stellarPayoutMemo || "" }
    : null;

  return (
    <div className="c-pub">
      <PubNav />

      <div className="c-disc">
        <div className="c-disc-rail">
          <EscrowCard bounty={bounty} explorerBase={explorerBase}>
            <div className="c-escrow-apply">
              <ApplyControl
                authed={authed} applied={applied}
                onRequestAuth={onRequestAuth}
                onOpenApply={() => setShowApply(true)}
                onGoDashboard={onGoDashboard}
              />
            </div>
          </EscrowCard>
        </div>

        <div className="c-disc-main">
          <div className="c-disc-eyebrow">
            <a href={bounty.issueUrl} target="_blank" rel="noopener noreferrer"><Icon name="github" size={13} /> {bounty.repo}</a>
            <span className="sep">/</span>
            <a href={bounty.issueUrl} target="_blank" rel="noopener noreferrer">issue #{bounty.issueNumber}</a>
            <span className="sep">·</span>
            <span>posted {timeAgo(bounty.createdAt)}</span>
          </div>
          <h1 className="c-disc-title">{bounty.title}</h1>
          <div className="c-disc-tags">
            <span className="gh-label">{bounty.code}</span>
            <span className="gh-label">{bounty.deliveryDays}-day delivery</span>
            <span className="gh-label">{bounty.applicantCount} applicant{bounty.applicantCount === 1 ? "" : "s"}</span>
          </div>

          <div className="c-sec">
            <div className="c-sec-h"><Icon name="doc" size={12} /> The task</div>
            <div className="c-prose">
              {paragraphs.length ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : <p>See the linked GitHub issue for the full description.</p>}
            </div>
          </div>

          {bounty.acceptance.length > 0 && (
            <div className="c-sec">
              <div className="c-sec-h"><Icon name="lock" size={12} /> Acceptance criteria · locked at funding</div>
              <div className="c-crit-list">
                {bounty.acceptance.map((c, i) => (
                  <div key={i} className="c-crit-item">
                    <span className="n">{String(i + 1).padStart(2, "0")}</span>
                    <span className="t">{c}</span>
                  </div>
                ))}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 10, display: "flex", alignItems: "center", gap: 8, lineHeight: 1.5 }}>
                These are frozen for the life of the bounty. DevAsign reviews your PR against exactly this list — nothing gets moved after you start.
              </div>
            </div>
          )}

          <div className="c-sec">
            <div className="c-sec-h"><Icon name="coins" size={12} /> How you get paid</div>
            <div className="c-steps">
              {[
                { t: "Apply with GitHub + your wallet", d: <>One-click apply with GitHub — and confirm the USDC wallet your payout lands in. The maintainer reviews applicants and assigns one.</> },
                { t: "Get picked & start", d: <>When you're picked, the bounty is yours. The <b>{cmoney(bounty.amountUsdc)}</b> already sits in escrow, waiting to pay out to the wallet on your profile.</> },
                { t: "Ship & pass review", d: <>Open your PR and link it. DevAsign checks it against the locked criteria; iterate until it's green.</> },
                { t: "Escrow pays out to your wallet", d: <>On approval, the Stellar escrow releases <b>directly to your own USDC wallet</b> — no DevAsign-held balance, nothing to withdraw.</> },
              ].map((s, i) => (
                <div key={i} className="c-step">
                  <div className="c-step-n">{i + 1}</div>
                  <div>
                    <div className="c-step-t">{s.t}</div>
                    <div className="c-step-d">{s.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showApply && (
        <ApplyModal
          bounty={bounty}
          wallet={wallet}
          onClose={() => setShowApply(false)}
          onApplied={() => { setShowApply(false); setApplied(true); }}
        />
      )}
    </div>
  );
}
