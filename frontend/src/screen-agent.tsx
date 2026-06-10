// @ts-nocheck
// Agent page — parallel PR reviews, switcher, log + terminal, goal drawer
import React from "react";
import { Icon } from "./icons";
import { api } from "./api";
import { pushRecent } from "./recent-reviews";
import { useAuth } from "./auth-context";

const PR_REVIEWS = [
{
  id: 482, repo: "acme/pay", title: "Multi-chain USDC withdraw",
  branch: "feat/usdc-withdraw-multichain",
  diff: { add: 247, del: 38, files: 9 },
  author: "@maya", model: "sonnet-4.5",
  status: "running", progress: 0.62, stage: "diff.analyze",
  issueId: "ENG-1284",
  eta: "12s left",
  blockers: 2, nits: 4, met: 7, total: 9,
  goal: {
    title: "Multi-chain USDC withdraw",
    ticket: { id: "ENG-1284", url: "linear://ENG-1284", source: "Linear",
      summary: "Allow users to withdraw USDC across all supported chains. User selects chain → amount → confirms in modal → success toast.",
      assignee: "@maya", reporter: "@dre" },
    loom: { url: "loom.com/share/8f2a4cd1", duration: "0:36",
      transcript: "Maya walks through the desired UX: chain dropdown appears first, then amount input enables only after a chain is selected. Confirm modal must show network fees. Success toast persists 4s.",
      frames: 4,
      keyMoments: [
      { t: "0:04", note: "Chain dropdown appears BEFORE amount input" },
      { t: "0:12", note: "Amount field disabled until chain picked" },
      { t: "0:21", note: 'Confirm modal copy: "Confirm withdrawal"' },
      { t: "0:29", note: "Toast says “Withdrawal sent · check email”" }]
    },
    images: [
    { name: "Withdraw / 04 — figma frame", strings: 14, spec: "spinner inside CTA while pending" },
    { name: "Withdraw / 05 — error state", strings: 6, spec: "inline error red #FF5A5F" }],

    docs: [{ path: "docs/usdc.md", sections: 3 }],
    acceptance: [
    { id: 1, text: "Chain dropdown lists all supported networks", met: true },
    { id: 2, text: "Amount field disabled until chain is selected", met: true },
    { id: 3, text: "Confirm modal displays network fee in USD + native", met: true },
    { id: 4, text: "Invalid chain id falls back to default + toast", met: false, note: "Blocker — no validation in WithdrawForm.tsx:142" },
    { id: 5, text: "Submit disabled while wallet check in flight", met: false, note: "Nit — race in useUSDC.ts:88" },
    { id: 6, text: "Success toast persists 4s", met: true },
    { id: 7, text: "Failure toast offers retry CTA", met: true },
    { id: 8, text: "Telemetry event withdraw.confirm fired", met: true },
    { id: 9, text: "Locale-aware decimal formatting", met: true }],

    constraints: [
    "USDC only — reject other tokens",
    "Round-trip latency budget < 1.2s on success path",
    "Chain list pulled from /api/chains, not hardcoded"]

  }
},
{
  id: 1142, repo: "acme/admin", title: "Role-based access for orgs",
  branch: "feat/rbac-orgs",
  diff: { add: 412, del: 84, files: 14 },
  author: "@kev", model: "opus-4.1",
  status: "running", progress: 0.34, stage: "docs.read",
  issueId: "SEC-204",
  eta: "1m 40s left",
  blockers: 0, nits: 2, met: 11, total: 14
},
{
  id: 479, repo: "acme/pay", title: "Stellar deposit memo parsing",
  branch: "fix/stellar-memo",
  diff: { add: 38, del: 12, files: 2 },
  author: "@sara", model: "sonnet-4.5",
  status: "queued", progress: 0, stage: "queued",
  issueId: "ENG-1255",
  eta: "queued · #2",
  blockers: 0, nits: 0, met: 0, total: 5
},
{
  id: 88, repo: "acme/mobile", title: "Receipt PDF download",
  branch: "feat/receipt-pdf",
  diff: { add: 184, del: 9, files: 5 },
  author: "@otis", model: "gemini-2.5",
  status: "review_ready", progress: 1, stage: "summary",
  issueId: "ENG-1271",
  eta: "12m ago",
  blockers: 0, nits: 3, met: 8, total: 8
},
{
  id: 1139, repo: "acme/admin", title: "Refactor dashboard charts",
  branch: "chore/charts-refactor",
  diff: { add: 612, del: 588, files: 22 },
  author: "@meilin", model: "sonnet-4.5",
  status: "approved", progress: 1, stage: "summary",
  issueId: "ENG-1240",
  eta: "5h ago",
  blockers: 0, nits: 0, met: 6, total: 6
},
{
  id: 411, repo: "acme/infra", title: "Migrate Postgres extension to RDS",
  branch: "infra/pg-rds",
  diff: { add: 92, del: 4, files: 3 },
  author: "@devonk", model: "opus-4.1",
  status: "blocked", progress: 1, stage: "summary",
  issueId: "INF-88",
  eta: "32m ago",
  blockers: 3, nits: 1, met: 4, total: 8
}];


// (live counts come from props now)

const STATUS_PILL = {
  running: { cls: "info", label: "running", dot: true, pulse: true },
  queued: { cls: "", label: "queued", dot: true, pulse: false },
  review_ready: { cls: "warn", label: "review ready", dot: true, pulse: false },
  approved: { cls: "ok", label: "approved", dot: true, pulse: false },
  blocked: { cls: "danger", label: "blocked", dot: true, pulse: false }
};

// Per-PR event templates
const EVENTS_BY_PR = {
  482: [
  { t: "12:04:18", action: "goal.ingest", target: <>linear://<span className="kw">ENG-1284</span></>,
    icon: "linear", flavor: "info",
    detail: <>Pulled ticket, 9 acceptance criteria, labels, attached files.</>,
    tool: { name: "fetch_linear_ticket", out: 'title: "Multi-chain USDC withdraw"\nstatus: in_review\nassignee: @maya' } },
  { t: "12:04:21", action: "loom.transcribe", target: <>loom.com/<span className="str">share/8f2a…36s</span></>,
    icon: "loom", flavor: "purple",
    detail: <>Maya demos the desired UX: chain dropdown → confirm modal → success toast.</>,
    tool: { name: "analyze_loom", out: '36.4s · 4 key frames · transcript: 218 tokens\ncta_copy: "Confirm withdrawal"\nintent: chain selection before amount' } },
  { t: "12:04:24", action: "image.ocr", target: <>figma <span className="str">"Withdraw / 04"</span></>,
    icon: "image", flavor: "warn",
    detail: <>Two screenshots OCR'd — copy strings, button placement, loading-state spec extracted.</>,
    tool: { name: "ocr_screenshots", out: 'frames: 2\nstrings_extracted: 14\nspec: "spinner inside CTA while pending"' } },
  { t: "12:04:28", action: "docs.read", target: <>acme/pay/<span className="kw">docs/usdc.md</span></>,
    icon: "doc", flavor: "info",
    detail: <>Cross-referenced supported chains and decimal handling.</>,
    tool: { name: "read_docs", out: 'matched: 3 sections\nchains_supported: [stellar, solana, base, polygon, tron, arbitrum]' } },
  { t: "12:04:34", action: "pr.fetch", target: <>acme/pay#<span className="kw">482</span></>,
    icon: "git", flavor: "info",
    detail: <>+247 / −38 across 9 files. Branch <span className="dim">feat/usdc-withdraw-multichain</span>.</>,
    tool: { name: "get_pr_diff", out: 'files: 9\nadditions: 247\ndeletions: 38\nbase: main · head: feat/usdc-withdraw-multichain' } },
  { t: "12:04:41", action: "diff.analyze", target: <>9 files <span className="dim">· sonnet-4.5</span></>,
    icon: "brain", flavor: "active",
    detail: <>Reasoning over diff vs. goal context. Checking acceptance criteria 1-by-1.</>,
    tool: { name: "review_diff", out: 'criteria_total: 9\ncriteria_met: 7\nblockers_found: 2\nnits: 4' } },
  { t: "12:04:52", action: "comment.post", target: <>WithdrawForm.tsx:<span className="kw">142</span></>,
    icon: "warn", flavor: "danger",
    detail: <>Posted blocker inline on PR #482.</>,
    inline: { sev: "danger", title: "Blocker · chain id not validated",
      body: 'Goal frame 3 shows chain mismatch → toast. Here the chainId is read from URL without `isSupportedChain()` guard.' } },
  { t: "12:04:54", action: "comment.post", target: <>useUSDC.ts:<span className="kw">88</span></>,
    icon: "warn", flavor: "warn",
    detail: <>Posted nit inline on PR #482.</>,
    inline: { sev: "warn", title: "Nit · race in wallet check",
      body: '`hasFundedWallet()` resolves *after* `submitTransfer()` fires. Acceptance #5 requires the disabled state until checked.' } },
  { t: "12:04:58", action: "review.summary", target: <>PR <span className="dim">+ slack #pay-eng</span></>,
    icon: "check", flavor: "active",
    detail: <>7 / 9 acceptance met · 2 blockers · 4 nits · 18.4k in / 3.1k out.</> }],

  1142: [
  { t: "12:08:02", action: "goal.ingest", target: <>linear://<span className="kw">SEC-204</span></>,
    icon: "linear", flavor: "info",
    detail: <>Pulled RBAC ticket — 14 acceptance criteria, 2 attached threat-model docs.</>,
    tool: { name: "fetch_linear_ticket", out: 'title: "Role-based access for orgs"\npriority: high' } },
  { t: "12:08:05", action: "docs.read", target: <>acme/admin/<span className="kw">docs/rbac.md</span></>,
    icon: "doc", flavor: "info",
    detail: <>Reading role hierarchy spec + audit-log requirements.</>,
    tool: { name: "read_docs", out: 'matched: 6 sections\nroles: [owner, admin, member, viewer, billing]' } },
  { t: "12:08:11", action: "pr.fetch", target: <>acme/admin#<span className="kw">1142</span></>,
    icon: "git", flavor: "info",
    detail: <>+412 / −84 across 14 files.</>,
    tool: { name: "get_pr_diff", out: 'files: 14\nadditions: 412\ndeletions: 84' } },
  { t: "12:08:18", action: "docs.read", target: <>3 internal threat-model docs</>,
    icon: "doc", flavor: "active",
    detail: <>Cross-referencing permission boundaries.</> }],

  479: [
  { t: "—", action: "queued", target: <>position #2 in queue</>,
    icon: "dot", flavor: "",
    detail: <>Waiting for capacity. Estimated start in 24s.</> }],

  88: [
  { t: "11:51:02", action: "goal.ingest", target: <>linear://<span className="kw">ENG-1271</span></>,
    icon: "linear", flavor: "info", detail: <>Pulled ticket and 1 attached design frame.</>,
    tool: { name: "fetch_linear_ticket", out: 'title: "Receipt PDF download"' } },
  { t: "11:51:08", action: "pr.fetch", target: <>acme/mobile#<span className="kw">88</span></>,
    icon: "git", flavor: "info", detail: <>+184 / −9 across 5 files.</> },
  { t: "11:51:22", action: "diff.analyze", target: <>5 files</>,
    icon: "brain", flavor: "active", detail: <>All 8 criteria met. 3 minor nits flagged.</> },
  { t: "11:51:34", action: "comment.post", target: <>ReceiptView.swift:<span className="kw">62</span></>,
    icon: "warn", flavor: "warn", detail: <>Posted 3 nits inline.</>,
    inline: { sev: "warn", title: "Nit · PDF margin inconsistency",
      body: "Top margin 24pt vs spec 20pt. Visually fine but breaks the established receipt grid." } },
  { t: "11:51:41", action: "review.summary", target: <>review ready · awaiting human</>,
    icon: "check", flavor: "warn", detail: <>8 / 8 acceptance met · 3 nits · review needs human approval.</> }],

  1139: [
  { t: "07:14:02", action: "goal.ingest", target: <>linear://<span className="kw">ENG-1240</span></>,
    icon: "linear", flavor: "info", detail: <>Refactor — no functional change expected.</> },
  { t: "07:14:09", action: "pr.fetch", target: <>acme/admin#<span className="kw">1139</span></>,
    icon: "git", flavor: "info", detail: <>+612 / −588 across 22 files. Net +24 lines.</> },
  { t: "07:14:31", action: "diff.analyze", target: <>22 files</>,
    icon: "brain", flavor: "active", detail: <>Behavior preserved per snapshot tests. No regressions detected.</> },
  { t: "07:14:48", action: "review.summary", target: <>approved · auto-merged to main</>,
    icon: "check", flavor: "active", detail: <>6 / 6 criteria met · 0 issues. Approval posted.</> }],

  411: [
  { t: "11:32:08", action: "goal.ingest", target: <>linear://<span className="kw">INF-88</span></>,
    icon: "linear", flavor: "info", detail: <>Postgres extension migration to RDS.</> },
  { t: "11:32:14", action: "pr.fetch", target: <>acme/infra#<span className="kw">411</span></>,
    icon: "git", flavor: "info", detail: <>+92 / −4 across 3 files.</> },
  { t: "11:32:28", action: "diff.analyze", target: <>3 files</>,
    icon: "brain", flavor: "active", detail: <>3 hard blockers identified — extension not allow-listed on RDS.</> },
  { t: "11:32:36", action: "comment.post", target: <>migrations/0094.sql:<span className="kw">12</span></>,
    icon: "warn", flavor: "danger", detail: <>Posted blocker inline.</>,
    inline: { sev: "danger", title: "Blocker · pg_uuidv7 not allow-listed on RDS",
      body: "RDS instance class db.t3.medium does not support pg_uuidv7. Migrate to gen_random_uuid() or request allow-list via infra-ops." } },
  { t: "11:32:52", action: "review.summary", target: <>blocked · 3 issues</>,
    icon: "warn", flavor: "danger", detail: <>4 / 8 criteria met · 3 blockers · 1 nit.</> }]

};

