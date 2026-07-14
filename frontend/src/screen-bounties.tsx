// Bounties page — sponsor-facing dashboard. Front-end only: all data below is
// in-file mock data shaped to reproduce the design mockups. No network calls.
//
// Layout: a header (title + balance + top-up/withdraw/create actions), a 6-stat
// grid, filter tabs + search, and a two-column body — a bounties table on the
// left and a transaction-history table on the right. Clicking a bounty row opens
// a right-anchored slide-over drawer with three tabs: Details / Submissions /
// Applications.
import React from "react";
import { Icon } from "./icons";

// ─── Types ──────────────────────────────────────────────────────────────────
type Status = "OPEN" | "IN REVIEW" | "DELEGATED" | "PAID" | "CANCELLED" | "DISPUTED";
type TxnStatus = "CONFIRMED" | "HELD";

interface Bounty {
  seq: number;
  code: string;
  title: string;
  repo: string;
  issue: number;
  amount: number;      // whole USD
  status: Status;
  subs: number;        // submissions awaiting review
  unread: boolean;     // new developer messages
  difficulty: string;
  chain: string;
}

interface Txn {
  id: string;
  date: string;
  note: string;
  amount: number;      // whole USD (absolute)
  dir: "in" | "out";   // in = deposit/refund, out = escrow/payout
  hash: string;
  status: TxnStatus;
}

// stage → status pill class (matches the mockup: OPEN accent, IN REVIEW amber,
// DISPUTED red, everything terminal/assigned a muted grey).
const STATUS_CLS: Record<Status, string> = {
  "OPEN": "running",
  "IN REVIEW": "warn",
  "DELEGATED": "nit",
  "PAID": "nit",
  "CANCELLED": "nit",
  "DISPUTED": "danger",
};
const STATUS_DOT: Record<Status, string> = {
  "OPEN": "var(--accent)",
  "IN REVIEW": "var(--warn)",
  "DELEGATED": "var(--fg-faint)",
  "PAID": "var(--green)",
  "CANCELLED": "var(--fg-faint)",
  "DISPUTED": "var(--danger)",
};

// ─── Mock data ──────────────────────────────────────────────────────────────
// The ten rows visible on page 1, taken straight from the mockup.
const PAGE1: Array<[number, string, string, number, number, Status, number, boolean]> = [
  // seq, title, repo, issue, amount, status, subs, unread
  [184, "Fix WebSocket reconnect storm on flaky LTE", "acme/mobile", 612, 450, "DELEGATED", 0, false],
  [183, "Audit logs schema + viewer", "acme/admin", 884, 1200, "IN REVIEW", 1, true],
  [182, "Stellar memo parser for legacy txs", "acme/pay", 920, 350, "OPEN", 0, false],
  [181, "Migrate Postgres extension to pgvector", "acme/infra", 311, 800, "DELEGATED", 1, true],
  [180, "i18n strings for French CA locale", "acme/admin", 881, 220, "IN REVIEW", 1, true],
  [179, "Receipt PDF — fix accents in header", "acme/mobile", 588, 180, "PAID", 0, false],
  [178, "Fees calc rounding off by 1 satoshi", "acme/pay", 902, 280, "PAID", 0, false],
  [177, "Rate-limit middleware unit tests", "acme/infra", 308, 320, "OPEN", 0, false],
  [176, "Webhooks dashboard filters", "acme/admin", 870, 400, "CANCELLED", 0, false],
  [175, "Retry queue backoff jitter", "acme/infra", 246, 260, "IN REVIEW", 1, true],
];

// Remaining 16 rows (pages 2–3) — distribution tuned so the filter counts match
// the mockup: 9 open · 4 in review · 1 disputed · 5 paid (+ delegated/cancelled).
const REST: Array<[Status, string, string, number, number]> = [
  ["OPEN",      "GraphQL pagination cursors",          "acme/api",    271, 300],
  ["OPEN",      "Dark-mode token audit",               "acme/web",    455, 180],
  ["OPEN",      "CLI --json output flag",              "acme/cli",    142, 220],
  ["OPEN",      "Webhook signature verification",      "acme/infra",  299, 500],
  ["OPEN",      "Sentry source-map upload",            "acme/web",    388, 240],
  ["OPEN",      "Idempotency keys on payouts",         "acme/pay",    611, 640],
  ["OPEN",      "Flaky e2e: checkout timeout",         "acme/web",    502, 200],
  ["IN REVIEW", "OAuth token refresh race",            "acme/api",    233, 420],
  ["DISPUTED",  "Currency rounding in invoices",       "acme/pay",    777, 360],
  ["PAID",      "Nightly backup verification",         "acme/infra",  190, 300],
  ["PAID",      "Avatar upload EXIF strip",            "acme/mobile", 244, 150],
  ["PAID",      "Search debounce + cancel",            "acme/web",    431, 220],
  ["DELEGATED", "Feature-flag SDK upgrade",            "acme/api",    118, 480],
  ["DELEGATED", "Slack digest formatting",             "acme/infra",  356, 260],
  ["CANCELLED", "Legacy cron migration",               "acme/infra",  90,  340],
  ["CANCELLED", "Deprecated v1 route cleanup",         "acme/api",    77,  120],
];

