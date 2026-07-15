// Bounties page — sponsor-facing dashboard. Wired to the backend bounty API
// (frontend/src/api.ts): the header stats, bounty table, transaction history, and
// the per-bounty drawer all render live data from `api.bounties()` +
// `api.bountyTransactions()`. The Fund and Cancel routes (/bounties/:id/fund,
// /bounties/:id/cancel — reached from the GitHub bot comment links) mount this
// page with isFunding/isCancelling and drive the matching escrow flow.
//
// Layout: a header (title + escrow balance + top-up/withdraw/create actions), a
// 6-stat grid, filter tabs + search, and a two-column body — a bounties table on
// the left and a transaction-history table on the right. Clicking a bounty row
// opens a right-anchored slide-over drawer with three tabs: Details / Submissions
// / Applications.
import React from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { Icon } from "./icons";
import {
  api,
  type Bounty,
  type BountyApplication,
  type BountyStatus,
  type BountySummary,
  type EscrowTransaction,
} from "./api";

// ─── Status presentation ──────────────────────────────────────────────────────
// Backend BountyStatus → human label / pill class / status-dot colour.
const ST_LABEL: Record<BountyStatus, string> = {
  PENDING_FUNDING: "PENDING",
  OPEN: "OPEN",
  DELEGATED: "DELEGATED",
  IN_REVIEW: "IN REVIEW",
  PAID: "PAID",
  CANCELLED: "CANCELLED",
  DISPUTED: "DISPUTED",
};
const ST_CLS: Record<BountyStatus, string> = {
  PENDING_FUNDING: "warn",
  OPEN: "running",
  DELEGATED: "nit",
  IN_REVIEW: "warn",
  PAID: "nit",
  CANCELLED: "nit",
  DISPUTED: "danger",
};
const ST_DOT: Record<BountyStatus, string> = {
  PENDING_FUNDING: "var(--warn)",
  OPEN: "var(--accent)",
  DELEGATED: "var(--fg-faint)",
  IN_REVIEW: "var(--warn)",
  PAID: "var(--green)",
  CANCELLED: "var(--fg-faint)",
  DISPUTED: "var(--danger)",
};

const TABS: Array<{ key: string; label: string; match: (b: Bounty) => boolean }> = [
  { key: "all",       label: "all",       match: () => true },
  { key: "open",      label: "open",      match: (b) => b.status === "OPEN" },
  { key: "in_review", label: "in review", match: (b) => b.status === "IN_REVIEW" },
  { key: "disputed",  label: "disputed",  match: (b) => b.status === "DISPUTED" },
  { key: "paid",      label: "paid",      match: (b) => b.status === "PAID" },
];

const PAGE_SIZE = 10;
const TX_PAGE_SIZE = 10;

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
// Placeholder shown for monetary values when the balance-eye toggle hides them.
const MASK = "••••";

// Stellar amounts are i128 "stroops" (1 USDC = 10^7 stroops). Display-only, so a
// double is fine for the magnitudes bounties use.
const stroopsToUsdc = (s: string) => (Number(s) || 0) / 1e7;
const shortHash = (h: string) => (h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);
const stellarTxUrl = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;
const fmtDay = (ts?: number | null) =>
  ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const fmtDate = (ts?: number | null) =>
  ts ? new Date(ts).toISOString().slice(0, 10) : "—";