// Per-PR terminal output
const TERMINAL_BY_PR = {
  482: [
  { c: "comment", txt: "# devasign · acme/pay#482 · sonnet-4.5" },
  { c: "cmd", txt: "$ devasign review --pr 482" },
  { c: "ok", txt: "  ✓ goal context loaded (1 ticket · 1 loom · 2 frames · 3 docs)" },
  { c: "ok", txt: "  ✓ 9 files · +247 / −38" },
  { c: "dim", txt: "  ▸ reviewing with Claude Sonnet 4.5 …" },
  { c: "", txt: "" },
  { c: "diff-meta", txt: "diff --git a/src/withdraw/WithdrawForm.tsx" },
  { c: "diff-meta", txt: "@@ -138,4 +138,8 @@" },
  { c: "dim", txt: "   const chainId = useSearchParam('chain');" },
  { c: "diff-add", txt: "+  const onSubmit = async () => {" },
  { c: "diff-add", txt: "+    await transfer({ chainId, amount });" },
  { c: "diff-add", txt: "+  };" },
  { c: "", txt: "" },
  { c: "danger", txt: "  ✗ blocker · WithdrawForm.tsx:142" },
  { c: "dim", txt: "    chain id never validated against supported list" },
  { c: "warn", txt: "  ⚠ nit · useUSDC.ts:88" },
  { c: "dim", txt: "    hasFundedWallet() resolves AFTER submitTransfer()" },
  { c: "", txt: "" },
  { c: "ok", txt: "  ✓ posted 4 inline comments to github.com/acme/pay/pull/482" },
  { c: "comment", txt: "# summary" },
  { c: "ok", txt: "  acceptance ── 7 / 9 met" },
  { c: "danger", txt: "  blockers   ── 2" },
  { c: "warn", txt: "  nits       ── 4" },
  { c: "prompt", txt: "›", cursor: true }],

  1142: [
  { c: "comment", txt: "# devasign · acme/admin#1142 · opus-4.1" },
  { c: "cmd", txt: "$ devasign review --pr 1142" },
  { c: "ok", txt: "  ✓ goal context loaded (1 ticket · 3 docs)" },
  { c: "ok", txt: "  ✓ 14 files · +412 / −84" },
  { c: "dim", txt: "  ▸ reasoning about permission boundaries…" },
  { c: "dim", txt: "  ▸ cross-checking against threat model docs…" },
  { c: "prompt", txt: "›", cursor: true }],

  479: [
  { c: "comment", txt: "# devasign · acme/pay#479 · queued" },
  { c: "dim", txt: "  ▸ waiting for capacity · #2 in queue" },
  { c: "dim", txt: "  ▸ goal context preloaded" },
  { c: "prompt", txt: "›", cursor: true }],

  88: [
  { c: "comment", txt: "# devasign · acme/mobile#88 · gemini-2.5" },
  { c: "cmd", txt: "$ devasign review --pr 88" },
  { c: "ok", txt: "  ✓ 5 files · +184 / −9" },
  { c: "ok", txt: "  ✓ 8 / 8 acceptance met" },
  { c: "warn", txt: "  ⚠ 3 nits · ReceiptView.swift:62, 71, 88" },
  { c: "ok", txt: "  ✓ posted 3 inline comments" },
  { c: "warn", txt: "  → review ready · awaiting human approval" },
  { c: "prompt", txt: "›" }],

  1139: [
  { c: "comment", txt: "# devasign · acme/admin#1139 · sonnet-4.5" },
  { c: "cmd", txt: "$ devasign review --pr 1139" },
  { c: "ok", txt: "  ✓ 22 files · +612 / −588 (net +24)" },
  { c: "ok", txt: "  ✓ behavior preserved per snapshot tests" },
  { c: "ok", txt: "  ✓ 6 / 6 criteria met · 0 issues" },
  { c: "ok", txt: "  ✓ approval posted · auto-merged to main" },
  { c: "prompt", txt: "›" }],

  411: [
  { c: "comment", txt: "# devasign · acme/infra#411 · opus-4.1" },
  { c: "cmd", txt: "$ devasign review --pr 411" },
  { c: "ok", txt: "  ✓ 3 files · +92 / −4" },
  { c: "danger", txt: "  ✗ blocker · pg_uuidv7 not allow-listed on RDS" },
  { c: "danger", txt: "  ✗ blocker · migration not idempotent" },
  { c: "danger", txt: "  ✗ blocker · no rollback path" },
  { c: "warn", txt: "  ⚠ nit · missing migration comment header" },
  { c: "dim", txt: "  4 / 8 criteria met" },
  { c: "prompt", txt: "›" }]

};