const MOCK_BOUNTIES: Bounty[] = [
  ...PAGE1.map(([seq, title, repo, issue, amount, status, subs, unread]) => ({
    seq, code: `BNTY-${seq}`, title, repo, issue: issue as number, amount, status, subs, unread,
    difficulty: amount >= 700 ? "hard" : amount >= 300 ? "medium" : "easy",
    chain: "stellar",
  })),
  ...REST.map(([status, title, repo, issue, amount], i) => {
    const seq = 174 - i;
    const subs = status === "IN REVIEW" || status === "PAID" ? 1 : 0;
    return {
      seq, code: `BNTY-${seq}`, title, repo, issue, amount, status, subs,
      unread: status === "IN REVIEW",
      difficulty: amount >= 700 ? "hard" : amount >= 300 ? "medium" : "easy",
      chain: "stellar",
    };
  }),
];

const MOCK_TXNS: Txn[] = [
  ["TX-2389", "2026-05-09", "USDC deposit",              1000, "in",  "0x9a4F…c2E1", "CONFIRMED"],
  ["TX-2388", "2026-05-08", "BNTY-183 escrow · audit",   1200, "out", "0x4e21…77c0", "HELD"],
  ["TX-2387", "2026-05-06", "BNTY-179 → @meilin",         180, "out", "Hv8s…kqLp",   "CONFIRMED"],
  ["TX-2386", "2026-05-04", "BNTY-178 → @otis",           280, "out", "TJYe…uA5g",   "CONFIRMED"],
  ["TX-2385", "2026-05-02", "USDC deposit · memo",       2500, "in",  "GAYL…QH2K",   "CONFIRMED"],
  ["TX-2384", "2026-04-29", "BNTY-181 escrow · Rand",     800, "out", "0x77a2…0b13", "HELD"],
  ["TX-2383", "2026-04-27", "BNTY-170 → @minhaj",         240, "out", "TRx9…me4Q",   "CONFIRMED"],
  ["TX-2382", "2026-04-25", "BNTY-176 refund · cancel",   400, "in",  "0x9b1D…42fc", "CONFIRMED"],
  ["TX-2381", "2026-04-23", "USDC deposit",              1500, "in",  "0x3c8E…aa90", "CONFIRMED"],
  ["TX-2380", "2026-04-21", "BNTY-161 → @yusuf",          200, "out", "0x55aE…7d21", "CONFIRMED"],
  ["TX-2379", "2026-04-19", "USDC deposit",               900, "in",  "0x71bC…14aa", "CONFIRMED"],
  ["TX-2378", "2026-04-17", "BNTY-158 → @wei",            330, "out", "GB3T…pP2m",   "CONFIRMED"],
  ["TX-2377", "2026-04-15", "BNTY-180 escrow · i18n",     220, "out", "0x08dF…9b21", "HELD"],
  ["TX-2376", "2026-04-13", "BNTY-155 → @lucia",          470, "out", "TZ9k…Qm4d",   "CONFIRMED"],
  ["TX-2375", "2026-04-11", "USDC deposit",              1200, "in",  "0x2a90…c7e0", "CONFIRMED"],
  ["TX-2374", "2026-04-09", "BNTY-152 → @andre",          150, "out", "Hq2s…Lp8x",   "CONFIRMED"],
  ["TX-2373", "2026-04-07", "BNTY-149 refund · cancel",   260, "in",  "0x5f11…22ab", "CONFIRMED"],
  ["TX-2372", "2026-04-05", "BNTY-177 escrow · rate",     320, "out", "0x9c02…83de", "HELD"],
  ["TX-2371", "2026-04-03", "BNTY-146 → @sana",           540, "out", "GC8L…mN3q",   "CONFIRMED"],
  ["TX-2370", "2026-04-01", "USDC deposit",              2000, "in",  "0x3311…af90", "CONFIRMED"],
  ["TX-2369", "2026-03-30", "BNTY-143 → @tobi",           190, "out", "TJ4m…kR7p",   "CONFIRMED"],
  ["TX-2368", "2026-03-28", "USDC deposit",               750, "in",  "0x77de…0c12", "CONFIRMED"],
].map(([id, date, note, amount, dir, hash, status]) => ({
  id: id as string, date: date as string, note: note as string,
  amount: amount as number, dir: dir as "in" | "out",
  hash: hash as string, status: status as TxnStatus,
}));

// Summary numbers shown in the header + stat grid (match the mockup).
const SUMMARY = {
  org: "acme",
  activeCount: 18,
  escrow: 10870,
  balance: 3390,
  totalBounties: 26,
  activeBounties: 18,
  openBounties: 9,
  inReviewCount: 4,
  paidOut: 1080,
  unreadCount: 10,
};