// ─── Page ───────────────────────────────────────────────────────────────────
export const BountiesPage = ({
  isMobile,
  isFunding,
  isCancelling,
}: {
  isMobile?: boolean;
  isFunding?: boolean;
  isCancelling?: boolean;
}) => {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [bounties, setBounties] = React.useState<Bounty[]>([]);
  const [summary, setSummary] = React.useState<BountySummary>({ total: 0, active: 0, inEscrow: 0, paidOut: 0 });
  const [txns, setTxns] = React.useState<EscrowTransaction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [tab, setTab] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [txPage, setTxPage] = React.useState(1);
  const [balanceHidden, setBalanceHidden] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, t] = await Promise.all([api.bounties(), api.bountyTransactions()]);
      setBounties(b.bounties);
      setSummary(b.summary);
      setTxns(t.transactions);
    } catch (err: any) {
      setError(err?.message || "Couldn't load bounties.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  // Merge a mutated bounty (returned by approve/reject) back into the list so the
  // open drawer and table update without a full refetch.
  const applyBounty = React.useCallback((b: Bounty) => {
    setBounties((prev) => prev.map((x) => (x.id === b.id ? b : x)));
  }, []);

  const matcher = TABS.find((t) => t.key === tab)!.match;
  const filtered = bounties.filter(matcher).filter((b) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return b.title.toLowerCase().includes(q) || b.code.toLowerCase().includes(q) || b.repo.toLowerCase().includes(q);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const start = (cur - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  const txPages = Math.max(1, Math.ceil(txns.length / TX_PAGE_SIZE));
  const txCur = Math.min(txPage, txPages);
  const txStart = (txCur - 1) * TX_PAGE_SIZE;
  const txShown = txns.slice(txStart, txStart + TX_PAGE_SIZE);

  const selected = selectedId != null ? bounties.find((b) => b.id === selectedId) || null : null;

  const openCount = bounties.filter((b) => b.status === "OPEN").length;
  const inReviewCount = bounties.filter((b) => b.status === "IN_REVIEW").length;
  const org = bounties[0]?.repo?.split("/")[0];

  return (
    <div className="page bnty-page" style={{ maxWidth: "none" }}>
      {/* Header */}
      <div className="page-head bnty-head">
        <div>
          <h1 className="page-title">Bounty</h1>
          <div className="page-sub">
            {summary.active} active{org ? ` · ${org} org` : ""}
          </div>
        </div>
        <div className="bnty-head-actions">
          <div className="bnty-balance">
            <span className="bnty-balance-label">in escrow</span>
            <span className="bnty-balance-amt">{balanceHidden ? "••••••" : summary.inEscrow.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            <span className="bnty-balance-unit">USDC</span>
            <button className="balance-eye" onClick={() => setBalanceHidden((v) => !v)} aria-label="Toggle balance visibility">
              <Icon name={balanceHidden ? "eye-off" : "eye"} size={13} />
            </button>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> Create bounty</button>
        </div>
      </div>

      {error ? (
        <div className="bnty-empty mono mute" style={{ padding: 48, textAlign: "center" }}>
          {error}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      ) : loading ? (
        <div className="bnty-empty mono mute" style={{ padding: 48, textAlign: "center" }}>Loading bounties…</div>
      ) : (
        <>
          {/* Stat grid */}
          <div className="stat-grid bnty-stats">
            <Stat label="Total bounties" value={String(summary.total)} suffix={`${summary.active} active`} />
            <Stat label="Active" value={String(summary.active)} suffix="in flight" />
            <Stat label="Open bounties" value={String(openCount)} suffix="accepting work" />
            <Stat label="In review" value={String(inReviewCount)} suffix="awaiting merge" />
            <Stat label="In escrow" value={money(summary.inEscrow)} suffix="held for devs" color="var(--info)" hidden={balanceHidden} />
            <Stat label="Paid out" value={money(summary.paidOut)} suffix="lifetime" color="var(--green)" hidden={balanceHidden} />
          </div>

          {/* Filters + search */}
          <div className="bnty-controls">
            <div className="bnty-filters">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`bnty-filter ${tab === t.key ? "active" : ""}`}
                  onClick={() => { setTab(t.key); setPage(1); }}
                >
                  {t.label} <span className="n">· {bounties.filter(t.match).length}</span>
                </button>
              ))}
            </div>
            <div className="bnty-controls-right">
              <div className="bnty-search">
                <Icon name="search" size={13} />
                <input
                  className="input bare"
                  placeholder="Search bounties…"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                />
              </div>
            </div>
          </div>

          {/* Two-column body */}
          <div className="bounty-dash">
            {/* Bounties */}
            <section className="bnty-panel">
              <div className="bnty-panel-head">
                <span className="bnty-panel-title">Bounties</span>
                <span className="bnty-panel-meta">{filtered.length} shown</span>
              </div>
              <div className="row-table bnty-list">
                <div className="bounty-row head">
                  <span />
                  <span>ID</span>
                  <span>Title</span>
                  <span>Repo · Issue</span>
                  <span>Amount</span>
                  <span>Status</span>
                  <span>Subs</span>
                </div>
                {shown.length === 0 ? (
                  <div className="bnty-empty mono mute">
                    {bounties.length === 0 ? "No bounties yet. Comment `bounty` on a GitHub issue to create one." : `No ${tab.replace("_", " ")} bounties.`}
                  </div>
                ) : (
                  shown.map((b) => <BountyRow key={b.id} b={b} hidden={balanceHidden} onClick={() => setSelectedId(b.id)} />)
                )}
              </div>
              <div className="bounty-pager">
                <span className="mono mute" style={{ fontSize: 11 }}>
                  Showing {filtered.length === 0 ? 0 : start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <Pager cur={cur} pages={pages} onGo={setPage} />
              </div>
            </section>

            {/* Transactions */}
            <section className="bnty-panel">
              <div className="bnty-panel-head">
                <span className="bnty-panel-title">Transaction history</span>
                <span className="bnty-panel-meta">
                  {txns.length} total
                  <button className="btn ghost sm" style={{ marginLeft: 10 }}><Icon name="download" size={12} /> CSV</button>
                </span>
              </div>
              <div className="row-table txn-listwrap">
                <div className="txn-row head">
                  <span>Txn ID</span>
                  <span>Date</span>
                  <span>Note</span>
                  <span>Amount</span>
                  <span>Txn hash</span>
                  <span>Status</span>
                  <span>Invoice</span>
                </div>
                {txShown.length === 0 ? (
                  <div className="bnty-empty mono mute">No transactions yet.</div>
                ) : (
                  txShown.map((t) => <TxnRow key={t.id} t={t} hidden={balanceHidden} />)
                )}
              </div>
              <div className="bounty-pager">
                <span className="mono mute" style={{ fontSize: 11 }}>
                  Showing {txns.length === 0 ? 0 : txStart + 1}–{Math.min(txStart + TX_PAGE_SIZE, txns.length)} of {txns.length}
                </span>
                <Pager cur={txCur} pages={txPages} onGo={setTxPage} />
              </div>
            </section>
          </div>
        </>
      )}

      {selected && <BountyDrawer bounty={selected} onClose={() => setSelectedId(null)} onChanged={applyBounty} />}
      {creating && <CreateBountyModal onClose={() => setCreating(false)} />}
      {isFunding && (
        <FundBountyModal id={params.id} token={search.get("token")} onClose={() => navigate("/bounty")} />
      )}
      {isCancelling && (
        <CancelBountyModal id={params.id} token={search.get("token")} onClose={() => navigate("/bounty")} />
      )}
    </div>
  );
};

const Stat = ({ label, value, suffix, color, hidden }: { label: string; value: string; suffix?: string; color?: string; hidden?: boolean }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value" style={color && !hidden ? { color } : undefined}>
      {hidden ? MASK : value}
      {suffix && <span className="bnty-stat-suffix"> {suffix}</span>}
    </div>
  </div>
);

const Pager = ({ cur, pages, onGo }: { cur: number; pages: number; onGo: (p: number) => void }) => (
  <div className="flex items-center gap-2">
    <button className="btn ghost sm" disabled={cur === 1} onClick={() => onGo(cur - 1)}>← Prev</button>
    {Array.from({ length: pages }, (_, i) => (
      <button key={i} className={`btn ghost sm ${cur === i + 1 ? "is-active" : ""}`} onClick={() => onGo(i + 1)}>{i + 1}</button>
    ))}
    <button className="btn ghost sm" disabled={cur === pages} onClick={() => onGo(cur + 1)}>Next →</button>
  </div>
);

const BountyRow = ({ b, onClick, hidden }: { b: Bounty; onClick: () => void; hidden?: boolean }) => {
  const subs = b.prNumber ? 1 : 0;
  const unread = (b.applications || []).some((a) => a.status === "pending");
  return (
    <div className={`bounty-row ${unread ? "has-unread" : ""}`} onClick={onClick}>
      <span><i style={{ display: "inline-block", width: 6, height: 6, background: ST_DOT[b.status] }} /></span>
      <span className="bounty-id">{b.code}</span>
      <span className="bounty-title" title={b.title}>{b.title}</span>
      <span className="mono mute" style={{ fontSize: 11 }}>{b.repo}#{b.issueNumber}</span>
      <span className="mono" style={{ fontVariantNumeric: "tabular-nums", color: hidden ? "var(--fg-mute)" : undefined }}>{hidden ? MASK : money(b.amountUsdc)}</span>
      <span className={`pill ${ST_CLS[b.status]}`}><i className="dot" />{ST_LABEL[b.status]}</span>
      <span>
        {subs > 0
          ? <span className="subs-badge"><Icon name="git" size={11} /> {subs}</span>
          : <span className="mute">–</span>}
      </span>
    </div>
  );
};

const TXN_PILL: Record<EscrowTransaction["status"], { label: string; cls: string }> = {
  confirmed: { label: "CONFIRMED", cls: "running" },
  pending: { label: "PENDING", cls: "warn" },
  failed: { label: "FAILED", cls: "danger" },
};

const TxnRow = ({ t, hidden }: { t: EscrowTransaction; hidden?: boolean }) => {
  const usdc = stroopsToUsdc(t.amountStroops);
  const note = t.note || `${t.kind}${t.githubLogin ? ` · @${t.githubLogin}` : ""}`;
  const pill = TXN_PILL[t.status];
  return (
    <div className="txn-row">
      <span className="mono mute" style={{ fontSize: 11 }}>{t.id.slice(0, 10)}</span>
      <span className="mono mute" style={{ fontSize: 11 }}>{fmtDate(t.createdAt)}</span>
      <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={note}>{note}</span>
      <span className="mono" style={{ fontVariantNumeric: "tabular-nums", color: hidden ? "var(--fg-mute)" : (t.dir === "in" ? "var(--green)" : "var(--danger)") }}>
        {hidden ? MASK : `${t.dir === "in" ? "+" : ""}${money(Math.round(usdc))}`}
      </span>
      <span className="txn-hash">
        {t.hash ? (
          <>
            <a href={stellarTxUrl(t.hash)} target="_blank" rel="noreferrer">{shortHash(t.hash)}</a>
            <Icon name="external" size={11} />
          </>
        ) : (
          <span className="mute">—</span>
        )}
      </span>
      <span className={`pill ${pill.cls}`}><i className="dot" />{pill.label}</span>
      <span>
        <button className="btn ghost sm"><Icon name="download" size={11} /> PDF</button>
      </span>
    </div>
  );
};

// ─── Drawer ─────────────────────────────────────────────────────────────────
function activityFor(b: Bounty): Array<{ time: string; text: React.ReactNode }> {
  const out: Array<{ time: string; text: React.ReactNode }> = [];
  out.push({ time: fmtDay(b.createdAt), text: <>bounty published from <span className="txt-accent">{b.repo}#{b.issueNumber}</span></> });
  if (b.escrowTxHash) out.push({ time: fmtDay(b.createdAt), text: `escrowed $${b.amountUsdc} USDC on Stellar` });
  if (b.acceptedAt) out.push({ time: fmtDay(b.acceptedAt), text: `bounty assigned to @${b.assigneeGithubLogin || "developer"}` });
  if (b.prNumber) out.push({ time: fmtDay(b.updatedAt), text: <>PR #{b.prNumber} opened</> });
  if (b.payoutTxHash) out.push({ time: fmtDay(b.updatedAt), text: `payout released to @${b.assigneeGithubLogin || "developer"}` });
  if (b.refundTxHash) out.push({ time: fmtDay(b.updatedAt), text: "escrow refunded to sponsor" });
  return out.reverse(); // newest first
}

const BountyDrawer = ({ bounty, onClose, onChanged }: { bounty: Bounty; onClose: () => void; onChanged: (b: Bounty) => void }) => {
  const [tab, setTab] = React.useState<"details" | "submissions" | "applications">("details");
  const apps = bounty.applications || [];
  const newApps = apps.filter((a) => a.status === "pending").length;
  const subCount = bounty.prNumber ? 1 : 0;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const delegated = bounty.status === "DELEGATED" || bounty.status === "IN_REVIEW" || !!bounty.assigneeGithubLogin;

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer bounty" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono mute" style={{ fontSize: 11 }}>{bounty.code}</div>
            <div className="drawer-title">{bounty.title}</div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        </div>

        <div className="drawer-tabs">
          <TabBtn active={tab === "details"} onClick={() => setTab("details")}>Details</TabBtn>
          <TabBtn active={tab === "submissions"} onClick={() => setTab("submissions")}>
            Submissions
            {tab !== "submissions" && subCount > 0 && <span className="tab-count">{subCount}</span>}
          </TabBtn>
          <TabBtn active={tab === "applications"} onClick={() => setTab("applications")}>
            Applications
            {tab !== "applications" && newApps > 0 && <span className="tab-count new">{newApps} new</span>}
          </TabBtn>
        </div>

        <div className="drawer-body">
          {tab === "details" && <DetailsTab b={bounty} />}
          {tab === "submissions" && <SubmissionsTab b={bounty} />}
          {tab === "applications" && <ApplicationsTab b={bounty} onChanged={onChanged} />}
        </div>

        {tab === "details" && (
          <div className="drawer-foot">
            <span className="mono mute" style={{ fontSize: 11 }}>
              {bounty.status === "PENDING_FUNDING"
                ? "Awaiting funding · sign with Freighter to activate"
                : delegated ? "Cannot cancel · bounty is delegated" : "This bounty can still be cancelled"}
            </span>
            {bounty.status === "PENDING_FUNDING" && bounty.cancelUrl && (
              <a className="btn" href={bounty.cancelUrl}><Icon name="x" size={13} /> Cancel</a>
            )}
            {bounty.status === "PENDING_FUNDING" && bounty.fundingUrl && (
              <a className="btn primary" href={bounty.fundingUrl}><Icon name="check" size={13} /> Fund bounty</a>
            )}
            <a className="btn" href={bounty.issueUrl} target="_blank" rel="noreferrer"><Icon name="github" size={13} /> View on GitHub</a>
          </div>
        )}
      </div>
    </div>
  );
};

const TabBtn = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
  <div className={`drawer-tab ${active ? "picked" : ""}`} onClick={onClick}>{children}</div>
);

const DetailsTab = ({ b }: { b: Bounty }) => {
  const escrowHash = b.escrowTxHash || b.payoutTxHash || b.refundTxHash || null;
  const activity = activityFor(b);
  return (
    <>
      <div className="kv-grid">
        <div className="kv">
          <div className="kv-k">Amount</div>
          <div className="kv-v"><span style={{ color: "var(--accent)" }}>{money(b.amountUsdc)}</span> <span className="mute">USDC</span></div>
        </div>
        <div className="kv">
          <div className="kv-k">Payout chain</div>
          <div className="kv-v"><span className="chain-pip" style={{ background: "var(--purple)" }} /> stellar</div>
        </div>
        <div className="kv">
          <div className="kv-k">Status</div>
          <div className="kv-v"><span className={`pill ${ST_CLS[b.status]}`}><i className="dot" />{ST_LABEL[b.status]}</span></div>
        </div>
        <div className="kv">
          <div className="kv-k">Delivery</div>
          <div className="kv-v">{b.deliveryDays} day{b.deliveryDays === 1 ? "" : "s"}{b.deadlineAt ? ` · due ${fmtDay(b.deadlineAt)}` : ""}</div>
        </div>
        <div className="kv">
          <div className="kv-k">Applications</div>
          <div className="kv-v">{b.applications?.length ? `${b.applications.length} applied` : "no applications yet"}</div>
        </div>
        <div className="kv">
          <div className="kv-k">Issue</div>
          <div className="kv-v mono" style={{ fontSize: 12 }}>
            <a href={b.issueUrl} target="_blank" rel="noreferrer">{b.repo}#{b.issueNumber}</a> <Icon name="github" size={12} />
          </div>
        </div>
      </div>

      <div className="drawer-section">
        <div className="drawer-section-head">Escrow transaction</div>
        {escrowHash ? (
          <>
            <a className="mono" href={stellarTxUrl(escrowHash)} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
              {shortHash(escrowHash)} <Icon name="external" size={12} />
            </a>
            <div className="mono mute" style={{ fontSize: 11, marginTop: 6 }}>{b.amountUsdc} USDC escrowed on Stellar · view on stellar.expert</div>
          </>
        ) : (
          <div className="mono mute" style={{ fontSize: 12 }}>Not yet funded.</div>
        )}
      </div>

      <div className="drawer-section">
        <div className="drawer-section-head">Description</div>
        <div className="drawer-prose">{b.description || "No description provided."}</div>
      </div>

      {b.acceptance?.length > 0 && (
        <div className="drawer-section">
          <div className="drawer-section-head">Acceptance criteria</div>
          <ul className="ac-list">
            {b.acceptance.map((c, i) => <li key={i} className="ac-item">{c}</li>)}
          </ul>
        </div>
      )}

      <div className="drawer-section">
        <div className="drawer-section-head">Activity</div>
        {activity.map((a, i) => (
          <div key={i} className="activity-line">
            <span className="mono" style={{ minWidth: 96, color: "var(--fg-mute)" }}>{a.time}</span>
            <span>{a.text}</span>
          </div>
        ))}
      </div>
    </>
  );
};

const SubmissionsTab = ({ b }: { b: Bounty }) => {
  if (!b.prNumber) {
    return (
      <div className="drawer-empty">
        <div className="drawer-empty-art"><Icon name="git" size={22} color="var(--fg-mute)" /></div>
        <div className="drawer-empty-title">No submissions yet</div>
        <div className="drawer-empty-sub">When the delegated contributor opens a PR against this bounty it appears here.</div>
      </div>
    );
  }
  return (
    <>
      <div className="mono mute" style={{ fontSize: 11, marginBottom: 14 }}>
        Merging this PR on GitHub auto-releases the escrow to @{b.assigneeGithubLogin || "the contributor"} on Stellar.
      </div>
      <div className="sub-cards">
        <div className="sub-card ready">
          <div className="sub-card-head">
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span className="mono" style={{ fontWeight: 600 }}>@{b.assigneeGithubLogin || "contributor"}</span>
              <span className="mono mute" style={{ fontSize: 11 }}>
                <Icon name="git" size={10} /> {b.repo}#{b.prNumber}
              </span>
            </div>
          </div>
          <div className="sub-card-note">
            Status: {ST_LABEL[b.status]}. When you merge the PR, the escrowed {money(b.amountUsdc)} USDC is released automatically — no extra action needed.
          </div>
          <div className="sub-card-actions">
            <a className="btn sm" href={prUrl(b.repo, b.prNumber)} target="_blank" rel="noreferrer"><Icon name="github" size={11} /> View PR <Icon name="external" size={10} /></a>
          </div>
        </div>
      </div>
    </>
  );
};

const APP_PILL: Record<BountyApplication["status"], { label: string; cls: string }> = {
  pending: { label: "PENDING", cls: "warn" },
  approved: { label: "DELEGATED", cls: "running" },
  accepted: { label: "ACCEPTED", cls: "green" },
  rejected: { label: "REJECTED", cls: "nit" },
};

const ApplicationsTab = ({ b, onChanged }: { b: Bounty; onChanged: (b: Bounty) => void }) => {
  const [confirming, setConfirming] = React.useState<Record<number, "reject" | "delegate">>({});
  const [busy, setBusy] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const apps = b.applications || [];
  const clearConfirm = (githubId: number) => setConfirming((c) => { const n = { ...c }; delete n[githubId]; return n; });

  const act = async (githubId: number, kind: "reject" | "delegate") => {
    setBusy(githubId);
    setErr(null);
    try {
      const res = kind === "delegate"
        ? await api.approveApplication(b.id, githubId)
        : await api.rejectApplication(b.id, githubId);
      onChanged(res.bounty);
    } catch (e: any) {
      setErr(e?.message || "Action failed.");
    } finally {
      setBusy(null);
      clearConfirm(githubId);
    }
  };

  if (apps.length === 0) {
    return (
      <div className="drawer-empty">
        <div className="drawer-empty-art"><Icon name="user" size={22} color="var(--fg-mute)" /></div>
        <div className="drawer-empty-title">No applications yet</div>
        <div className="drawer-empty-sub">Developers who comment <span className="mono">claim</span> on the issue show up here to be delegated.</div>
      </div>
    );
  }

  // Only allow delegating/rejecting while the bounty is still open for assignment.
  const canAct = b.status === "OPEN";

  return (
    <>
      <div className="mono mute" style={{ fontSize: 11, marginBottom: 14 }}>
        {apps.length} application{apps.length === 1 ? "" : "s"} · sorted by status
      </div>
      {err && <div className="mono" style={{ fontSize: 11, color: "var(--danger)", marginBottom: 10 }}>{err}</div>}
      <div className="app-cards">
        {apps.map((a) => {
          const pill = APP_PILL[a.status];
          const pending = a.status === "pending";
          const isBusy = busy === a.githubId;
          return (
            <div key={a.githubId} className={`app-card ${pending ? "new" : ""}`}>
              <div className="app-card-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>@{a.githubLogin}</span>
                    {pending && <span className="tab-count new">NEW</span>}
                  </div>
                  <div className="mono mute" style={{ fontSize: 11, marginTop: 4 }}>
                    applied {fmtDay(a.appliedAt)}{a.note ? ` · ${a.note}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  {!pending || !canAct ? (
                    <span className={`pill ${pill.cls}`}><i className="dot" />{pill.label}</span>
                  ) : confirming[a.githubId] ? null : (
                    <>
                      <button className="btn sm" disabled={isBusy} onClick={() => setConfirming((c) => ({ ...c, [a.githubId]: "reject" }))}>Reject</button>
                      <button className="btn sm primary" disabled={isBusy} onClick={() => setConfirming((c) => ({ ...c, [a.githubId]: "delegate" }))}>Delegate</button>
                    </>
                  )}
                </div>
              </div>
              {confirming[a.githubId] && pending && canAct && (
                <div className={`app-confirm ${confirming[a.githubId]}`}>
                  {confirming[a.githubId] === "reject" && (
                    <span className="app-confirm-icon"><Icon name="warn" size={15} /></span>
                  )}
                  <div className="app-confirm-msg">
                    {confirming[a.githubId] === "reject"
                      ? "Reject this application? This can't be undone."
                      : `Delegate this bounty to @${a.githubLogin}? Every other application on this bounty will be automatically rejected.`}
                  </div>
                  <div className="app-confirm-actions">
                    <button className="btn sm ghost" disabled={isBusy} onClick={() => clearConfirm(a.githubId)}>Cancel</button>
                    {confirming[a.githubId] === "reject" ? (
                      <button className="btn sm app-confirm-go reject" disabled={isBusy} onClick={() => act(a.githubId, "reject")}>
                        <Icon name="x" size={11} /> {isBusy ? "Rejecting…" : "Confirm reject"}
                      </button>
                    ) : (
                      <button className="btn sm app-confirm-go delegate" disabled={isBusy} onClick={() => act(a.githubId, "delegate")}>
                        <Icon name="check" size={11} /> {isBusy ? "Delegating…" : "Confirm delegate"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
};

// ─── Freighter (browser wallet) bridge ────────────────────────────────────────
// We talk to Freighter through its official `@stellar/freighter-api` package
// rather than sniffing for an injected `window` global: current Freighter builds
// don't expose a reliable page global, and the extension's content script is
// injected asynchronously — so global detection produced false "not detected"
// errors even when the wallet was installed. The package handles the postMessage
// bridge (and its readiness) for us.
async function freighterAddress(): Promise<string> {
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
async function freighterSign(xdr: string, address: string, networkPassphrase: string): Promise<string> {
  const signed = await signTransaction(xdr, { address, networkPassphrase });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error(signed.error?.message || "Transaction signing was cancelled.");
  }
  return signed.signedTxXdr;
}

// ─── Fund modal (from /bounties/:id/fund?token=…) ─────────────────────────────
const FundBountyModal = ({ id, token, onClose }: { id?: string; token: string | null; onClose: () => void }) => {
  const [bounty, setBounty] = React.useState<Bounty | null>(null);
  const [phase, setPhase] = React.useState<"loading" | "ready" | "working" | "done" | "error">("loading");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [hash, setHash] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    let alive = true;
    if (!id || !token) { setPhase("error"); setMsg("This funding link is missing its bounty id or security token."); return; }
    (async () => {
      try {
        const r = await api.bounty(id);
        if (!alive) return;
        setBounty(r.bounty);
        setPhase("ready");
      } catch (e: any) {
        if (!alive) return;
        setPhase("error");
        setMsg(e?.message || "Couldn't load this bounty.");
      }
    })();
    return () => { alive = false; };
  }, [id, token]);

  const fund = async () => {
    if (!id || !token) return;
    setPhase("working");
    setMsg(null);
    try {
      const address = await freighterAddress();
      const { xdr, networkPassphrase } = await api.bountyFundingTx(id, token, address);
      const signedXdr = await freighterSign(xdr, address, networkPassphrase);
      const res = await api.submitBountyFunding(id, token, signedXdr);
      setHash(res.hash || null);
      setPhase("done");
    } catch (e: any) {
      setMsg(e?.message || "Funding failed.");
      setPhase("error");
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        <div className="cb-modal-head">
          <div className="cb-eyebrow">Fund bounty</div>
          <h2 className="cb-modal-title">Escrow this bounty</h2>
          <div className="cb-modal-sub">
            {bounty
              ? <>Fund <span className="mono">{bounty.code}</span> — {bounty.title}. You'll sign a create-escrow transaction with your Freighter wallet.</>
              : "Sign a create-escrow transaction with your Freighter wallet to publish this bounty."}
          </div>
        </div>

        {bounty && (
          <div className="tu-notice" style={{ marginBottom: 16 }}>
            <Icon name="warn" size={15} />
            <span><b>{money(bounty.amountUsdc)} USDC</b> will move from your wallet into escrow on Stellar. It's released to the contributor when you merge their PR, or refunded to you if the deadline elapses.</span>
          </div>
        )}

        {phase === "done" ? (
          <div className="wd-success">
            <div className="wd-success-icon"><Icon name="check" size={22} /></div>
            <div className="wd-success-title">Escrow funded</div>
            <div className="wd-success-sub">
              {bounty ? <>{money(bounty.amountUsdc)} USDC is now escrowed. </> : null}
              {hash ? <>Tx <a className="mono" href={stellarTxUrl(hash)} target="_blank" rel="noreferrer">{shortHash(hash)}</a>.</> : "The transaction has been submitted."}
            </div>
          </div>
        ) : msg ? (
          <div className="mono" style={{ fontSize: 12, color: phase === "error" ? "var(--danger)" : "var(--fg-mute)", padding: "4px 0 12px" }}>{msg}</div>
        ) : null}

        <div className="cb-modal-foot">
          <button className="btn ghost" onClick={onClose}>{phase === "done" ? "Done" : "Cancel"}</button>
          {phase !== "done" && (
            <button className="btn primary" disabled={phase === "loading" || phase === "working" || !bounty} onClick={fund}>
              <Icon name="check" size={13} /> {phase === "working" ? "Signing…" : "Fund with Freighter"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Cancel modal (from /bounties/:id/cancel?token=…) ─────────────────────────
const CancelBountyModal = ({ id, token, onClose }: { id?: string; token: string | null; onClose: () => void }) => {
  const [bounty, setBounty] = React.useState<Bounty | null>(null);
  const [phase, setPhase] = React.useState<"loading" | "ready" | "working" | "done" | "error">("loading");
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    let alive = true;
    if (!id || !token) { setPhase("error"); setMsg("This cancel link is missing its bounty id or security token."); return; }
    (async () => {
      try {
        const r = await api.bounty(id);
        if (!alive) return;
        setBounty(r.bounty);
        setPhase("ready");
      } catch (e: any) {
        if (!alive) return;
        setPhase("error");
        setMsg(e?.message || "Couldn't load this bounty.");
      }
    })();
    return () => { alive = false; };
  }, [id, token]);

  const cancel = async () => {
    if (!id || !token) return;
    setPhase("working");
    setMsg(null);
    try {
      await api.cancelBounty(id, token);
      setPhase("done");
    } catch (e: any) {
      setMsg(e?.message || "Cancellation failed.");
      setPhase("error");
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        <div className="cb-modal-head">
          <div className="cb-eyebrow">Cancel bounty</div>
          <h2 className="cb-modal-title">Cancel & refund</h2>
          <div className="cb-modal-sub">
            {bounty
              ? <>Cancel <span className="mono">{bounty.code}</span> — {bounty.title}. Any escrowed funds are refunded to your wallet.</>
              : "Cancel this bounty and refund any escrowed funds to your wallet."}
          </div>
        </div>

        {phase === "done" ? (
          <div className="wd-success">
            <div className="wd-success-icon"><Icon name="check" size={22} /></div>
            <div className="wd-success-title">Bounty cancelled</div>
            <div className="wd-success-sub">{bounty ? <>{bounty.code} was cancelled.</> : "The bounty was cancelled."} Any escrow is being refunded to your wallet.</div>
          </div>
        ) : (
          <>
            {bounty && (
              <div className="tu-notice" style={{ marginBottom: 16 }}>
                <Icon name="warn" size={15} />
                <span>This closes the bounty for <b>{money(bounty.amountUsdc)} USDC</b> and refunds any escrow. This can't be undone.</span>
              </div>
            )}
            {msg && <div className="mono" style={{ fontSize: 12, color: "var(--danger)", padding: "4px 0 12px" }}>{msg}</div>}
          </>
        )}

        <div className="cb-modal-foot">
          <button className="btn ghost" onClick={onClose}>{phase === "done" ? "Done" : "Keep bounty"}</button>
          {phase !== "done" && (
            <button className="btn primary" disabled={phase === "loading" || phase === "working" || !bounty} onClick={cancel}>
              <Icon name="x" size={13} /> {phase === "working" ? "Cancelling…" : "Cancel bounty"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Create-bounty modal ────────────────────────────────────────────────────
const CBRule = ({ num, title, accent, children }: { num: string; title: string; accent?: boolean; children: React.ReactNode }) => (
  <div className={`cb-rule ${accent ? "accent" : ""}`}>
    <div className="cb-rule-num">{num}</div>
    <div>
      <div className="cb-rule-title">{title}</div>
      <div className="cb-rule-desc">{children}</div>
    </div>
  </div>
);

const CreateBountyModal = ({ onClose }: { onClose: () => void }) => {
  const [source, setSource] = React.useState<"github" | "linear">("github");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isGithub = source === "github";
  const ref = isGithub ? "acme/pay#920" : "DEV-421";

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>

        <div className="cb-modal-head">
          <div className="cb-eyebrow">New bounty</div>
          <h2 className="cb-modal-title">Create bounties from your tracker</h2>
          <div className="cb-modal-sub">
            Comment on any GitHub issue or Linear ticket. DevAsign escrows the funds and assigns the work to the first eligible developer.
          </div>
        </div>

        <div className="cb-source-tabs">
          <button className={`cb-source-tab ${isGithub ? "picked" : ""}`} onClick={() => setSource("github")}>
            <Icon name="github" size={14} /> GitHub
          </button>
          <button className={`cb-source-tab ${!isGithub ? "picked" : ""}`} onClick={() => setSource("linear")}>
            <Icon name="linear" size={14} /> Linear
          </button>
        </div>

        <div className="cb-comment">
          <div className="cb-comment-head">
            <span className="cb-avatar">M</span>
            <span className="mono" style={{ fontSize: 12 }}>
              <span style={{ color: "var(--fg)" }}>maya</span>
              <span className="mute"> commented on {ref}</span>
            </span>
            <span className="mono mute" style={{ marginLeft: "auto", fontSize: 11 }}>now</span>
          </div>
          <div className="cb-comment-body">
            <div className="cb-command-line">
              <span className="cb-cmd-token cmd">bounty</span>
              <span className="cb-cmd-token amount">$100</span>
              <span className="cb-cmd-token deadline">3 days</span>
              <button className="cb-copy" aria-label="Copy command"><Icon name="copy" size={13} /></button>
            </div>
            <div className="cb-command-anno">
              <div className="cb-anno-line"><span className="cb-anno-pip cmd" /> command keyword</div>
              <div className="cb-anno-line"><span className="cb-anno-pip amount" /> USDC escrowed from your wallet</div>
              <div className="cb-anno-line"><span className="cb-anno-pip deadline" /> deadline to merge a PR</div>
            </div>
          </div>
        </div>

        <div className="cb-rules">
          <div className="cb-rules-head">How it works</div>
          <CBRule num="01" title="Funds escrowed instantly">
            <span className="accent">$100</span> USDC is moved from your wallet into escrow on your selected payout chain.
          </CBRule>
          <CBRule num="02" title="Deadline starts ticking">
            <span className="accent">3 days</span> is the window for a developer to submit and merge a PR. The clock starts the moment the bounty is published.
          </CBRule>
          <CBRule num="03" title="Merge the PR → developer gets paid">
            When you merge the linked PR, escrow auto-releases to the developer's wallet. No extra action required.
          </CBRule>
          <CBRule num="04" title="Close without merging? Dev can retry">
            If you close the PR instead of merging, the developer can open a new PR and resubmit — as long as the deadline hasn't elapsed.
          </CBRule>
          <CBRule num="05" title="Deadline elapses → bounty closes, funds refunded" accent>
            If no PR is merged within the deadline, the bounty auto-closes and the escrowed <span className="accent">$100</span> is refunded to your wallet.
          </CBRule>
        </div>

        <div className="cb-modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary"><Icon name="external" size={13} /> Open {isGithub ? "GitHub" : "Linear"}</button>
        </div>
      </div>
    </div>
  );
};