// ────────────────────────────────────────────────────────────────────────────
// Repo filter (sits between stats and the queue)
// ────────────────────────────────────────────────────────────────────────────
const RepoFilterBar = ({ value, onChange, options, query, onQuery }) => {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const t = setTimeout(() => document.addEventListener("click", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const totalPRs = options.reduce((s, o) => s + o.count, 0);
  const current = value === "all" ? null : options.find((o) => o.label === value);
  const label = current ? current.label.split("/").pop() : "All repositories";
  const meta = current ? `${current.count} PR${current.count === 1 ? "" : "s"}` : `${options.length} repo${options.length === 1 ? "" : "s"} · ${totalPRs} PR${totalPRs === 1 ? "" : "s"}`;
  return (
    <div className="repo-filter-bar">
      <span className="mute mono" style={{ fontSize: 11 }}>Filter</span>
      <div className="mdl-dd" style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
        <button
          className="mdl-dd-trigger"
          onClick={() => setOpen((o) => !o)}
          title="Filter the review queue by repository"
        >
          <Icon name="filter" size={11} />
          <span className="mono" style={{ fontSize: 12 }}>{label}</span>
          <Icon name="chevron-d" size={11} color="var(--fg-mute)" />
        </button>
        {open && (
          <div className="mdl-menu" style={{ minWidth: 220 }}>
            <button
              className={`mdl-menu-item ${value === "all" ? "picked" : ""}`}
              onClick={() => { onChange("all"); setOpen(false); }}
            >
              <div className="mdl-menu-name">
                <span className="mono" style={{ fontSize: 12 }}>All repositories</span>
                <span className="mute mono mdl-menu-meta">{options.length} repo{options.length === 1 ? "" : "s"} · {totalPRs} PR{totalPRs === 1 ? "" : "s"}</span>
              </div>
              {value === "all" && <Icon name="check" size={11} color="var(--accent)" />}
            </button>
            {options.length === 0 && (
              <div className="mute mono" style={{ padding: 10, fontSize: 11, textAlign: "center" }}>
                No repositories connected yet.
              </div>
            )}
            {options.map((r) => (
              <button
                key={r.label}
                className={`mdl-menu-item ${value === r.label ? "picked" : ""}`}
                onClick={() => { onChange(r.label); setOpen(false); }}
              >
                <div className="mdl-menu-name">
                  <span className="mono" style={{ fontSize: 12 }}>{r.label}</span>
                  <span className="mute mono mdl-menu-meta">
                    {r.count === 0 ? "no open PRs" : `${r.count} PR${r.count === 1 ? "" : "s"}`}
                  </span>
                </div>
                {value === r.label && <Icon name="check" size={11} color="var(--accent)" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="repo-filter-search">
        <Icon name="search" size={11} color="var(--fg-mute)" />
        <input
          type="search"
          value={query || ""}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search PRs by title, repo, or number"
          aria-label="Search the review queue"
        />
        {query && (
          <button
            className="icon-btn"
            title="Clear search"
            onClick={() => onQuery("")}
          >
            <Icon name="x" size={10} />
          </button>
        )}
      </div>
      <span className="mute mono" style={{ fontSize: 11, marginLeft: "auto" }}>{meta}</span>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// PR queue (left rail)
// ────────────────────────────────────────────────────────────────────────────
const PRQueue = ({ pickedId, onPick, reviews = PR_REVIEWS, workspace = "—", onSync, syncing }) => {
  const active = reviews.filter((p) => p.status === "running").length;
  const queued = reviews.filter((p) => p.status === "queued").length;
  return (
<div className="pr-queue">
    <div className="pr-queue-head">
      <div className="flex justify-between items-center">
        <h3 className="card-title">Review queue</h3>
        <div className="flex gap-2 items-center">
          <span className="pill running"><i className="dot pulse"></i> {active} running</span>
          {onSync && (
            <button
              className="btn sm ghost"
              title="Re-pull open PRs from connected repos"
              onClick={onSync}
              disabled={syncing}
            >
              <Icon name="spark" size={11} /> {syncing ? "…" : "Sync"}
            </button>
          )}
        </div>
      </div>
      <div className="mute mono" style={{ fontSize: 11, marginTop: 6 }}>
        {reviews.length} total · {queued} queued · {workspace}
      </div>
    </div>

    <div className="pr-queue-list">
      {reviews.length === 0 && (
        <div className="mute mono" style={{ padding: 20, fontSize: 12, textAlign: "center" }}>
          {syncing
            ? "Pulling open PRs from your connected repos…"
            : "No open PRs found on connected repos. Click Sync to retry, or open a PR on GitHub."}
        </div>
      )}
      {reviews.map((pr) => {
      const s = STATUS_PILL[pr.status];
      const isPicked = pr.id === pickedId;
      return (
        <div key={pr.id} className={`pr-card ${isPicked ? "picked" : ""}`} onClick={() => onPick(pr.id)}>
            <div className="pr-card-row">
              <span className="mono mute" style={{ fontSize: 11 }}>{pr.repo}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-mute)" }}>#{pr.uiId}</span>
            </div>
            <div className="pr-card-title">{pr.title}</div>
            <div className="pr-card-row" style={{ marginTop: 6 }}>
              <span className={`pill ${s.cls}`}>
                <i className={`dot ${s.pulse ? "pulse" : ""}`}></i> {s.label}
              </span>
              <span className="mono mute" style={{ fontSize: 11 }}>{pr.eta}</span>
            </div>
            {pr.status === "running" &&
          <div className="progress" style={{ marginTop: 8 }}>
                <i style={{ width: `${pr.progress * 100}%` }}></i>
              </div>
          }
          </div>);

    })}
    </div>

    <div className="pr-queue-foot" style={{ display: "none" }}>
    </div>
  </div>);
};


// ────────────────────────────────────────────────────────────────────────────
// Timeline (per-PR)
// ────────────────────────────────────────────────────────────────────────────

// One-click copy of a prompt body. Uses navigator.clipboard with a synchronous
// textarea fallback for environments where clipboard access is blocked.
const CopyPromptBlock = ({ prompt }) => {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        const ta = document.createElement("textarea");
        ta.value = prompt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("[copy-prompt] failed", err);
    }
  }, [prompt]);
  return (
    <div className="copy-prompt-block">
      <div className="copy-prompt-head">
        <span className="copy-prompt-label">Prompt for your AI agent</span>
        <button type="button" className="copy-prompt-btn" onClick={onCopy} title="Copy prompt to clipboard">
          <Icon name={copied ? "check" : "copy"} size={11} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="copy-prompt-pre">{prompt}</pre>
    </div>
  );
};

const FINDING_LABEL = {
  regression: "Regression",
  criticalError: "Critical error",
  security: "Security finding",
  consistency: "Consistency",
  deferral: "Deferred work",
  convention: "DEVASIGN.md",
  docDrift: "DEVASIGN.md — docs outdated",
  suggestion: "Suggested change",
};

const TimelineFor = ({ events, runningStageIdx }) =>
<div className="timeline">
    {events.map((e, i) => {
    const tool = e.tool;
    const isStreaming = e.loading === true || i === runningStageIdx;
    return (
      <div key={i} className="tl-event">
          <div className="tl-time" style={{ width: "64px" }}>{e.t}</div>
          <div className={`tl-icon ${e.flavor || ""} ${isStreaming ? "pulse" : ""}`}>
            <Icon name={e.icon} size={11} />
          </div>
          <div className="tl-body">
            <div className="tl-head">
              <span className="tl-action">{e.action}</span>
              <span className="tl-target">{e.target}</span>
              {isStreaming && <span className="pill info"><i className="dot pulse"></i> running</span>}
            </div>
            <div className="tl-detail">{e.detail}{isStreaming && <span className="cursor"></span>}</div>
            {tool &&
          <div className="tl-tool">
                <div style={{ marginBottom: 4 }}>
                  <span className="key">tool:</span> <span className="val">{tool.name}</span>
                </div>
                {tool.out.split("\n").map((l, j) => {
              const m = l.match(/^([\w_]+):\s*(.*)$/);
              return (
                <div key={j}>
                      {m ?
                  <><span className="key">{m[1]}:</span> <span className="val">{m[2]}</span></> :
                  <span className="val">{l}</span>}
                    </div>);

            })}
              </div>
          }
            {e.inline &&
          <div className={`pr-comment ${e.inline.sev}`}>
                <div className="head">{e.inline.title}</div>
                <div style={{ color: "var(--fg)" }}>{e.inline.body}</div>
              </div>
          }
            {e.finding &&
          <div className={`finding-card sev-${e.finding.severity}`}>
                <div className="finding-head">
                  <span className={`pill ${e.finding.severity === "blocker" ? "danger" : e.finding.severity === "nit" ? "nit" : "warn"}`}>
                    <i className="dot"></i> {e.finding.severity === "blocker" ? "Blocker" : e.finding.severity === "nit" ? "Nit" : "Warn"}
                  </span>
                  <span className="finding-cat">{FINDING_LABEL[e.finding.category] || "Finding"}</span>
                  {e.finding.path && (
                    <span className="mono mute finding-path">{e.finding.path}</span>
                  )}
                </div>
                {e.finding.title && e.finding.title !== e.finding.body && (
                  <div className="finding-title">{e.finding.title}</div>
                )}
                <div className="finding-body">{e.finding.body}</div>
                {e.finding.fixPrompt && <CopyPromptBlock prompt={e.finding.fixPrompt} />}
              </div>
          }
          </div>
        </div>);

  })}
  </div>;


// ────────────────────────────────────────────────────────────────────────────
// Terminal (per-PR)
// ────────────────────────────────────────────────────────────────────────────
const TerminalFor = ({ pr, lines }) =>
<div className="terminal">
    <div className="terminal-head">
      <div className="tt-dots">
        <i className="dot" style={{ background: "#ff5a5f" }}></i>
        <i className="dot" style={{ background: "#f5a524" }}></i>
        <i className="dot" style={{ background: "#ff7a3d" }}></i>
      </div>
      <span className="tt-name">~/{pr.repo.replace("/", "-")} — review #{pr.id}</span>
      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-mute)", fontFamily: "var(--mono)" }}>
        {pr.status === "running" ? <><span className="pulse">●</span> running</> : pr.status}
      </span>
    </div>
    <div className="terminal-body">
      {lines.map((l, i) =>
    <div key={i} className={`t-line t-${l.c}`}>
          {l.txt}
          {l.cursor && <span className="cursor"></span>}
        </div>
    )}
    </div>
  </div>;


// ────────────────────────────────────────────────────────────────────────────
// Goal panel (right column) — same layout as the previous pop-up
// ────────────────────────────────────────────────────────────────────────────
const GoalPanel = ({ pr, live, onDeleteConstraint }) => {
  // Local-only hide set for constraints without a backend attachment id
  // (legacy attachments persisted before we added `id`, or static demo
  // strings). Click → fade out, no network round-trip.
  const [hiddenLocal, setHiddenLocal] = React.useState<Set<string>>(new Set());
  // Mirror set of URLs / content refs whose corresponding entries in
  // "sources analyzed" should also disappear when their constraint is hidden.
  // Backend-delete path adds to this too, so the source row drops in the
  // same render as the constraint — the polling refetch will then reconcile.
  const [hiddenSourceUrls, setHiddenSourceUrls] = React.useState<Set<string>>(new Set());
  const hideLocally = React.useCallback((key: string, urls: Array<string | undefined>) => {
    setHiddenLocal((s) => {
      const next = new Set(s);
      next.add(key);
      return next;
    });
    const liveUrls = urls.filter((u): u is string => typeof u === "string" && u.length > 0);
    if (liveUrls.length > 0) {
      setHiddenSourceUrls((s) => {
        const next = new Set(s);
        for (const u of liveUrls) next.add(u);
        return next;
      });
    }
  }, []);
  const hideSourceUrl = React.useCallback((urls: Array<string | undefined>) => {
    const liveUrls = urls.filter((u): u is string => typeof u === "string" && u.length > 0);
    if (liveUrls.length === 0) return;
    setHiddenSourceUrls((s) => {
      const next = new Set(s);
      for (const u of liveUrls) next.add(u);
      return next;
    });
  }, []);
  // Inline confirmation: the row key currently in "are you sure?" state. Only
  // backend-id constraints enter this — client-side hides for static/legacy
  // rows skip it because they're reversible (page reload restores them).
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPendingDelete(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDelete]);
  // Prefer live data (task.endGoal + review.criteria) when available; fall
  // back to the static `goal` blob for any legacy PRs.
  const liveMode = !!(live && (live.endGoal || (live.criteria && live.criteria.length)));
  const goal =
    liveMode
      ? {
          title: live.title,
          ticket: { id: live.prNumber ? `#${live.prNumber}` : "—", url: "", source: "github", summary: live.endGoal || "(no end-goal synthesised yet)", assignee: "—", reporter: "—" },
          acceptance: live.criteria.map((c, i) => ({ id: i + 1, text: c.text, met: c.met === true, regressed: (live.regressedCriteriaIds || []).includes(c.id), note: c.evidence || undefined })),
          // Constraint rows in live mode carry the attachment id + the URL /
          // contentRef so the X click can match the corresponding source
          // entry in "sources analyzed" and hide it in lockstep.
          constraints: (live.attachments || []).map((a) => ({
            id: a.id as string | undefined,
            kind: a.kind,
            url: a.url,
            contentRef: a.contentRef,
            note: a.note,
            label: `${a.kind} · ${a.url || a.note || a.contentRef || ""}`,
          })),
        }
      : pr?.goal;
  // Source manifest — what the agent actually ingested while synthesising
  // the end goal. Live path uses the structured list extracted from
  // `detail.logs` + `task.attachments`; static demo path projects the old
  // loom/images/docs shape into the same generic descriptor.
  // After the user removes a constraint, also drop the matching source row
  // from this view (matched by URL) until the backend re-render reconciles.
  const rawSources = liveMode ? (live.sources || []) : staticGoalSources(pr?.goal);
  const sources = React.useMemo(() => {
    if (hiddenSourceUrls.size === 0) return rawSources;
    return rawSources.filter((s) => {
      const u = s?.url;
      return !(typeof u === "string" && hiddenSourceUrls.has(u));
    });
  }, [rawSources, hiddenSourceUrls]);

  if (!goal) {
    return (
      <div className="agent-pane">
        <div className="agent-pane-head">
          <div className="flex gap-3 items-center">
            <h3 className="card-title">End-goal</h3>
            <span className="pill"><i className="dot"></i> not synthesized</span>
          </div>
        </div>
        <div className="agent-pane-body" style={{ display: "grid", placeItems: "center", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 280 }}>
            <Icon name="spark" size={20} color="var(--fg-mute)" />
            <div className="mono" style={{ fontSize: 13, marginTop: 10 }}>No goal context for this PR yet</div>
            <div className="mute" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
              Goal is ingested from the linked ticket, Loom, and design frames the moment the review starts.
            </div>
          </div>
        </div>
      </div>);

  }

  const metCount = goal.acceptance.filter((a) => a.met).length;
  // Lead with what needs attention: regressions ("was met, now broken") first,
  // then still-open criteria, then the met ones. Stable sort keeps each group's
  // own order. Mirrors how the GitHub review comment is structured.
  const sortedAcceptance = [...goal.acceptance].sort(
    (a, b) => (a.regressed ? 0 : a.met ? 2 : 1) - (b.regressed ? 0 : b.met ? 2 : 1)
  );

  return (
    <div className="agent-pane">
      <div className="agent-pane-head">
        <div className="flex gap-3 items-center">
          <h3 className="card-title">End-goal</h3>
        </div>
        <div className="flex gap-2 items-center">
          <span className="mono mute" style={{ fontSize: 11 }}>
            {sources.length} source{sources.length === 1 ? "" : "s"}
          </span>
          <button className="btn sm ghost"><Icon name="download" size={11} /></button>
          <button className="btn sm ghost"><Icon name="spark" size={11} /> Re-ingest</button>
        </div>
      </div>

      <div className="agent-pane-body goal-panel-body">
        <h2 className="drawer-title" style={{ fontSize: 16 }}>{goal.title}</h2>
        <div className="flex gap-2 items-center" style={{ marginBottom: 18, flexWrap: "wrap" }}>
          <span className="pill info"><i className="dot"></i> {goal.ticket.id}</span>
          <span className="pill"><i className="dot"></i> {goal.ticket.source}</span>
          <span className="mono mute" style={{ fontSize: 11 }}>assignee {goal.ticket.assignee} · reporter {goal.ticket.reporter}</span>
        </div>

        <div className="drawer-section">
          <div className="drawer-label">summary</div>
          <p style={{ fontSize: 13, color: "var(--fg-dim)", lineHeight: 1.6 }}>{goal.ticket.summary}</p>
        </div>

        <div className="drawer-section">
          <div className="drawer-label">sources analyzed</div>
          {sources.length === 0 && (
            <div className="mute mono" style={{ fontSize: 12, padding: "6px 0" }}>
              {liveMode
                ? "(sources still being ingested…)"
                : "(no sources recorded)"}
            </div>
          )}
          {sources.map((s, i) => {
            const flavorVar =
              s.flavor === "green" ? "var(--green)"
              : s.flavor === "cyan" ? "var(--cyan)"
              : s.flavor === "pink" ? "var(--pink)"
              : s.flavor === "purple" ? "var(--purple)"
              : s.flavor === "warn" ? "var(--warn)"
              : s.flavor === "danger" ? "var(--danger)"
              : s.flavor === "info" ? "var(--info)"
              : s.flavor === "active" ? "var(--accent)"
              : "var(--fg-mute)";
            return (
              <div key={i} className="source-card">
                <div className="source-head">
                  <Icon name={s.icon} size={14} color={flavorVar} />
                  <span className="mono" style={{ fontSize: 12 }}>{s.label}</span>
                  {s.url && (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono mute"
                      style={{ fontSize: 11, textDecoration: "underline" }}
                      title={s.url}
                    >
                      {s.url.length > 40 ? s.url.slice(0, 38) + "…" : s.url}
                    </a>
                  )}
                  {s.unreliable && (
                    <span className="pill warn" style={{ marginLeft: 6 }}>
                      <i className="dot"></i> unreliable
                    </span>
                  )}
                  <span className={`pill ${s.flavor || ""}`} style={{ marginLeft: "auto" }}>
                    <i className="dot"></i> {s.state}
                  </span>
                </div>
                {s.note && (
                  <div className="source-body mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    {s.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="drawer-section">
          <div className="drawer-label">
            acceptance criteria
            <span className="mute mono" style={{ marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
              {metCount} / {goal.acceptance.length} met
            </span>
          </div>
          <div className="ac-list">
            {goal.acceptance.length === 0 &&
            <div className="ac-row" style={{ opacity: 0.85 }}>
                <div className="ac-check"><Icon name="check" size={11} /></div>
                <div>
                  <div style={{ fontSize: 13 }}>No acceptance criteria — reviewed for correctness only.</div>
                  <div className="mute mono" style={{ fontSize: 11, marginTop: 3 }}>
                    Add an end goal on the PR (description, Loom, or screenshot + notes) to enable criteria checks.
                  </div>
                </div>
              </div>
            }
            {sortedAcceptance.map((a) =>
            <div key={a.id} className={`ac-row ${a.regressed ? "regressed" : a.met ? "met" : "unmet"}`}>
                <div className="ac-check">
                  {a.met ? <Icon name="check" size={11} /> : a.regressed ? <Icon name="warn" size={11} /> : <span className="mono">!</span>}
                </div>
                <div>
                  <div style={{ fontSize: 13 }}>{a.text}</div>
                  {a.regressed && <div className="t-warn mono" style={{ fontSize: 11, marginTop: 3 }}>Was met by an earlier commit — broken by a later change</div>}
                  {a.note && <div className="mute mono" style={{ fontSize: 11, marginTop: 3 }}>{a.note}</div>}
                </div>
                <span className="mono mute" style={{ fontSize: 10, justifySelf: "end" }}>AC-{a.id}</span>
              </div>
            )}
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-label">constraints</div>
          <ul className="constraint-list">
            {(() => {
              const rows = goal.constraints.map((c, i) => {
                // Live-mode constraints are { id, label, kind, url, ... };
                // demo/static constraints are bare strings.
                const isObj = c && typeof c === "object" && "label" in c;
                const label: string = isObj ? c.label : c;
                const attId: string | undefined = isObj ? c.id : undefined;
                const url: string | undefined = isObj ? c.url : undefined;
                const contentRef: string | undefined = isObj ? c.contentRef : undefined;
                // Stable per-row key for client-side hide tracking.
                const key = attId || `static:${i}:${label}`;
                return { label, attId, key, url, contentRef };
              }).filter((r) => !hiddenLocal.has(r.key));
              if (rows.length === 0) {
                return (
                  <li className="mute mono" style={{ fontSize: 11, listStyle: "none", padding: 0 }}>
                    No constraints. Drop a Loom, doc link, or note into the message agent to add one.
                  </li>
                );
              }
              return rows.map((r) => {
                const isPending = pendingDelete === r.key;
                return (
                <li
                  key={r.key}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}
                >
                  <span className="mono txt-accent" style={{ paddingTop: 2 }}>▸</span>
                  <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", opacity: isPending ? 0.5 : 1 }}>{r.label}</span>
                  <button
                    className="icon-btn"
                    title="Remove this constraint — re-synthesises the end goal and re-runs the review"
                    aria-label="Remove constraint"
                    onClick={() => setPendingDelete(r.key)}
                    style={{ flex: "0 0 auto", width: 22, height: 22 }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                  {isPending && (
                    <div
                      role="alertdialog"
                      aria-label="Confirm removal"
                      // Spans the whole row so the prompt is unmissable. Uses
                      // the danger-tinted background from the existing
                      // user-confirm sign-out flow for visual continuity.
                      style={{
                        flex: "1 0 100%",
                        marginTop: 6,
                        padding: 10,
                        border: "1px solid color-mix(in oklch, var(--danger) 35%, var(--line))",
                        background: "color-mix(in oklch, var(--danger) 6%, transparent)",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--fg)" }}>
                        Remove this constraint? The agent will re-synthesise the end goal without it and re-run the review.
                      </span>
                      <button
                        className="btn sm ghost"
                        onClick={() => setPendingDelete(null)}
                        autoFocus
                      >Cancel</button>
                      <button
                        className="btn sm danger"
                        onClick={() => {
                          // Source list drops in lockstep regardless of path
                          // — backend-delete also gets durable cleanup via the
                          // video-log scrub server-side. `hideLocally` stays
                          // as a silent fallback for the rare case where a
                          // row somehow lacks an attachment id, so the click
                          // is never a no-op.
                          hideSourceUrl([r.url, r.contentRef]);
                          if (r.attId && onDeleteConstraint) {
                            onDeleteConstraint(r.attId);
                          } else {
                            hideLocally(r.key, [r.url, r.contentRef]);
                          }
                          setPendingDelete(null);
                        }}
                      >
                        <Icon name="x" size={11}/> Remove
                      </button>
                    </div>
                  )}
                </li>
                );
              });
            })()}
          </ul>
        </div>
      </div>
    </div>);

};

// ────────────────────────────────────────────────────────────────────────────
// AgentComposer — rich text input below the review log
//   Detects video links (loom/youtube/vimeo/…), doc links, or plain text and
//   pushes a custom event.
// ────────────────────────────────────────────────────────────────────────────
const VIDEO_PLATFORMS = [
  {
    name: "loom",
    icon: "loom",
    flavor: "purple",
    re: /https?:\/\/(?:www\.)?loom\.com\/share\/[A-Za-z0-9_-]+/i,
    strip: /^https?:\/\/(?:www\.)?loom\.com\//i,
    label: "loom.com/",
  },
  {
    name: "youtube",
    icon: "play",
    flavor: "danger",
    re: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]+(?:\S*)?/i,
    strip: /^https?:\/\/(?:www\.)?(?:youtube\.com\/|youtu\.be\/)/i,
    label: "youtube.com/",
  },
  {
    name: "vimeo",
    icon: "play",
    flavor: "info",
    re: /https?:\/\/(?:www\.)?vimeo\.com\/(?:channels\/[\w-]+\/)?\d+(?:\/[A-Za-z0-9]+)?/i,
    strip: /^https?:\/\/(?:www\.)?vimeo\.com\//i,
    label: "vimeo.com/",
  },
  {
    name: "wistia",
    icon: "play",
    flavor: "info",
    re: /https?:\/\/(?:[a-z0-9-]+\.)?wistia\.(?:com|net)\/medias\/[A-Za-z0-9]+/i,
    strip: /^https?:\/\/(?:[a-z0-9-]+\.)?wistia\.(?:com|net)\//i,
    label: "wistia/",
  },
  {
    name: "twitch",
    icon: "play",
    flavor: "purple",
    re: /https?:\/\/(?:(?:www\.)?twitch\.tv|clips\.twitch\.tv)\/(?:videos\/\d+|\w+\/clip\/[A-Za-z0-9-]+|[A-Za-z0-9-]+)/i,
    strip: /^https?:\/\/(?:www\.)?(?:clips\.)?twitch\.tv\//i,
    label: "twitch.tv/",
  },
];

const matchVideo = (text) => {
  for (const p of VIDEO_PLATFORMS) {
    const m = text.match(p.re);
    if (m) return { platform: p, url: m[0] };
  }
  return null;
};

const URL_RE  = /https?:\/\/[^\s<]+/i;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const nowHMS = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const AgentComposer = ({ onSend, disabled }) => {
  const ref = React.useRef(null);
  const [empty, setEmpty] = React.useState(true);

  const exec = (cmd, val) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    setEmpty(!ref.current?.innerText.trim());
  };

  // Code: wrap only the selected text in <code>. If nothing's selected,
  // insert an empty <pre> block on a new line below the caret — never
  // convert the whole paragraph the caret happens to live in.
  const insertCode = () => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const selectedText = sel.toString();

    if (selectedText.trim()) {
      // Inline wrap of the selection
      const safe = escapeHtml(selectedText);
      document.execCommand("insertHTML", false, `<code>${safe}</code>`);
    } else {
      // No selection — open a fresh code block beneath current line
      document.execCommand(
        "insertHTML",
        false,
        '<pre data-codeblock="1"><br></pre><p><br></p>'
      );
      // Move caret into the new <pre>
      const pre = el.querySelector('pre[data-codeblock="1"]:last-of-type');
      if (pre) {
        pre.removeAttribute("data-codeblock");
        const r = document.createRange();
        r.setStart(pre, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setEmpty(!el.innerText.trim());
  };

  const insertLink = () => {
    const url = prompt("Paste a URL (Loom, doc, or any link):");
    if (!url) return;
    ref.current?.focus();
    const sel = window.getSelection();
    if (sel && sel.toString().trim() === "") {
      document.execCommand("insertHTML", false,
        `<a href="${url}" target="_blank" rel="noopener">${url}</a>&nbsp;`);
    } else {
      document.execCommand("createLink", false, url);
    }
    setEmpty(!ref.current?.innerText.trim());
  };

  const handleSend = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText.trim();
    const html = el.innerHTML.trim();
    if (!text) return;
    const loomMatch = matchVideo(text);
    const urlMatch  = !loomMatch && text.match(URL_RE);
    onSend({ text, html, video: loomMatch || undefined, docUrl: urlMatch?.[0] });
    el.innerHTML = "";
    setEmpty(true);
  };

  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  const onInput = () => setEmpty(!ref.current?.innerText.trim());

  const onPaste = (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (!text) return;
    e.preventDefault();
    if (URL_RE.test(text.trim())) {
      const url = text.trim();
      document.execCommand("insertHTML", false,
        `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    } else {
      document.execCommand("insertText", false, text);
    }
    setEmpty(!ref.current?.innerText.trim());
  };

  const [focused, setFocused] = React.useState(false);

  return (
    <div className={`composer${focused ? " is-focused" : ""}${empty ? "" : " has-content"}`}>
      <div className="composer-head">
        <span className="composer-head-bar"></span>
        <span className="composer-head-label mono">message agent</span>
        <span className="composer-head-sep">·</span>
        <span className="composer-head-target mono">live channel</span>
        <span style={{ flex: 1 }}></span>
        <span className="composer-head-kbd mono">⌘ ↵ send</span>
      </div>
      <div className="composer-toolbar">
        <button className="composer-tool" title="Bold (⌘B)"
                onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}>
          <b>B</b>
        </button>
        <button className="composer-tool" title="Italic (⌘I)"
                onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}>
          <i>I</i>
        </button>
        <button className="composer-tool" title="Code (wraps selection, or opens a block)"
                onMouseDown={(e) => { e.preventDefault(); insertCode(); }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{"</>"}</span>
        </button>
        <span className="composer-sep"></span>
        <button className="composer-tool" title="Insert link (Loom, doc, …)"
                onMouseDown={(e) => { e.preventDefault(); insertLink(); }}>
          <Icon name="link" size={12}/>
        </button>
        <span style={{ flex: 1 }}></span>
        <span className="composer-hint mono">rich text · links auto-detect</span>
      </div>
      <div className="composer-input-wrap">
        <span className="composer-prompt mono" aria-hidden="true">&gt;</span>
        <div
          ref={ref}
          className="composer-input"
          contentEditable
          suppressContentEditableWarning
          data-empty={empty}
          data-placeholder="Type a command, paste a video link (Loom, YouTube, Vimeo…), or drop a doc URL…"
          onInput={onInput}
          onKeyDown={onKey}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        ></div>
      </div>
      <div className="composer-foot">
        <span className="mono mute" style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i className="composer-dot"></i> ready for input
        </span>
        <button
          className="btn sm primary"
          disabled={empty || disabled}
          onClick={handleSend}
        >
          <Icon name="send" size={11}/> Send
        </button>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Live-data mapping helpers
// ────────────────────────────────────────────────────────────────────────────

// Map backend PRReview.status → the UI status taxonomy the existing components
// already render (running / queued / approved / blocked / review_ready).
function mapStatus(s) {
  switch (s) {
    case "reviewing":          return "running";
    case "queued":             return "queued";
    case "passed":             return "approved";
    case "changes_requested":  return "blocked";
    case "errored":            return "blocked";
    default:                   return "queued";
  }
}

const RELATIVE = (ts) => {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// Map a backend ReviewLogEntry into the timeline-event shape the existing
// <TimelineFor> already renders.
function mapLogEntry(entry) {
  const map = {
    ingest:   { icon: "doc",    flavor: "info"   },
    criteria: { icon: "brain",  flavor: "info"   },
    review:   { icon: "git",    flavor: "info"   },
    tool:     { icon: "code",   flavor: "info"   },
    comment:  { icon: "message",flavor: "active" },
    verdict:  { icon: "check",  flavor: "active" },
    error:    { icon: "warn",   flavor: "danger" },
    holistic: { icon: "brain",  flavor: "info"   },
    finding:  { icon: "warn",   flavor: "warn"   },
  };
  let v = map[entry.kind] || { icon: "dot", flavor: "" };
  // Commit pushes and maintainer-comment arrivals both carry kind="ingest"
  // so we don't add new ReviewLogKinds that would drift across the
  // api.ts ↔ types.ts boundary. Pick the icon off the action instead so
  // each one reads correctly in the timeline.
  if (entry.action === "commit.push") v = { icon: "git", flavor: "info" };
  if (entry.action === "comment.received") v = { icon: "message", flavor: "info" };
  // Findings flip to danger-flavored when the agent marked them blocker.
  if (entry.kind === "finding" && entry.meta?.severity === "blocker") {
    v = { icon: "warn", flavor: "danger" };
  }
  // DEVASIGN.md nits are advisory — de-emphasise in the rail (no warn flavour).
  if (entry.kind === "finding" && entry.meta?.severity === "nit") {
    v = { icon: "dot", flavor: "" };
  }
  const d = new Date(entry.at);
  const pad = (n) => String(n).padStart(2, "0");
  const sources = entry.meta?.sources;
  const detailExtra =
    Array.isArray(sources) && sources.length
      ? ` (${sources.join(", ")})`
      : entry.meta?.count
      ? ` · ${entry.meta.count} item(s)`
      : "";
  // Findings carry structured meta (category, severity, path, body, fixPrompt)
  // — surface them via the `finding` slot so <TimelineFor> can render the
  // copyable prompt block next to the issue text.
  const finding = entry.kind === "finding"
    ? {
        category: entry.meta?.category || "suggestion",
        severity:
          entry.meta?.severity === "blocker"
            ? "blocker"
            : entry.meta?.severity === "nit"
            ? "nit"
            : "warn",
        path: typeof entry.meta?.path === "string" ? entry.meta.path : undefined,
        title: typeof entry.meta?.title === "string" ? entry.meta.title : entry.action,
        body: typeof entry.meta?.body === "string" ? entry.meta.body : (entry.detail || ""),
        fixPrompt: typeof entry.meta?.fixPrompt === "string" ? entry.meta.fixPrompt : undefined,
      }
    : undefined;
  return {
    t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    action: entry.action,
    target: entry.target ? <span className="kw">{entry.target}</span> : null,
    icon: v.icon,
    flavor: v.flavor,
    detail: <>{entry.detail || entry.action}{detailExtra}</>,
    finding,
  };
}

// Walk the backend log stream + task attachments and build a structured list
// of everything the agent ingested while synthesising the end goal. The data
// is already on the wire via GET /api/reviews/:id; this just folds it into
// the shape the GoalPanel renders. Returns an empty array when nothing has
// been ingested yet (transient pre-pipeline state).
//
// Source-kind icons/flavors mirror the existing review-log timeline mapping
// so the same source reads the same way in both surfaces.
function extractIngestedSources(logs, attachments = []) {
  const sources = [];
  const ingestLog = (logs || []).find((l) => l.action === "Context ingested");
  if (ingestLog?.meta) {
    const kinds = Array.isArray(ingestLog.meta.sources) ? ingestLog.meta.sources : [];
    const primary = Array.isArray(ingestLog.meta.primaryIssues) ? ingestLog.meta.primaryIssues : [];
    const secondary = Array.isArray(ingestLog.meta.secondaryIssues) ? ingestLog.meta.secondaryIssues : [];
    if (kinds.includes("github_pr")) {
      sources.push({
        kind: "pr",
        icon: "git",
        flavor: "green",
        label: "PR description",
        state: "ingested",
      });
    }
    if (kinds.includes("diff")) {
      sources.push({
        kind: "diff",
        icon: "code",
        flavor: "cyan",
        label: "Unified diff",
        state: "ingested",
      });
    }
    for (const num of primary) {
      sources.push({
        kind: "issue",
        icon: "doc",
        flavor: "warn",
        label: `Issue #${num}`,
        state: "primary",
        note: "closes/fixes-linked — authoritative job-to-be-done",
      });
    }
    for (const num of secondary) {
      sources.push({
        kind: "issue",
        icon: "doc",
        flavor: "info",
        label: `Issue #${num}`,
        state: "secondary",
      });
    }
  }

  // Videos can appear in two log lines: the main ingest summarisation pass
  // and a follow-up pass that summarises videos found in maintainer
  // comments. De-dupe by URL so the same Loom doesn't show twice.
  const videoLogs = (logs || []).filter(
    (l) =>
      (l.action === "Videos summarized by Gemini" ||
        l.action === "Videos in maintainer feedback summarized") &&
      Array.isArray(l.meta?.videos)
  );
  const seenVideoUrls = new Set();
  for (const log of videoLogs) {
    for (const v of log.meta.videos) {
      if (!v?.url || seenVideoUrls.has(v.url)) continue;
      seenVideoUrls.add(v.url);
      const provider = String(v.provider || "video");
      const isLoom = provider.toLowerCase() === "loom";
      sources.push({
        kind: "video",
        icon: isLoom ? "loom" : "play",
        // Loom keeps its purple convention; other providers (YouTube /
        // Vimeo / Wistia / Twitch) get pink so they don't all collapse
        // into the same color when a PR has both.
        flavor: isLoom ? "purple" : "pink",
        label: `${provider.charAt(0).toUpperCase() + provider.slice(1)} video`,
        url: v.url,
        state: v.model ? `transcribed (${v.model})` : "transcribed",
        unreliable: v.unreliable === true,
      });
    }
  }

  const indexLog = (logs || []).find((l) => l.action === "Repo index retrieved");
  if (indexLog?.meta) {
    const touched = Array.isArray(indexLog.meta.touched) ? indexLog.meta.touched.length : 0;
    const dependents = Array.isArray(indexLog.meta.dependents) ? indexLog.meta.dependents.length : 0;
    const sha = typeof indexLog.meta.indexedCommit === "string" ? indexLog.meta.indexedCommit.slice(0, 7) : null;
    sources.push({
      kind: "repoIndex",
      icon: "brain",
      flavor: "cyan",
      label: "Repo index",
      state: "retrieved",
      note: `${touched + dependents} entries · ${touched} touched, ${dependents} dependents${sha ? ` · indexed @ ${sha}` : ""}`,
    });
  }

  for (const a of attachments || []) {
    const kind = String(a?.kind || "link");
    const icon =
      kind === "loom" ? "loom"
      : kind === "figma" ? "image"
      : kind === "image" ? "image"
      : kind === "pdf" ? "doc"
      : kind === "text" ? "doc"
      : "link";
    // Per-kind color so attachments visibly differ from each other and
    // from the ingest sources above. text falls through to the default
    // (muted) so plain-text notes don't shout.
    const flavor =
      kind === "loom" ? "purple"
      : kind === "figma" ? "pink"
      : kind === "image" ? "warn"
      : kind === "pdf" ? "danger"
      : kind === "link" ? "info"
      : "";
    sources.push({
      kind,
      icon,
      flavor,
      label: `${kind.charAt(0).toUpperCase() + kind.slice(1)} attachment`,
      url: a.url || a.contentRef || undefined,
      note: a.note || undefined,
      state: "attached",
    });
  }

  return sources;
}

// Build a `sources` array for the static demo `pr.goal` blob (Loom +
// Figma frames + docs) so the legacy mock data still renders through the
// same generic loop the live path uses.
function staticGoalSources(goal) {
  if (!goal) return [];
  const out = [];
  if (goal.loom) {
    out.push({
      kind: "video",
      icon: "loom",
      flavor: "purple",
      label: "Loom video",
      url: goal.loom.url,
      state: "transcribed",
      note: goal.loom.duration ? `${goal.loom.duration} · ${goal.loom.frames || 0} key frames` : undefined,
    });
  }
  for (const img of goal.images || []) {
    out.push({
      kind: "image",
      icon: "image",
      flavor: "warn",
      label: img.name || "Image",
      state: "ocr'd",
      note: img.spec ? `${img.strings || 0} strings · ${img.spec}` : undefined,
    });
  }
  for (const d of goal.docs || []) {
    out.push({
      kind: "doc",
      icon: "doc",
      flavor: "info",
      label: d.path || "Doc",
      state: `${d.sections || 0} sections`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// AgentPage
// ────────────────────────────────────────────────────────────────────────────
const AgentPage = ({ logStyle, isMobile } = {}) => {
  const { user } = useAuth();
  const [mobileView, setMobileView] = React.useState("review");
  // User-appended events per PR id (composer output that hasn't yet round-tripped)
  const [userEvents, setUserEvents] = React.useState({});
  // Repo filter for the queue. "all" → no filter; otherwise the "owner/name" label.
  const [repoFilter, setRepoFilter] = React.useState("all");
  // Keyword search applied to PR title / repo / number, alongside the repo filter.
  const [queueQuery, setQueueQuery] = React.useState("");

  // Live state
  const [repos, setRepos] = React.useState([]);
  const [liveReviews, setLiveReviews] = React.useState([]); // backend PRReview[]
  const [pickedId, setPickedId] = React.useState(null);     // backend review.id (uuid)
  const [detail, setDetail] = React.useState(null);         // { review, logs, task }
  const [error, setError] = React.useState(null);
  const [syncing, setSyncing] = React.useState(false);
  const [syncStats, setSyncStats] = React.useState(null);   // { discovered, enqueued, errors }

  const refreshList = React.useCallback(async () => {
    try {
      const [reviews, repoList] = await Promise.all([api.reviews(), api.repositories()]);
      setRepos(repoList);
      setLiveReviews(reviews);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  // Auto-select the most recent review the first time the queue lands (and
  // any time the selection gets cleared, e.g. when the picked PR closes).
  // Lives in its own effect so refreshList can be dependency-free, which
  // keeps the polling loop below from tearing down on every selection change.
  React.useEffect(() => {
    if (!pickedId && liveReviews.length > 0) setPickedId(liveReviews[0].id);
  }, [pickedId, liveReviews]);

  // On mount, pull every open PR from every connected repo into the queue.
  // The endpoint is idempotent — PRs we've already seen are skipped, and only
  // the newly-discovered ones are enqueued for review.
  const syncOpenPRs = React.useCallback(async () => {
    setSyncing(true);
    try {
      const r = await api.syncReviews();
      setSyncStats(r);
      await refreshList();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSyncing(false);
    }
  }, [refreshList]);
  React.useEffect(() => { syncOpenPRs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live queue refresh. Poll continuously so PRs that arrive on the backend
  // via webhook (which inserts a new prReview row) show up in the queue
  // without a manual reload. Faster cadence (3s) while something is in
  // flight so visible progress catches up quickly, slower (6s) when idle
  // so the page doesn't hammer the API forever. Polling pauses while the
  // tab is hidden and snaps to a fresh fetch the moment the tab becomes
  // visible again, so the queue is never more than one request behind what
  // the server knows about.
  //
  // We hold liveReviews in a ref so the polling effect doesn't re-create on
  // every refresh (which would churn the setTimeout chain and the
  // visibilitychange listener). The ref always reads the latest value when
  // the timer fires.
  const liveReviewsRef = React.useRef(liveReviews);
  React.useEffect(() => { liveReviewsRef.current = liveReviews; }, [liveReviews]);
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        await refreshList();
      }
      if (cancelled) return;
      const anyLive = liveReviewsRef.current.some(
        (r) => r.status === "queued" || r.status === "reviewing"
      );
      timer = setTimeout(tick, anyLive ? 3000 : 6000);
    };
    // Kick off immediately so the first paint already reflects live data.
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshList();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshList]);

  // Periodic auto-sync from GitHub. Webhook delivery is best-effort —
  // localhost setups without a tunnel never receive them, and even healthy
  // tunnels lose events during reconnects or server restarts. Calling the
  // existing `POST /api/reviews/sync` endpoint on a slow timer closes that
  // gap: it pulls open PRs directly from every connected repo and inserts
  // any rows the webhook handler missed. The endpoint is idempotent — PRs
  // we've already seen are skipped, so this is cheap to run repeatedly.
  //
  // 30s is the worst-case discovery latency; the fast queue refresh
  // (~6s) still picks up any newly-inserted row well before the next
  // sync tick. Runs silently — does NOT flip the `syncing` flag, so the
  // "Sync" button and the stat-tile "syncing…" hint stay reserved for
  // explicit user-initiated syncs.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const runSync = async () => {
      try {
        const r = await api.syncReviews();
        if (!cancelled) setSyncStats(r);
        // The queue refresh effect picks up the new rows on its own
        // cadence — no need to call refreshList() here.
      } catch {
        // Swallow: transient sync errors (rate limit, network blip)
        // shouldn't take the page down. If the failure is persistent the
        // queue simply won't grow, and the user can hit "Sync" manually
        // to surface the error via syncOpenPRs's banner path.
      }
    };
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await runSync();
      if (cancelled) return;
      timer = setTimeout(tick, 30_000);
    };
    // Don't run immediately on mount — the existing syncOpenPRs() already
    // fires on mount, so we just schedule the first periodic tick.
    timer = setTimeout(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") runSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Fetch the picked review's logs/task when selection changes; poll while
  // the tab is visible so the timeline streams in. Same visibility contract
  // as the queue poll — pause on hidden tabs, snap fresh on return.
  React.useEffect(() => {
    if (!pickedId) { setDetail(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchOnce = () =>
      api.review(pickedId).then((d) => {
        if (!cancelled) setDetail(d);
      }).catch(() => {});
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await fetchOnce();
      if (cancelled) return;
      timer = setTimeout(tick, 2500);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchOnce();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pickedId]);

  // Index helpers
  const repoById = React.useMemo(
    () => Object.fromEntries(repos.map((r) => [r.id, r])),
    [repos]
  );

  // Map live PRReview[] → the queue-card shape the existing PRQueue renders.
  const mappedReviews = React.useMemo(() => liveReviews.map((r) => {
    const repo = repoById[r.repoId];
    const repoLabel = repo ? `${repo.owner}/${repo.name}` : r.repoId.slice(0, 8);
    const blockers = r.criteria.filter((c) => c.met === false).length;
    const met = r.criteria.filter((c) => c.met === true).length;
    return {
      id: r.id,                          // uuid (used for fetch)
      uiId: r.prNumber,                  // shown on the card
      repo: repoLabel,
      title: r.prTitle || `PR #${r.prNumber}`,
      branch: r.headSha?.slice(0, 7) || "",
      diff: {
        add: typeof r.additions === "number" ? r.additions : null,
        del: typeof r.deletions === "number" ? r.deletions : null,
        files: typeof r.changedFiles === "number" ? r.changedFiles : null,
      },
      author: "",
      model: repo?.defaultModel || "—",
      status: mapStatus(r.status),
      progress: r.status === "reviewing" ? 0.5 : r.status === "queued" ? 0 : 1,
      stage: r.status,
      issueId: r.taskId ? r.taskId.slice(0, 8) : "—",
      eta: RELATIVE(r.updatedAt),
      blockers,
      nits: 0,
      met,
      total: r.criteria.length,
    };
  }), [liveReviews, repoById]);

  // All connected repos, each with its PR count in the queue. Sourced from
  // /api/repositories so repos with zero open PRs still appear in the filter.
  const repoOptions = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of mappedReviews) counts.set(r.repo, (counts.get(r.repo) || 0) + 1);
    const fromRepos = repos.map((r) => {
      const label = `${r.owner}/${r.name}`;
      return { label, count: counts.get(label) || 0 };
    });
    // Include any queue entries whose repo isn't in `repos` (e.g. mid-sync) so
    // the user can still narrow to them.
    for (const [label, count] of counts) {
      if (!fromRepos.some((o) => o.label === label)) fromRepos.push({ label, count });
    }
    return fromRepos.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [mappedReviews, repos]);

  // If the active filter no longer matches any repo (e.g. PR closed, repo
  // disconnected), drop back to "all" so the user isn't stuck on empty.
  React.useEffect(() => {
    if (repoFilter !== "all" && !repoOptions.some((r) => r.label === repoFilter)) {
      setRepoFilter("all");
    }
  }, [repoFilter, repoOptions]);

  const filteredReviews = React.useMemo(() => {
    const byRepo = repoFilter === "all"
      ? mappedReviews
      : mappedReviews.filter((r) => r.repo === repoFilter);
    const q = queueQuery.trim().toLowerCase();
    if (!q) return byRepo;
    return byRepo.filter((r) =>
      r.title.toLowerCase().includes(q) ||
      r.repo.toLowerCase().includes(q) ||
      String(r.uiId).includes(q)
    );
  }, [mappedReviews, repoFilter, queueQuery]);

  // If the picked review got filtered out, jump to the first visible one so
  // the right-rail panes don't show stale state.
  React.useEffect(() => {
    if (!pickedId) return;
    if (!filteredReviews.some((r) => r.id === pickedId)) {
      setPickedId(filteredReviews[0]?.id || null);
    }
  }, [filteredReviews, pickedId]);

  // The selected card (for the queue and the right-rail goal panel — we shim
  // queue.id over uiId so the existing card renderer works unchanged).
  const pr = React.useMemo(() => {
    const card = mappedReviews.find((m) => m.id === pickedId);
    if (!card) return null;
    return { ...card, id: card.uiId, _uuid: card.id };
  }, [mappedReviews, pickedId]);

  // Record a review in the sidebar's "recent" list only when the user
  // explicitly opens it from the queue — programmatic selection (auto-select,
  // filter fallback) must not count.
  const handlePick = React.useCallback((id) => {
    setPickedId(id);
    if (!user?.id) return;
    const card = mappedReviews.find((m) => m.id === id);
    if (!card) return;
    const flag =
      card.status === "blocked" || card.blockers > 0 ? "blocker" :
      card.status === "review_ready" ? "review" : "ok";
    pushRecent(user.id, {
      id: card.id,
      uiId: card.uiId,
      repo: card.repo,
      title: card.title,
      flag,
    });
  }, [mappedReviews, user?.id]);

  // Timeline events: map backend logs to event objects, then concat any local
  // optimistic ones (composer sends that haven't yet round-tripped).
  const backendEvents = (detail?.logs || []).map(mapLogEntry);
  const events = [...backendEvents, ...(userEvents[pickedId] || [])];

  // Mutate a single user event by its unique key (e.g. flip loading → done)
  const updateUserEvent = (prId, key, patch) => {
    setUserEvents((all) => {
      const list = all[prId] || [];
      return {
        ...all,
        [prId]: list.map((ev) => (ev._key === key ? { ...ev, ...patch } : ev)),
      };
    });
  };

  const appendUserEvent = (prId, ev) => {
    setUserEvents((all) => ({ ...all, [prId]: [...(all[prId] || []), ev] }));
  };

  // Handle a Send from the composer — POST the attachment to the task that
  // backs this review, then re-run the review so criteria get re-synthesised
  // against the new context.
  const handleComposerSend = async ({ text, html, video, docUrl }) => {
    if (!pickedId || !detail?.task) {
      // No task yet → still show the user's words locally.
      const key = `usr-${Date.now()}`;
      appendUserEvent(pickedId, {
        _key: key,
        t: nowHMS(),
        action: "user.input",
        icon: "user",
        flavor: "active",
        target: <span className="mono mute" style={{ fontSize: 11 }}>you</span>,
        detail: <span className="user-input-text" dangerouslySetInnerHTML={{ __html: html || escapeHtml(text) }} />,
      });
      return;
    }
    const taskId = detail.task.id;
    const id = pickedId;
    const key = `usr-${Date.now()}`;

    // Optimistic UI: show the user's input immediately while the POST flies.
    if (video) {
      const { platform, url } = video;
      const short = url.replace(platform.strip, platform.label);
      const display = short.length > 32 ? short.slice(0, 30) + "…" : short;
      const pretty = platform.name.charAt(0).toUpperCase() + platform.name.slice(1);
      appendUserEvent(id, {
        _key: key, t: nowHMS(),
        action: `${platform.name}.attach`,
        icon: platform.icon, flavor: platform.flavor,
        target: <span className="str">{display}</span>,
        detail: <>Attaching {pretty} to task context; re-running review…</>,
        loading: true,
      });
      try {
        await api.addAttachment(taskId, {
          kind: platform.name === "loom" ? "loom" : "link",
          url, note: `${pretty} recording attached via Message agent`,
        });
        await api.rerunReview(id);
        updateUserEvent(id, key, { loading: false, detail: <>{pretty} attached. Review re-queued.</> });
      } catch (err) {
        updateUserEvent(id, key, { loading: false, flavor: "danger", detail: <>Attach failed: {String(err.message || err)}</> });
      }
    } else if (docUrl) {
      const host = (docUrl.match(/^https?:\/\/([^/]+)/i)?.[1]) || "doc";
      appendUserEvent(id, {
        _key: key, t: nowHMS(),
        action: "doc.attach", icon: "doc", flavor: "info",
        target: <span className="str">{host}</span>,
        detail: <>Attaching document; re-running review…</>,
        loading: true,
      });
      try {
        await api.addAttachment(taskId, { kind: "link", url: docUrl, note: `Document attached: ${host}` });
        await api.rerunReview(id);
        updateUserEvent(id, key, { loading: false, detail: <>Document attached. Review re-queued.</> });
      } catch (err) {
        updateUserEvent(id, key, { loading: false, flavor: "danger", detail: <>Attach failed: {String(err.message || err)}</> });
      }
    } else {
      appendUserEvent(id, {
        _key: key, t: nowHMS(),
        action: "user.input", icon: "user", flavor: "active",
        target: <span className="mono mute" style={{ fontSize: 11 }}>you</span>,
        detail: <span className="user-input-text" dangerouslySetInnerHTML={{ __html: html || escapeHtml(text) }} />,
      });
      try {
        await api.addAttachment(taskId, { kind: "text", note: text });
      } catch (err) {
        console.warn("[agent] attach text failed", err);
      }
    }
  };

  // For running PRs, animate which timeline step shows as "running"
  const [runningStage, setRunningStage] = React.useState(5);
  React.useEffect(() => {
    if (pr?.status !== "running") return;
    const id = setInterval(() => {
      setRunningStage((prev) => (prev + 1) % Math.max(events.length, 1));
    }, 2200);
    return () => clearInterval(id);
  }, [pickedId, pr?.status, events.length]);

  const showRunning = pr?.status === "running" ? Math.min(runningStage, events.length - 1) : -1;
  const hasGoal = !!pr?.goal;

  // Auto-scroll the review log to the latest entry whenever events change or
  // an existing event grows (e.g. a loom/doc tool result fills in after a
  // moment).
  const logBodyRef = React.useRef(null);
  const userEventsForPr = userEvents[pickedId];
  React.useEffect(() => {
    const el = logBodyRef.current;
    if (!el) return;
    // Use rAF so the new/mutated event has actually painted before we measure.
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [events.length, pickedId, userEventsForPr]);

  // Repo-aware stats. Each tile maps to a single source of truth:
  //   • Tasks / issues   — every PR the agent is tracking; wow against the
  //                        same 7-day window a week earlier
  //   • Open reviews     — PRReviews in queued / reviewing
  //   • Passed           — PRReviews in passed
  //   • Changes requested — PRReviews in changes_requested
  const stats = React.useMemo(() => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const tasksTotal = liveReviews.length;
    const thisWeek = liveReviews.filter((r) => r.createdAt >= now - 7 * DAY).length;
    const lastWeek = liveReviews.filter(
      (r) => r.createdAt >= now - 14 * DAY && r.createdAt < now - 7 * DAY
    ).length;
    // wow %: handles divide-by-zero (last week had nothing).
    let wow: number | null;
    if (lastWeek > 0) wow = ((thisWeek - lastWeek) / lastWeek) * 100;
    else if (thisWeek > 0) wow = 100;
    else wow = null; // "—" when there's no data either week
    const openReviews = liveReviews.filter((r) => r.status === "reviewing" || r.status === "queued").length;
    const passed = liveReviews.filter((r) => r.status === "passed").length;
    const requestedChanges = liveReviews.filter((r) => r.status === "changes_requested").length;
    return { tasksTotal, thisWeek, lastWeek, wow, openReviews, passed, requestedChanges };
  }, [liveReviews]);

  const wowLabel = stats.wow === null
    ? "no data yet"
    : `${stats.wow >= 0 ? "+" : ""}${stats.wow.toFixed(1)}% wow`;

  return (
    <div className="agent-shell">
      {/* Stats — agent workspace overview (per-repo aggregate) */}
      <div className="stat-grid agent-stats">
        <div className="stat">
          <div className="stat-label">tasks / issues</div>
          <div className="stat-value">{stats.tasksTotal}</div>
          <div className="stat-delta">{wowLabel}</div>
        </div>
        <div className="stat">
          <div className="stat-label">open PR reviews</div>
          <div className="stat-value">{stats.openReviews}</div>
          <div className="stat-delta">{syncing ? "syncing…" : "in flight"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">reviews passed</div>
          <div className="stat-value">{stats.passed}</div>
          <div className="stat-delta">acceptance met</div>
        </div>
        <div className="stat">
          <div className="stat-label">changes requested</div>
          <div className="stat-value">{stats.requestedChanges}</div>
          <div className="stat-delta">awaiting fix</div>
        </div>
      </div>
      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: "var(--danger)" }}>
          <div className="mono" style={{ color: "var(--danger)", fontSize: 12 }}>API error: {error}</div>
        </div>
      )}
      {syncStats?.errors?.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: "var(--warn)" }}>
          <div className="mono" style={{ color: "var(--warn)", fontSize: 12, marginBottom: 4 }}>
            Couldn't sync {syncStats.errors.length} repo{syncStats.errors.length === 1 ? "" : "s"}:
          </div>
          {syncStats.errors.slice(0, 3).map((e, i) => (
            <div key={i} className="mute mono" style={{ fontSize: 11 }}>
              {e.repo}: {e.message}
            </div>
          ))}
        </div>
      )}

      {/* Mobile segmented view-switcher */}
      {isMobile && (
        <div className="agent-mview-switch" role="tablist" aria-label="Agent view">
          {[
            { k: "queue",  l: "Queue",  i: "dashboard" },
            { k: "review", l: "Review", i: "terminal" },
            { k: "goal",   l: "Goal",   i: "spark" },
          ].map(v => (
            <button
              key={v.k}
              type="button"
              role="tab"
              aria-selected={mobileView === v.k}
              className={`agent-mview-tab ${mobileView === v.k ? "on" : ""}`}
              onClick={() => setMobileView(v.k)}
            >
              <Icon name={v.i} size={12}/>
              <span>{v.l}</span>
            </button>
          ))}
        </div>
      )}

      {/* Repo filter + keyword search — narrows the queue below */}
      <RepoFilterBar
        value={repoFilter}
        onChange={setRepoFilter}
        options={repoOptions}
        query={queueQuery}
        onQuery={setQueueQuery}
      />

      {/* 3-column workspace */}
      <div className={`agent-cols mview-${mobileView}`}>
        <PRQueue
          pickedId={pickedId}
          onPick={handlePick}
          reviews={filteredReviews}
          workspace={repos[0] ? repos[0].owner : "no repos yet"}
          onSync={syncOpenPRs}
          syncing={syncing}
        />

        <div className="agent-pane">
          <div className="agent-pane-head">
            <div className="flex gap-3 items-center">
              <h3 className="card-title">Review log{pr ? ` · ${pr.repo}#${pr.id}` : ""}</h3>
              <span className="pill"><i className="dot"></i> {events.length} events</span>
              {pr?.status === "running" && <span className="pill info"><i className="dot pulse"></i> live</span>}
            </div>
            <div className="flex gap-2 items-center">
              <button
                className="btn sm ghost"
                onClick={() => pickedId && api.rerunReview(pickedId).then(refreshList).catch((e) => alert(`Re-run failed: ${e.message || e}`))}
                disabled={!pickedId}
                title="Re-queue this review"
              >
                <Icon name="spark" size={11} /> Re-run
              </button>
            </div>
          </div>
          <div className="agent-pane-body" ref={logBodyRef}>
            {!pickedId && (
              <div className="mute mono" style={{ padding: 24, textAlign: "center", fontSize: 12 }}>
                Pick a review from the queue to see its log.
              </div>
            )}
            {pickedId && <TimelineFor events={events} runningStageIdx={showRunning} />}
          </div>
          {events.length > 0 && (
            <AgentComposer onSend={handleComposerSend} disabled={!pickedId} />
          )}
        </div>

        <GoalPanel
          pr={pr}
          live={detail ? {
            title: detail.review.prTitle,
            endGoal: detail.task?.endGoal,
            criteria: detail.review.criteria,
            regressedCriteriaIds: detail.review.regressedCriteriaIds,
            taskId: detail.task?.id,
            prNumber: detail.review.prNumber,
            attachments: detail.task?.attachments,
            sources: extractIngestedSources(detail.logs, detail.task?.attachments || []),
          } : null}
          onDeleteConstraint={async (attachmentId) => {
            if (!detail?.task?.id) return;
            try {
              await api.deleteAttachment(detail.task.id, attachmentId);
              // Optimistic: drop it from the locally cached detail so the row
              // disappears immediately. The polling refetch will reconcile.
              setDetail((d) => d && d.task ? {
                ...d,
                task: { ...d.task, attachments: (d.task.attachments || []).filter((a) => a.id !== attachmentId), endGoal: null },
                review: { ...d.review, criteria: [], status: "queued", verdict: null },
              } : d);
              refreshList();
            } catch (err) {
              alert(`Could not remove constraint: ${err.message || err}`);
            }
          }}
        />
      </div>
    </div>);

};
export { AgentPage };