const TABS: Array<{ key: string; label: string; match: (b: Bounty) => boolean }> = [
  { key: "all",       label: "all",       match: () => true },
  { key: "open",      label: "open",      match: (b) => b.status === "OPEN" },
  { key: "in_review", label: "in review", match: (b) => b.status === "IN REVIEW" },
  { key: "disputed",  label: "disputed",  match: (b) => b.status === "DISPUTED" },
  { key: "paid",      label: "paid",      match: (b) => b.status === "PAID" },
];

const PAGE_SIZE = 10;
const TX_PAGE_SIZE = 10;

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
// Placeholder shown for monetary values when the balance-eye toggle hides them.
const MASK = "••••";

// Live-format a currency input: thousands separators on the integer part, at
// most two decimals, tolerant of partially-typed values ("2000." → "2,000.").
function formatAmountInput(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot !== -1) cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "");
  const [intPart, decPart] = cleaned.split(".");
  const intFmt = intPart ? Number(intPart).toLocaleString("en-US") : "";
  return cleaned.includes(".") ? `${intFmt}.${(decPart || "").slice(0, 2)}` : intFmt;
}

// ─── Page ───────────────────────────────────────────────────────────────────
export const BountiesPage = ({ isMobile }: { isMobile?: boolean }) => {
  const [tab, setTab] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [txPage, setTxPage] = React.useState(1);
  const [balanceHidden, setBalanceHidden] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toppingUp, setToppingUp] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);

  const matcher = TABS.find((t) => t.key === tab)!.match;
  const filtered = MOCK_BOUNTIES.filter(matcher).filter((b) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return b.title.toLowerCase().includes(q) || b.code.toLowerCase().includes(q) || b.repo.toLowerCase().includes(q);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const start = (cur - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  const txPages = Math.max(1, Math.ceil(MOCK_TXNS.length / TX_PAGE_SIZE));
  const txCur = Math.min(txPage, txPages);
  const txStart = (txCur - 1) * TX_PAGE_SIZE;
  const txShown = MOCK_TXNS.slice(txStart, txStart + TX_PAGE_SIZE);

  const selected = selectedId != null ? MOCK_BOUNTIES.find((b) => b.seq === selectedId) || null : null;

  return (
    <div className="page bnty-page" style={{ maxWidth: "none" }}>
      {/* Header */}
      <div className="page-head bnty-head">
        <div>
          <h1 className="page-title">Bounty</h1>
          <div className="page-sub">
            {SUMMARY.activeCount} active · {SUMMARY.org} org
          </div>
        </div>
        <div className="bnty-head-actions">
          <div className="bnty-balance">
            <span className="bnty-balance-label">balance</span>
            <span className="bnty-balance-amt">{balanceHidden ? "••••••" : SUMMARY.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            <span className="bnty-balance-unit">USDC</span>
            <button className="balance-eye" onClick={() => setBalanceHidden((v) => !v)} aria-label="Toggle balance visibility">
              <Icon name={balanceHidden ? "eye-off" : "eye"} size={13} />
            </button>
          </div>
          <button className="btn" onClick={() => setToppingUp(true)}><Icon name="download" size={13} /> Top up</button>
          <button className="btn" onClick={() => setWithdrawing(true)}><Icon name="swap" size={13} /> Withdraw</button>
          <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> Create bounty</button>
        </div>
      </div>

      {/* Stat grid */}
      <div className="stat-grid bnty-stats">
        <Stat label="Account balance" value={money(SUMMARY.balance)} suffix="USDC" color="var(--accent)" hidden={balanceHidden} />
        <Stat label="Total bounties" value={String(SUMMARY.totalBounties)} suffix={`${SUMMARY.activeBounties} active`} />
        <Stat label="Open bounties" value={String(SUMMARY.openBounties)} suffix="accepting work" />
        <Stat label="In review" value={String(SUMMARY.inReviewCount)} suffix="awaiting merge" />
        <Stat label="In escrow" value={money(SUMMARY.escrow)} suffix="held for devs" color="var(--info)" hidden={balanceHidden} />
        <Stat label="Paid out" value={money(SUMMARY.paidOut)} suffix="lifetime" color="var(--green)" hidden={balanceHidden} />
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
              {t.label} <span className="n">· {MOCK_BOUNTIES.filter(t.match).length}</span>
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
              <div className="bnty-empty mono mute">No {tab.replace("_", " ")} bounties.</div>
            ) : (
              shown.map((b) => <BountyRow key={b.seq} b={b} hidden={balanceHidden} onClick={() => setSelectedId(b.seq)} />)
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
              {MOCK_TXNS.length} total
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
            {txShown.map((t) => <TxnRow key={t.id} t={t} hidden={balanceHidden} />)}
          </div>
          <div className="bounty-pager">
            <span className="mono mute" style={{ fontSize: 11 }}>
              Showing {txStart + 1}–{Math.min(txStart + TX_PAGE_SIZE, MOCK_TXNS.length)} of {MOCK_TXNS.length}
            </span>
            <Pager cur={txCur} pages={txPages} onGo={setTxPage} />
          </div>
        </section>
      </div>

      {selected && <BountyDrawer bounty={selected} onClose={() => setSelectedId(null)} />}
      {creating && <CreateBountyModal onClose={() => setCreating(false)} />}
      {toppingUp && <TopUpModal onClose={() => setToppingUp(false)} />}
      {withdrawing && <WithdrawModal onClose={() => setWithdrawing(false)} />}
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

const BountyRow = ({ b, onClick, hidden }: { b: Bounty; onClick: () => void; hidden?: boolean }) => (
  <div className={`bounty-row ${b.unread ? "has-unread" : ""}`} onClick={onClick}>
    <span><i style={{ display: "inline-block", width: 6, height: 6, background: STATUS_DOT[b.status] }} /></span>
    <span className="bounty-id">{b.code}</span>
    <span className="bounty-title" title={b.title}>{b.title}</span>
    <span className="mono mute" style={{ fontSize: 11 }}>{b.repo}#{b.issue}</span>
    <span className="mono" style={{ fontVariantNumeric: "tabular-nums", color: hidden ? "var(--fg-mute)" : undefined }}>{hidden ? MASK : money(b.amount)}</span>
    <span className={`pill ${STATUS_CLS[b.status]}`}><i className="dot" />{b.status}</span>
    <span>
      {b.subs > 0
        ? <span className="subs-badge"><Icon name="git" size={11} /> {b.subs}</span>
        : <span className="mute">–</span>}
    </span>
  </div>
);

const TxnRow = ({ t, hidden }: { t: Txn; hidden?: boolean }) => (
  <div className="txn-row">
    <span className="mono mute" style={{ fontSize: 11 }}>{t.id}</span>
    <span className="mono mute" style={{ fontSize: 11 }}>{t.date}</span>
    <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.note}>{t.note}</span>
    <span className="mono" style={{ fontVariantNumeric: "tabular-nums", color: hidden ? "var(--fg-mute)" : (t.dir === "in" ? "var(--green)" : "var(--danger)") }}>
      {hidden ? MASK : `${t.dir === "in" ? "+" : ""}${money(t.amount)}`}
    </span>
    <span className="txn-hash">
      <a href="#" onClick={(e) => e.preventDefault()}>{t.hash}</a>
      <Icon name="external" size={11} />
    </span>
    <span className={`pill ${t.status === "CONFIRMED" ? "running" : "warn"}`}><i className="dot" />{t.status}</span>
    <span>
      <button className="btn ghost sm"><Icon name="download" size={11} /> PDF</button>
    </span>
  </div>
);

// ─── Drawer ─────────────────────────────────────────────────────────────────
interface Detail {
  amount: number;
  chain: string;
  status: Status;
  difficulty: string;
  applicationsText: string;
  issueRef: string;
  escrowHash: string;
  escrowNote: string;
  description: string;
  acceptance: string[];
  activity: Array<{ time: string; text: React.ReactNode }>;
  delegated: boolean;
}

interface Submission {
  author: string;
  prRef: string;
  ago: string;
  added: number;
  deleted: number;
  files: number;
  acMet: number;
  acTotal: number;
  testsPass: boolean;
  blockers: number;
  note: string;
}

interface Application {
  handle: string;
  isNew: boolean;
  rating: number;
  mergedPrs: number;
  fit: string;
  appliedAgo: string;
}

function detailFor(b: Bounty): Detail {
  if (b.seq === 183) {
    return {
      amount: 1200, chain: "stellar", status: "IN REVIEW", difficulty: "hard",
      applicationsText: "5 developers applied", issueRef: "acme/admin#884",
      escrowHash: "CFA0D694 … 0B2A1A7B",
      escrowNote: "1200 USDC escrowed on Stellar · view on stellar.expert",
      description:
        "Synced from acme/admin#884. On flaky LTE the WebSocket layer enters a tight reconnect loop with no backoff cap, causing handle exhaustion on iOS. Repro on iOS 17.4 / poor signal: socket lifecycle exits → immediate retry → server drops with 429 → repeat at <100ms intervals.",
      acceptance: [
        "Exponential backoff capped at 30s with jitter",
        "Circuit breaker after 5 consecutive 429 responses",
        "Heartbeat interval untouched (out of scope)",
        "Reproduction script in scripts/repro/ws-storm.ts passes",
      ],
      activity: [
        { time: "May 9 · 11:51", text: <>sara opened PR #1147 · <span className="txt-accent">acme/admin</span></> },
        { time: "May 9 · 10:14", text: "devon asked a question · see chat" },
        { time: "May 9 · 09:02", text: "bounty assigned to @devonk" },
        { time: "May 9 · 08:40", text: "escrowed $1200 USDC on stellar" },
        { time: "May 8 · 16:20", text: "bounty published from issue #884" },
      ],
      delegated: true,
    };
  }
  // Generic detail synthesized from the row's own fields.
  const apps = b.status === "OPEN" ? Math.max(1, (b.seq % 5) + 1) : b.status === "CANCELLED" ? 0 : 3;
  return {
    amount: b.amount, chain: b.chain, status: b.status, difficulty: b.difficulty,
    applicationsText: apps === 0 ? "no applications yet" : `${apps} developer${apps === 1 ? "" : "s"} applied`,
    issueRef: `${b.repo}#${b.issue}`,
    escrowHash: `${b.code.replace("-", "")}A1 … ${(b.seq * 7).toString(16).toUpperCase()}F9`,
    escrowNote: `${b.amount} USDC escrowed on Stellar · view on stellar.expert`,
    description:
      `Synced from ${b.repo}#${b.issue}. ${b.title}. Scope is confined to the linked issue; the fix should be covered by tests and leave adjacent behavior untouched.`,
    acceptance: [
      "Change is covered by unit tests",
      "No regression in the existing suite",
      "Follows the repository's lint + format rules",
    ],
    activity: [
      { time: "recent", text: <>bounty published from issue #{b.issue} · <span className="txt-accent">{b.repo}</span></> },
      { time: "earlier", text: `escrowed $${b.amount} USDC on ${b.chain}` },
    ],
    delegated: b.status === "DELEGATED",
  };
}

function submissionsFor(b: Bounty): Submission[] {
  if (b.seq === 183) {
    return [{
      author: "@sarap", prRef: "acme/admin#1147", ago: "18m ago",
      added: 412, deleted: 86, files: 14, acMet: 9, acTotal: 9, testsPass: true, blockers: 0,
      note: "All acceptance criteria met. Tests green.",
    }];
  }
  if (b.subs > 0) {
    return [{
      author: "@devk", prRef: `${b.repo}#${b.issue + 231}`, ago: "2h ago",
      added: 128, deleted: 44, files: 6, acMet: 2, acTotal: 3, testsPass: true, blockers: 1,
      note: "One acceptance criterion still pending; awaiting maintainer input.",
    }];
  }
  return [];
}

function applicationsFor(b: Bounty): Application[] {
  if (b.seq === 183) {
    return [
      { handle: "@devonk", isNew: true,  rating: 4.8, mergedPrs: 210, fit: "high", appliedAgo: "20m ago" },
      { handle: "@sarap",  isNew: true,  rating: 4.6, mergedPrs: 132, fit: "high", appliedAgo: "40m ago" },
      { handle: "@lin",    isNew: false, rating: 4.4, mergedPrs: 77,  fit: "med",  appliedAgo: "3h ago" },
      { handle: "@marco",  isNew: false, rating: 4.1, mergedPrs: 54,  fit: "med",  appliedAgo: "1d ago" },
      { handle: "@ora",    isNew: false, rating: 3.9, mergedPrs: 22,  fit: "low",  appliedAgo: "2d ago" },
    ];
  }
  if (b.seq === 182) {
    return [
      { handle: "@tomasv", isNew: true,  rating: 4.7, mergedPrs: 154, fit: "high", appliedAgo: "30m ago" },
      { handle: "@anyar",  isNew: false, rating: 4.3, mergedPrs: 41,  fit: "med",  appliedAgo: "1d ago" },
    ];
  }
  if (b.status === "OPEN") {
    return [
      { handle: "@rhea",  isNew: true,  rating: 4.6, mergedPrs: 88, fit: "high", appliedAgo: "1h ago" },
      { handle: "@kito",  isNew: false, rating: 4.1, mergedPrs: 23, fit: "med",  appliedAgo: "2d ago" },
    ];
  }
  return [];
}

const BountyDrawer = ({ bounty, onClose }: { bounty: Bounty; onClose: () => void }) => {
  const [tab, setTab] = React.useState<"details" | "submissions" | "applications">("details");
  const detail = React.useMemo(() => detailFor(bounty), [bounty]);
  const submissions = React.useMemo(() => submissionsFor(bounty), [bounty]);
  const applications = React.useMemo(() => applicationsFor(bounty), [bounty]);
  const newApps = applications.filter((a) => a.isNew).length;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
            {tab !== "submissions" && submissions.length > 0 && <span className="tab-count">{submissions.length}</span>}
          </TabBtn>
          <TabBtn active={tab === "applications"} onClick={() => setTab("applications")}>
            Applications
            {tab !== "applications" && newApps > 0 && <span className="tab-count new">{newApps} new</span>}
          </TabBtn>
        </div>

        <div className="drawer-body">
          {tab === "details" && <DetailsTab d={detail} />}
          {tab === "submissions" && <SubmissionsTab subs={submissions} chain={bounty.chain} />}
          {tab === "applications" && <ApplicationsTab apps={applications} />}
        </div>

        {tab === "details" && (
          <div className="drawer-foot">
            <span className="mono mute" style={{ fontSize: 11 }}>
              {detail.delegated ? "Cannot delete · bounty is delegated" : "This bounty can still be cancelled"}
            </span>
            <button className="btn"><Icon name="github" size={13} /> View on GitHub</button>
          </div>
        )}
      </div>
    </div>
  );
};

const TabBtn = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
  <div className={`drawer-tab ${active ? "picked" : ""}`} onClick={onClick}>{children}</div>
);

const DetailsTab = ({ d }: { d: Detail }) => (
  <>
    <div className="kv-grid">
      <div className="kv">
        <div className="kv-k">Amount</div>
        <div className="kv-v"><span style={{ color: "var(--accent)" }}>{money(d.amount)}</span> <span className="mute">USDC</span></div>
      </div>
      <div className="kv">
        <div className="kv-k">Payout chain</div>
        <div className="kv-v"><span className="chain-pip" style={{ background: "var(--purple)" }} /> {d.chain}</div>
      </div>
      <div className="kv">
        <div className="kv-k">Status</div>
        <div className="kv-v"><span className={`pill ${STATUS_CLS[d.status]}`}><i className="dot" />{d.status}</span></div>
      </div>
      <div className="kv">
        <div className="kv-k">Difficulty</div>
        <div className="kv-v">{d.difficulty}</div>
      </div>
      <div className="kv">
        <div className="kv-k">Applications</div>
        <div className="kv-v">{d.applicationsText}</div>
      </div>
      <div className="kv">
        <div className="kv-k">Issue</div>
        <div className="kv-v mono" style={{ fontSize: 12 }}>{d.issueRef} <Icon name="github" size={12} /></div>
      </div>
    </div>

    <div className="drawer-section">
      <div className="drawer-section-head">Escrow transaction</div>
      <div className="mono" style={{ fontSize: 13, color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
        {d.escrowHash} <Icon name="external" size={12} />
      </div>
      <div className="mono mute" style={{ fontSize: 11, marginTop: 6 }}>{d.escrowNote}</div>
    </div>

    <div className="drawer-section">
      <div className="drawer-section-head">Description</div>
      <div className="drawer-prose">{d.description}</div>
    </div>

    <div className="drawer-section">
      <div className="drawer-section-head">Acceptance criteria</div>
      <ul className="ac-list">
        {d.acceptance.map((c, i) => <li key={i} className="ac-item">{c}</li>)}
      </ul>
    </div>

    <div className="drawer-section">
      <div className="drawer-section-head">Activity</div>
      {d.activity.map((a, i) => (
        <div key={i} className="activity-line">
          <span className="mono" style={{ minWidth: 96, color: "var(--fg-mute)" }}>{a.time}</span>
          <span>{a.text}</span>
        </div>
      ))}
    </div>
  </>
);

const SubmissionsTab = ({ subs, chain }: { subs: Submission[]; chain: string }) => {
  if (subs.length === 0) {
    return (
      <div className="drawer-empty">
        <div className="drawer-empty-art"><Icon name="git" size={22} color="var(--fg-mute)" /></div>
        <div className="drawer-empty-title">No submissions yet</div>
        <div className="drawer-empty-sub">When a contributor opens a PR against this bounty it appears here for review.</div>
      </div>
    );
  }
  return (
    <>
      <div className="mono mute" style={{ fontSize: 11, marginBottom: 14 }}>
        {subs.length} PR awaiting review · merging releases escrow on {chain}
      </div>
      <div className="sub-cards">
        {subs.map((s, i) => <SubmissionCard key={i} s={s} />)}
      </div>
    </>
  );
};

const SubmissionCard = ({ s }: { s: Submission }) => {
  const [decided, setDecided] = React.useState<null | "approved" | "rejected">(null);
  return (
    <div className={`sub-card ${s.blockers === 0 && s.acMet === s.acTotal ? "ready" : "changes"}`}>
      <div className="sub-card-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="mono" style={{ fontWeight: 600 }}>{s.author}</span>
          <span className="mono mute" style={{ fontSize: 11 }}>
            <Icon name="git" size={10} /> {s.prRef} · submitted {s.ago}
          </span>
        </div>
      </div>
      <div className="sub-card-stats">
        <div className="sub-stat">
          <span className="sub-stat-label">Diff</span>
          <span className="sub-stat-value">
            <span style={{ color: "var(--accent)" }}>+{s.added}</span>
            {" / "}
            <span style={{ color: "var(--danger)" }}>-{s.deleted}</span>
            {" · "}{s.files} files
          </span>
        </div>
        <div className="sub-stat">
          <span className="sub-stat-label">Checks</span>
          <span className="sub-stat-value" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className={`pill sm ${s.acMet === s.acTotal ? "running" : "warn"}`}><i className="dot" />AC {s.acMet} / {s.acTotal}</span>
            <span className={`pill sm ${s.testsPass ? "green" : "danger"}`}><i className="dot" />{s.testsPass ? "TESTS PASSING" : "TESTS FAILING"}</span>
            <span className={`pill sm ${s.blockers === 0 ? "nit" : "danger"}`}><i className="dot" />BLOCKERS {s.blockers}</span>
          </span>
        </div>
      </div>
      <div className="sub-card-note">{s.note}</div>
      <div className="sub-card-actions">
        {decided ? (
          <span className={`pill ${decided === "approved" ? "green" : "danger"}`}><i className="dot" />{decided === "approved" ? "APPROVED & PAID" : "REJECTED"}</span>
        ) : (
          <>
            <button className="btn sm"><Icon name="github" size={11} /> View PR <Icon name="external" size={10} /></button>
            <button className="btn sm" onClick={() => setDecided("rejected")}>Reject</button>
            <button className="btn sm primary" onClick={() => setDecided("approved")}><Icon name="check" size={11} /> Approve & Pay</button>
          </>
        )}
      </div>
    </div>
  );
};

const ApplicationsTab = ({ apps }: { apps: Application[] }) => {
  const [confirming, setConfirming] = React.useState<Record<string, "reject" | "delegate">>({});
  const [resolved, setResolved] = React.useState<Record<string, "delegated" | "rejected">>({});
  const clearConfirm = (handle: string) => setConfirming((c) => { const n = { ...c }; delete n[handle]; return n; });

  if (apps.length === 0) {
    return (
      <div className="drawer-empty">
        <div className="drawer-empty-art"><Icon name="user" size={22} color="var(--fg-mute)" /></div>
        <div className="drawer-empty-title">No applications yet</div>
        <div className="drawer-empty-sub">Developers who comment <span className="mono">claim</span> on the issue show up here to be delegated.</div>
      </div>
    );
  }

  return (
    <>
      <div className="mono mute" style={{ fontSize: 11, marginBottom: 14 }}>
        {apps.length} application{apps.length === 1 ? "" : "s"} · sorted by status
      </div>
      <div className="app-cards">
        {apps.map((a) => {
          const state = resolved[a.handle];
          return (
            <div key={a.handle} className={`app-card ${a.isNew ? "new" : ""}`}>
              <div className="app-card-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{a.handle}</span>
                    {a.isNew && <span className="tab-count new">NEW</span>}
                  </div>
                  <div className="mono mute" style={{ fontSize: 11, marginTop: 4 }}>
                    ★ {a.rating.toFixed(1)} · {a.mergedPrs} merged PRs · fit {a.fit} · applied {a.appliedAgo}
                  </div>
                </div>
                <div className="flex gap-2">
                  {state ? (
                    <span className={`pill ${state === "delegated" ? "running" : "nit"}`}><i className="dot" />{state === "delegated" ? "DELEGATED" : "REJECTED"}</span>
                  ) : confirming[a.handle] ? null : (
                    <>
                      <button className="btn sm" onClick={() => setConfirming((c) => ({ ...c, [a.handle]: "reject" }))}>Reject</button>
                      <button className="btn sm primary" onClick={() => setConfirming((c) => ({ ...c, [a.handle]: "delegate" }))}>Delegate</button>
                    </>
                  )}
                </div>
              </div>
              {confirming[a.handle] && !state && (
                <div className={`app-confirm ${confirming[a.handle]}`}>
                  {confirming[a.handle] === "reject" && (
                    <span className="app-confirm-icon"><Icon name="warn" size={15} /></span>
                  )}
                  <div className="app-confirm-msg">
                    {confirming[a.handle] === "reject"
                      ? "Reject this application? This can't be undone."
                      : `Delegate this bounty to ${a.handle}? Every other application on this bounty will be automatically rejected.`}
                  </div>
                  <div className="app-confirm-actions">
                    <button className="btn sm ghost" onClick={() => clearConfirm(a.handle)}>Cancel</button>
                    {confirming[a.handle] === "reject" ? (
                      <button
                        className="btn sm app-confirm-go reject"
                        onClick={() => { setResolved((r) => ({ ...r, [a.handle]: "rejected" })); clearConfirm(a.handle); }}
                      >
                        <Icon name="x" size={11} /> Confirm reject
                      </button>
                    ) : (
                      <button
                        className="btn sm app-confirm-go delegate"
                        onClick={() => { setResolved((r) => ({ ...r, [a.handle]: "delegated" })); clearConfirm(a.handle); }}
                      >
                        <Icon name="check" size={11} /> Confirm delegate
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

// ─── Top-up modal ───────────────────────────────────────────────────────────
const STELLAR_WALLET = "GDEVASIGN7XQK2M4RJ5H8ZP3WYVN6TQBC9FLA0DUS1E2R3T4Y5U6I7O";
const AVAILABLE = "3,390.00";

// Deterministic decorative QR — three finder patterns + a stable module field
// derived from the address. A visual placeholder for the mock wallet (not a
// scannable code; wire a QR library when real deposit addresses land).
const QrCode = ({ text, n = 27 }: { text: string; n?: number }) => {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { s ^= text.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const zones = [[0, 0], [0, n - 7], [n - 7, 0]];
  const finderModule = (r: number, c: number): boolean | null => {
    for (const [zr, zc] of zones) {
      if (r >= zr && r < zr + 7 && c >= zc && c < zc + 7) {
        const rr = r - zr, cc = c - zc;
        return rr === 0 || rr === 6 || cc === 0 || cc === 6 || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
      }
    }
    return null;
  };
  const nearFinder = (r: number, c: number) => zones.some(([zr, zc]) => r >= zr - 1 && r < zr + 8 && c >= zc - 1 && c < zc + 8);
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const fm = finderModule(r, c);
    const on = fm !== null ? fm : nearFinder(r, c) ? false : rand() > 0.52;
    if (on) rects.push(<rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} />);
  }
  return (
    <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} shapeRendering="crispEdges" fill="#0a0b0d">{rects}</svg>
  );
};

const TopUpModal = ({ onClose }: { onClose: () => void }) => {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    try { navigator.clipboard?.writeText(STELLAR_WALLET); } catch { /* clipboard unavailable */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>

        <div className="cb-modal-head">
          <div className="cb-eyebrow">Top up</div>
          <h2 className="cb-modal-title">Add funds to your wallet</h2>
          <div className="cb-modal-sub">
            Scan the code or copy the address to deposit USDC into your DevAsign escrow wallet. Funds appear in your balance once Stellar confirms the transfer.
          </div>
        </div>

        <div className="tu-body">
          <div className="tu-qr"><QrCode text={STELLAR_WALLET} /></div>
          <div className="tu-side">
            <div>
              <label className="label">Stellar wallet address</label>
              <div className="tu-address">
                <span className="mono">{STELLAR_WALLET}</span>
                <button className="cb-copy" onClick={copy} aria-label="Copy address"><Icon name={copied ? "check" : "copy"} size={13} /></button>
              </div>
            </div>
            <div className="tu-chain"><span className="chain-pip" style={{ background: "var(--purple)" }} /> Stellar network · USDC</div>
          </div>
        </div>

        <div className="tu-notice">
          <Icon name="warn" size={15} />
          <span>Only send <b>USDC</b> on the <b>Stellar</b> network to this address. Sending any other asset, or using a different chain, will result in permanent loss of funds.</span>
        </div>

        <div className="cb-modal-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={copy}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy address"}</button>
        </div>
      </div>
    </div>
  );
};

// ─── Withdraw modal (2 steps: details → email verification) ──────────────────
const WithdrawModal = ({ onClose }: { onClose: () => void }) => {
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [amount, setAmount] = React.useState("");
  const [wallet, setWallet] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [code, setCode] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal cb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>

        <div className="cb-modal-head">
          <div className="cb-eyebrow">Withdraw</div>
          <h2 className="cb-modal-title">Withdraw USDC</h2>
          <div className="cb-modal-sub">Send USDC from your DevAsign balance to an external Stellar wallet.</div>
        </div>

        <div className="wd-steps">
          <div className={`wd-step ${step >= 1 ? "active" : ""} ${step > 1 ? "done" : ""}`}>
            <span className="wd-step-n">{step > 1 ? <Icon name="check" size={11} /> : "1"}</span> Details
          </div>
          <div className="wd-step-bar" />
          <div className={`wd-step ${step >= 2 ? "active" : ""} ${step > 2 ? "done" : ""}`}>
            <span className="wd-step-n">{step > 2 ? <Icon name="check" size={11} /> : "2"}</span> Verify
          </div>
        </div>

        <div className="wd-body">
          {step === 1 && (
            <>
              <div className="wd-field">
                <label className="label">Amount (USDC)</label>
                <input className="input" value={amount} onChange={(e) => setAmount(formatAmountInput(e.target.value))} placeholder="0.00" inputMode="decimal" />
                <div className="wd-hint">Available: {AVAILABLE} USDC</div>
              </div>
              <div className="wd-field">
                <label className="label">Destination wallet</label>
                <input className="input" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="G… Stellar address" style={{ fontFamily: "var(--mono)" }} />
              </div>
              <div className="wd-field">
                <label className="label">Memo (optional)</label>
                <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. exchange deposit id" style={{ fontFamily: "var(--mono)" }} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="wd-verify">
                <div className="wd-verify-icon"><Icon name="bell" size={20} /></div>
                <div className="wd-verify-title">Check your email</div>
                <div className="wd-verify-sub">We sent a 6-digit verification code to <b>bethel@devasign.org</b>. Enter it below to confirm this withdrawal.</div>
              </div>
              <div className="wd-field">
                <label className="label">Verification code</label>
                <input className="input wd-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" inputMode="numeric" />
                <div className="wd-hint">Didn't get it? <a onClick={(e) => e.preventDefault()}>Resend code</a></div>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="wd-success">
              <div className="wd-success-icon"><Icon name="check" size={22} /></div>
              <div className="wd-success-title">Withdrawal submitted</div>
              <div className="wd-success-sub">
                {amount ? `${amount} USDC` : "Your USDC"} is on its way to {wallet ? <span className="mono">{wallet.slice(0, 10)}…</span> : "your wallet"}. It typically settles on Stellar within a minute.
              </div>
            </div>
          )}
        </div>

        <div className="cb-modal-foot">
          {step === 1 && (
            <>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!wallet.trim()} onClick={() => setStep(2)}>Continue <Icon name="chevron-r" size={12} /></button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={code.length < 6} onClick={() => setStep(3)}><Icon name="check" size={13} /> Withdraw</button>
            </>
          )}
          {step === 3 && <button className="btn primary" onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
};
