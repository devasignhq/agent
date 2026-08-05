// Security page — the dedicated surface for the security audit agent's
// findings (they no longer render in GitHub PR comments; the review comment
// only links here). Four views under one component, keyed by route:
//   /security                     — findings dashboard (stats, charts, table)
//   /security/findings/:findingId — finding detail (tabs + one-click issue)
//   /security/gate                — merge gate (rules, blocking, scan terminal)
//   /security/policy              — per-repo scan policy (triggers/engines/gates)
//
// Data: ONE aggregate endpoint (api.securityOverview) powers everything; the
// scan terminal fetches its log separately (the only heavy field). Live: the
// "security" topic refetches the overview whenever the backend writes a
// finding or scan row — which is also how the terminal streams during a run.
// Pure logic (filters, stats, chart series) lives in security-findings.ts so
// node --test drives it offline.
import React from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "./icons";
import { useLiveTopic } from "./live-context";
import {
  api,
  ApiError,
  isTransientApiError,
  type GateResult,
  type RepoSecurityPolicy,
  type SecurityConfidence,
  type SecurityFinding,
  type SecurityOverview,
  type SecurityRepoView,
  type SecurityScanSummary,
  type SecuritySeverity,
} from "./api";
import {
  ageLabel,
  CHIPS,
  chipCounts,
  computeStats,
  displayId,
  filterFindings,
  isOpenState,
  mergeDeltaAllZero,
  mergeDeltaPeak,
  mergeDeltaSeries,
  overallGate,
  severityRank,
  SEVERITIES,
  similarFindings,
  SKIP_REASON_LABEL,
  slaLabel,
  sortFindings,
  STATE_LABEL,
  surfaceBreakdown,
  SURFACE_META,
  type FilterChip,
} from "./security-findings.ts";

// ─── tiny shared pieces ───────────────────────────────────────────────────────

const SevPill = ({ sev }: { sev: SecuritySeverity }) => (
  <span className={`vln-sev ${sev}`}>
    <i />
    {sev}
  </span>
);

// Unverified findings are severity-capped by the backend (critical/high
// require "confirmed"); the chip makes them visually distinct so a human
// knows verification is the next step. Confirmed findings render no chip.
const ConfTag = ({ conf }: { conf: SecurityConfidence }) =>
  !conf || conf === "confirmed" ? null : (
    <span
      className="vln-tag conf"
      title={
        conf === "probable"
          ? "Strong evidence, but an assumption is unverified — severity capped at medium"
          : "Depends on something outside the scanned file — severity capped at medium"
      }
    >
      {conf.replace("_", " ")}
    </span>
  );

const StateTag = ({ f }: { f: SecurityFinding }) => {
  const meta = STATE_LABEL[f.state] ?? { label: f.state, tone: "none" as const };
  return <span className={`vln-tag ${meta.tone !== "none" ? meta.tone : ""}`}>{meta.label}</span>;
};

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "");

// ─── plan lock ────────────────────────────────────────────────────────────────
//
// Security audits are Pro/Max. The overview still loads on Free (reads are never
// gated, so a downgraded account keeps seeing the findings it already has) and
// carries `locked`; everything that spends or configures is turned off here,
// with the backend refusing the same calls as the real boundary.

const goUpgrade = () => (window.location.href = `${window.location.origin}/?billing=upgrade`);

const ProLock = () => (
  <span className="pill purple" title="Pro/Max feature">
    <Icon name="lock" size={9} /> Pro
  </span>
);

// Persistent banner shown above findings a locked account can still read.
const LockedNotice = () => (
  <div className="tu-notice" style={{ marginBottom: 12 }}>
    Security audits are a Pro/Max feature — scans, triage and the merge gate are paused on
    your plan.{" "}
    <button className="btn sm" style={{ marginLeft: 8 }} onClick={goUpgrade}>
      Upgrade
    </button>
  </div>
);

// Full paywall state — a locked account with nothing on record. Mirrors
// FirstRunEmpty so the page reads the same whether it's empty or unavailable.
const LockedEmpty = () => (
  <div className="vln-blank">
    <div className="vln-blank-art">
      <Icon name="shield" size={26} />
    </div>
    <div className="vln-blank-t">Security audits are a Pro feature</div>
    <div className="vln-blank-s">
      On Pro and Max the security agents audit your repository on every merge, publish the{" "}
      <b>devasign/security</b> merge gate on pull requests, and turn any finding into a GitHub
      issue in one click. Upgrade to switch them on.
    </div>
    <div className="vln-blank-surfaces">
      {(Object.keys(SURFACE_META) as (keyof typeof SURFACE_META)[]).map((s) => (
        <span className="vln-blank-surface" key={s}>
          <Icon name={SURFACE_META[s].icon} size={13} />
          {SURFACE_META[s].label}
        </span>
      ))}
    </div>
    <button className="btn primary" style={{ marginTop: 16 }} onClick={goUpgrade}>
      Upgrade to Pro
    </button>
  </div>
);

// ─── main page ────────────────────────────────────────────────────────────────

type ViewKey = "dashboard" | "detail" | "gate" | "policy";

// One segment of the top-bar breadcrumb. A segment with a `path` is a link back;
// the last (pathless) segment is the current page.
export type SecurityCrumb = { label: string; path?: string };

export const SecurityPage = ({
  view,
  isMobile,
  onCrumbs,
}: {
  view: ViewKey;
  isMobile?: boolean;
  onCrumbs?: (crumbs: SecurityCrumb[] | null) => void;
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { findingId } = useParams();
  const [searchParams] = useSearchParams();
  // Where a finding was opened FROM (threaded through router state), so its
  // breadcrumb shows the path in — "Security / Merge gate / VLN-…" — and Back
  // returns there rather than always to the findings list.
  const origin = (location.state as { from?: string } | null)?.from;

  const [overview, setOverview] = React.useState<SecurityOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // "all" or a repoId. The ?repo= deep link (from PR comments) carries
  // "owner/name" — resolved to an id once the overview arrives.
  const [repoFilter, setRepoFilter] = React.useState<string>("all");
  const [chip, setChip] = React.useState<FilterChip>("all");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.securityOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Silent variant: a live refetch must never blank an already-painted page.
  const refresh = React.useCallback(async () => {
    try {
      setOverview(await api.securityOverview());
    } catch (err) {
      if (!isTransientApiError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveTopic("security", () => void refresh());

  // Backstop poll while a scan is queued/running (mirrors the settling-txn poll
  // on the Bounties page) — the SSE stream is the primary signal.
  const scanning = overview?.scans.some((s) => s.status === "queued" || s.status === "running");
  React.useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [scanning, refresh]);

  // Resolve the ?repo=owner/name deep link once repos are known.
  React.useEffect(() => {
    const want = searchParams.get("repo");
    if (!want || !overview) return;
    const hit = overview.repos.find((r) => `${r.owner}/${r.name}` === want || r.id === want);
    if (hit) setRepoFilter(hit.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.repos.length, searchParams]);

  // Merge one mutated finding back into the overview (issue created, triage
  // action) so the open detail updates without a refetch round-trip.
  const applyFinding = React.useCallback((next: Partial<SecurityFinding> & { id: string }) => {
    setOverview((o) =>
      o
        ? { ...o, findings: o.findings.map((f) => (f.id === next.id ? { ...f, ...next } : f)) }
        : o
    );
  }, []);

  // Breadcrumb trail for the top bar. Reflects the sub-view — and, for a
  // finding, where it was opened from — so the crumb shows the flow across
  // screens and every earlier segment links back. `detailLabel` is a string
  // (not the finding object) so a background refresh doesn't churn the trail.
  const detailLabel =
    view === "detail"
      ? (() => {
          const f = overview?.findings.find((x) => x.id === findingId);
          return f ? displayId(f) : "Finding";
        })()
      : "";
  const crumbs = React.useMemo<SecurityCrumb[]>(() => {
    const root: SecurityCrumb = { label: "Security", path: "/security" };
    if (view === "gate") return [root, { label: "Merge gate" }];
    if (view === "policy") return [root, { label: "Scan policy" }];
    if (view === "detail") {
      const leaf: SecurityCrumb = { label: detailLabel };
      return origin === "gate"
        ? [root, { label: "Merge gate", path: "/security/gate" }, leaf]
        : [root, leaf];
    }
    return [{ label: "Security" }]; // dashboard — Security is the current page
  }, [view, origin, detailLabel]);
  const crumbKey = crumbs.map((c) => `${c.label}|${c.path ?? ""}`).join(">");
  React.useEffect(() => {
    onCrumbs?.(crumbs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCrumbs, crumbKey]);
  // Clear only on unmount (leaving the Security section), not on every trail
  // change — a per-change clear would flash the default label between screens.
  React.useEffect(() => () => onCrumbs?.(null), [onCrumbs]);

  const subNav = (
    <div className="vln-subnav">
      {[
        { key: "dashboard", label: "Findings", path: "/security" },
        { key: "gate", label: "Merge gate", path: "/security/gate" },
        { key: "policy", label: "Scan policy", path: "/security/policy" },
      ].map((t) => (
        <button
          key={t.key}
          className={`vln-subtab ${view === t.key || (view === "detail" && t.key === "dashboard") ? "on" : ""}`}
          onClick={() => navigate(t.path)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (loading && !overview) {
    return (
      <div className="page vln-page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Security</h1>
            <div className="page-sub">loading…</div>
          </div>
        </div>
      </div>
    );
  }
  if (error && !overview) {
    return (
      <div className="page vln-page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Security</h1>
          </div>
        </div>
        <div className="tu-notice">
          {error}{" "}
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!overview) return null;

  if (view === "detail") {
    const finding = overview.findings.find((f) => f.id === findingId);
    return (
      <FindingDetail
        finding={finding}
        all={overview.findings}
        repos={overview.repos}
        onBack={() => navigate(origin === "gate" ? "/security/gate" : "/security")}
        onOpen={(id) => navigate(`/security/findings/${id}`, { state: { from: origin } })}
        applyFinding={applyFinding}
        refresh={refresh}
        locked={overview.locked}
      />
    );
  }

  return (
    <div className="page vln-page">
      <PageHead
        overview={overview}
        view={view}
        repoFilter={repoFilter}
        setRepoFilter={setRepoFilter}
        refresh={refresh}
        subNav={subNav}
      />
      {error && <div className="tu-notice" style={{ marginBottom: 12 }}>{error}</div>}
      {/* Locked with nothing on record → the paywall state replaces the body;
          locked with findings (a lapsed sub) → keep them readable under a
          banner, with every action turned off. */}
      {overview.locked && overview.findings.length > 0 && <LockedNotice />}
      {view === "dashboard" &&
        (overview.locked && overview.findings.length === 0 ? (
          <LockedEmpty />
        ) : (
          <Dashboard
            overview={overview}
            repoFilter={repoFilter}
            chip={chip}
            setChip={setChip}
            onOpen={(id) => navigate(`/security/findings/${id}`)}
          />
        ))}
      {(view === "gate" || view === "policy") && overview.locked && overview.findings.length === 0 && (
        <LockedEmpty />
      )}
      {(view === "gate" || view === "policy") && !(overview.locked && overview.findings.length === 0) && (() => {
        // Gate/policy show ONE repo at a time, chosen by the left rail. The
        // header's "all" default (and any unknown id) resolves to the first
        // repo so the body always has a concrete repo to render.
        const selectedRepoId =
          overview.repos.find((r) => r.id === repoFilter)?.id ?? overview.repos[0]?.id;
        const body =
          view === "gate" ? (
            <GateView
              overview={overview}
              repoFilter={selectedRepoId}
              onOpen={(id) => navigate(`/security/findings/${id}`, { state: { from: "gate" } })}
            />
          ) : (
            <PolicyView
              overview={overview}
              repoFilter={selectedRepoId}
              refresh={refresh}
              locked={overview.locked}
            />
          );
        // The rail appears once there's more than one repo to choose between.
        return overview.repos.length > 1 ? (
          <div className="vln-repo-layout">
            <RepoRail repos={overview.repos} value={selectedRepoId} onSelect={setRepoFilter} />
            <div className="vln-repo-body">{body}</div>
          </div>
        ) : (
          body
        );
      })()}
    </div>
  );
};

// ─── header (shared by dashboard / gate / policy) ─────────────────────────────

const PageHead = ({
  overview,
  view,
  repoFilter,
  setRepoFilter,
  refresh,
  subNav,
}: {
  overview: SecurityOverview;
  view: ViewKey;
  repoFilter: string;
  setRepoFilter: (v: string) => void;
  refresh: () => Promise<void>;
  subNav: React.ReactNode;
}) => {
  const [scanBusy, setScanBusy] = React.useState(false);
  const [scanErr, setScanErr] = React.useState<string | null>(null);
  const scanning = overview.scans.some((s) => s.status === "queued" || s.status === "running");
  const targets =
    repoFilter === "all" ? overview.repos : overview.repos.filter((r) => r.id === repoFilter);

  const rescan = async () => {
    setScanBusy(true);
    setScanErr(null);
    try {
      for (const r of targets) {
        try {
          // Full: a manual re-scan bypasses the per-blob cache, so "Re-scan"
          // re-audits every eligible file rather than only changed ones.
          await api.startSecurityScan(r.id, true);
        } catch (err) {
          // A 409 just means a run is already in flight for that repo.
          if (!(err instanceof ApiError && err.status === 409)) throw err;
        }
      }
      await refresh();
    } catch (err) {
      // The plan backstop — reachable if the sub lapses between load and click.
      setScanErr(
        err instanceof ApiError && err.status === 403
          ? "Security audits are a Pro/Max feature."
          : err instanceof Error
          ? err.message
          : String(err)
      );
    } finally {
      setScanBusy(false);
    }
  };

  const branches = [...new Set(overview.repos.map((r) => r.defaultBranch))].join(", ");
  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-title">Security</h1>
          <div className="page-sub">
            {overview.repos.length} repo{overview.repos.length === 1 ? "" : "s"} ·{" "}
            {overview.locked ? (
              <>audits paused — Pro/Max feature</>
            ) : (
              <>
                audit on every merge to{" "}
                <span style={{ color: "var(--fg-dim)" }}>{branches || "main"}</span>
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          {/* The gate/policy subpages select their repo with the left rail, so
              the dropdown is only needed to filter the findings dashboard. */}
          {view === "dashboard" && (
            <select
              className="select"
              style={{ width: "auto", minWidth: 160, paddingRight: 28 }}
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
            >
              <option value="all">All repositories</option>
              {overview.repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
          )}
          {/* Re-scan lives on the findings dashboard only; the gate/policy
              subpages are for reviewing and configuring, not triggering scans.
              On a locked plan it gives way to the upgrade CTA. */}
          {overview.locked ? (
            <button className="btn primary" onClick={goUpgrade}>
              <Icon name="lock" size={12} /> Upgrade to Pro
            </button>
          ) : (
            view === "dashboard" && (
              <button className="btn primary" disabled={scanBusy || scanning} onClick={() => void rescan()}>
                <Icon name="play" size={12} /> {scanning ? "Scanning…" : scanBusy ? "Queuing…" : "Re-scan"}
              </button>
            )
          )}
        </div>
      </div>
      {subNav}
      {scanErr && <div className="tu-notice" style={{ marginBottom: 12 }}>{scanErr}</div>}
    </>
  );
};

// ─── first-run empty state ────────────────────────────────────────────────────

// Shown before any audit has ever run — a fresh install/sign-up with no scans
// and no findings on record. It sets the expectation that the agents kick in on
// the first merge, rather than dropping the user into a dashboard of zeros. The
// no-repo case points them at connecting a repository first, since nothing can
// be audited until then.
const FirstRunEmpty = ({ overview }: { overview: SecurityOverview }) => {
  const hasRepos = overview.repos.length > 0;
  const branches = [...new Set(overview.repos.map((r) => r.defaultBranch))].filter(Boolean);
  const branch = branches.length === 1 ? branches[0] : "your default branch";
  return (
    <div className="vln-blank">
      <div className="vln-blank-art">
        <Icon name="shield" size={26} />
      </div>
      <div className="vln-blank-t">No security audit yet</div>
      <div className="vln-blank-s">
        {hasRepos ? (
          <>
            The security agents run their first audit automatically when you merge a pull
            request to <b>{branch}</b>. Merge one to see findings appear here — or hit{" "}
            <b>Re-scan</b> above to run an audit against the current code now.
          </>
        ) : (
          <>
            Connect a repository to get started. Once it's linked, the security agents run an
            audit automatically every time a pull request merges — no setup required.
          </>
        )}
      </div>
      {hasRepos && (
        <div className="vln-blank-surfaces">
          {(Object.keys(SURFACE_META) as (keyof typeof SURFACE_META)[]).map((s) => (
            <span className="vln-blank-surface" key={s}>
              <Icon name={SURFACE_META[s].icon} size={13} />
              {SURFACE_META[s].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── findings dashboard ───────────────────────────────────────────────────────

const Dashboard = ({
  overview,
  repoFilter,
  chip,
  setChip,
  onOpen,
}: {
  overview: SecurityOverview;
  repoFilter: string;
  chip: FilterChip;
  setChip: (c: FilterChip) => void;
  onOpen: (id: string) => void;
}) => {
  const now = Date.now();
  const scopedFindings = overview.findings.filter(
    (f) => repoFilter === "all" || f.repoId === repoFilter
  );
  const scopedScans = overview.scans.filter(
    (s) => repoFilter === "all" || s.repoId === repoFilter
  );
  const stats = computeStats(scopedFindings, scopedScans, now);
  const counts = chipCounts(overview.findings, repoFilter);
  const shown = sortFindings(filterFindings(overview.findings, { chip, repoId: repoFilter }));
  const series = mergeDeltaSeries(overview.scans, repoFilter, 12);
  const surfaces = surfaceBreakdown(overview.findings, repoFilter);
  const repoName = (repoId: string) =>
    overview.findings.find((f) => f.repoId === repoId)?.repo ??
    overview.repos.find((r) => r.id === repoId)?.name ??
    "";

  // GitHub blob URL for a finding's file, resolving the repo's default branch
  // from the overview (falls back to HEAD, then to the repo root). Mirrors the
  // link the finding-detail view builds. Returns null when we have no repo slug.
  const repoFileUrl = (f: SecurityFinding): string | null => {
    if (!f.repo) return null;
    const base = `https://github.com/${f.repo}`;
    if (!f.path) return base;
    const branch = overview.repos.find((r) => r.id === f.repoId)?.defaultBranch ?? "HEAD";
    return `${base}/blob/${branch}/${f.path}${f.line ? `#L${f.line}` : ""}`;
  };

  const latest = [...scopedScans].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const latestRepo = latest ? overview.repos.find((r) => r.id === latest.repoId) : null;
  const gate = overallGate(repoFilter === "all" ? overview.repos : overview.repos.filter((r) => r.id === repoFilter));

  const peak = mergeDeltaPeak(series);
  // Every column flat. Legitimate in steady state, so caption it — a bare grid
  // of empty columns is indistinguishable from a chart that failed to load.
  const flatSeries = mergeDeltaAllZero(series);

  // Never audited: no scans have ever run and there are no findings on record.
  // Show the first-run empty state instead of a dashboard full of zeros. This
  // keys off the unscoped overview (not the repo-filtered slice) so it only
  // fires for a genuinely fresh account, not a repo filter that happens to be
  // empty.
  if (overview.scans.length === 0 && overview.findings.length === 0) {
    return <FirstRunEmpty overview={overview} />;
  }

  return (
    <>
      {latest && (
        <div className="vln-strip">
          <div>
            <div className="vln-strip-k">last scan</div>
            <div className="vln-strip-v">
              {latest.trigger === "merge" && latest.prNumber ? (
                <>
                  {latestRepo?.defaultBranch ?? "main"} ← #{latest.prNumber}{" "}
                  {latest.prTitle && <em>“{latest.prTitle}”</em>}{" "}
                  {latest.mergeSha && <span className="vln-tag plain">{short(latest.mergeSha)}</span>}
                </>
              ) : (
                <>
                  {latest.trigger} scan{latestRepo ? ` · ${latestRepo.owner}/${latestRepo.name}` : ""}
                </>
              )}
            </div>
          </div>
          <div className="vln-strip-meta">
            <span>
              <b>{latest.filesScanned}</b> scanned
            </span>
            <span>
              <b>{latest.cacheHits}</b> cached
            </span>
            {latest.finishedAt && (
              <span>
                in <b>{Math.max(1, Math.round((latest.finishedAt - latest.startedAt) / 1000))}s</b>,{" "}
                {ageLabel(latest.finishedAt, now)} ago
              </span>
            )}
            {(latest.status === "queued" || latest.status === "running") && (
              <span className="txt-accent">{latest.status}…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {latest.introduced > 0 && (
              <span className="vln-sev critical">
                <i /> {latest.introduced} introduced
              </span>
            )}
            {gate === "fail" ? (
              <span className="vln-tag new">merge gate blocked</span>
            ) : (
              <span className="vln-tag ok">merge gate clear</span>
            )}
          </div>
        </div>
      )}

      <div className="vln-stats">
        <div className="vln-stat">
          <div className="k">open findings</div>
          <div className="vln-stat-row">
            <div className="v">{stats.open}</div>
            <div className="d">
              {stats.openCritical > 0 ? `${stats.openCritical} critical` : "no criticals"}
            </div>
          </div>
        </div>
        <div className={`vln-stat ${stats.introducedByLastMerge > 0 ? "alarm" : ""}`}>
          <div className="k">new since last scan</div>
          <div className="vln-stat-row">
            <div className="v">{stats.introducedByLastMerge}</div>
            <div className="d">{stats.lastMergePr ? `from merge #${stats.lastMergePr}` : "—"}</div>
          </div>
        </div>
        <div className="vln-stat">
          <div className="k">resolved · 30d</div>
          <div className="vln-stat-row">
            <div className="v">{stats.resolved30d}</div>
            <div className="d" style={{ color: "var(--green)" }}>
              {stats.resolved30d > 0 ? "confirmed by re-scan" : "—"}
            </div>
          </div>
        </div>
        <div className="vln-stat">
          <div className="k">mean time to fix</div>
          <div className="vln-stat-row">
            <div className="v">
              {stats.meanTimeToFixDays ?? "—"}
              {stats.meanTimeToFixDays != null && (
                <span style={{ fontSize: 12, color: "var(--fg)" }}> days</span>
              )}
            </div>
            <div className="d">critical SLA ≤ 24h</div>
          </div>
        </div>
      </div>

      <div className="vln-mid">
        <div className="vln-pnl">
          <div className="vln-pnl-head">
            <h3 className="vln-pnl-t">Introduced vs resolved · last {series.length || 0} scans</h3>
            <div className="vln-pnl-s">
              {repoFilter === "all"
                ? "all repositories"
                : `${overview.repos.find((r) => r.id === repoFilter)?.owner}/${overview.repos.find((r) => r.id === repoFilter)?.name}`}
            </div>
          </div>
          <div className="vln-pnl-body vln-mg-body">
            {series.length === 0 ? (
              <div className="vln-empty">No completed scans yet — merge a PR or hit Re-scan.</div>
            ) : (
              <>
                <div className="vln-mg">
                  {/* Axis gutter: one label above the axis, one below, so the
                      two halves of each column read without a legend lookup. */}
                  <div className="vln-mg-y">
                    <span className="up">introduced</span>
                    <span className="dn">resolved</span>
                  </div>
                  <div className="vln-mg-cols">
                    {series.map((c, i) => (
                      <div
                        key={i}
                        className={`vln-mg-col ${c.now ? "now" : ""} ${c.running ? "running" : ""} ${
                          c.skipped ? "skipped" : ""
                        }`}
                      >
                        <div className="vln-mg-tip">
                          <b>{c.label}</b>
                          {/* A skipped run never scanned; a flat one scanned and
                              found no change. Both draw no bars — say which. */}
                          {c.skipped ? (
                            <span>{SKIP_REASON_LABEL[c.skipped]}</span>
                          ) : (
                            c.noop && <span>nothing this scan</span>
                          )}
                          {c.segments.map((seg) => (
                            <span key={seg.severity}>
                              <i className={`sev-${seg.severity}`} />
                              {seg.severity}: {seg.count}
                            </span>
                          ))}
                          {c.resolved > 0 && (
                            <span>
                              <i className="sev-resolved" />
                              resolved: {c.resolved}
                            </span>
                          )}
                        </div>
                        {/* Introduced stacks upward from the axis, critical at
                            the top of the stack (flex-end + critical-first). */}
                        <div className="vln-mg-up">
                          {c.segments.map((seg) => (
                            <div
                              key={seg.severity}
                              className={`vln-mg-b sev-${seg.severity}`}
                              style={{ height: `${(seg.count / peak) * 100}%` }}
                            />
                          ))}
                        </div>
                        <div className="vln-mg-ax" />
                        <div className="vln-mg-dn">
                          {c.resolved > 0 && (
                            <div
                              className="vln-mg-b sev-resolved"
                              style={{ height: `${(c.resolved / peak) * 100}%` }}
                            />
                          )}
                        </div>
                        <div className="vln-mg-x">{c.label}</div>
                      </div>
                    ))}
                  </div>
                  {flatSeries && (
                    <div className="vln-mg-flat">
                      {series.every((c) => c.skipped)
                        ? "No scan in this window actually ran — hover a column for the reason."
                        : `No findings introduced or resolved in the last ${series.length} scan${
                            series.length === 1 ? "" : "s"
                          }.`}
                    </div>
                  )}
                </div>
                <div className="vln-mg-legend">
                  {SEVERITIES.map((sev) => (
                    <span key={sev}>
                      <i className={`sev-${sev}`} />
                      {sev}
                    </span>
                  ))}
                  <span className="right">
                    <i className="sev-resolved" />
                    resolved below the axis
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="vln-pnl">
          <div className="vln-pnl-head">
            <h3 className="vln-pnl-t">Attack surface</h3>
            <div className="vln-pnl-s">{stats.open} open</div>
          </div>
          <div>
            {surfaces.map((s) => (
              <div className="vln-sf-row" key={s.surface}>
                <span className="ico">
                  <Icon name={SURFACE_META[s.surface].icon} size={14} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="vln-sf-n">
                    {SURFACE_META[s.surface].label}{" "}
                    {s.fresh > 0 && <span className="vln-sf-new">+{s.fresh}</span>}
                  </div>
                  <div className="vln-sf-e">{SURFACE_META[s.surface].sub}</div>
                  <div className="vln-sf-bar">
                    {s.bySeverity.map((b) => (
                      <i
                        key={b.severity}
                        className={b.severity}
                        style={{ width: `${(b.count / Math.max(1, s.count)) * 100}%` }}
                      />
                    ))}
                    <i style={{ background: "var(--bg-3)", flex: 1 }} />
                  </div>
                </div>
                <div className="vln-sf-c">{s.count}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="vln-pnl">
        <div className="vln-pnl-head vln-pnl-head-wrap">
          <div className="vln-chips">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                className={`vln-chip ${chip === c.key ? "on" : ""}`}
                onClick={() => setChip(c.key)}
              >
                {c.label} <b>{counts[c.key]}</b>
              </button>
            ))}
          </div>
          <div className="vln-pnl-s">
            showing {shown.length} finding{shown.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="vln-fx-head">
          <span>severity</span>
          <span>id</span>
          <span>finding</span>
          <span>surface</span>
          <span>origin</span>
          <span>repo</span>
          <span style={{ textAlign: "right" }}>age</span>
          <span>state</span>
        </div>
        {shown.map((f) => {
          const repoHref = repoFileUrl(f);
          return (
            <div
              key={f.id}
              className={`vln-fx-row ${f.severity} ${f.state === "new" ? "fresh" : ""}`}
              onClick={() => onOpen(f.id)}
            >
              <SevPill sev={f.severity} />
              <span className="vln-fx-id">{displayId(f)}</span>
              <span style={{ minWidth: 0 }}>
                <span className="vln-fx-t">
                  {f.title} <ConfTag conf={f.confidence} />
                </span>
                <span className="vln-fx-l">
                  <u>{f.path}</u>
                  {f.line ? `:${f.line}` : ""}
                  {f.cwe ? ` · ${f.cwe}` : ""}
                </span>
              </span>
              <span className="vln-tag surface">{f.surface}</span>
              <span className="vln-fx-o">
                {f.introducedByPr ? `#${f.introducedByPr}` : "—"}
                <em>
                  {f.introducedByAuthor ? `@${f.introducedByAuthor}` : "audit"}
                  {f.introducedSha ? ` · ${short(f.introducedSha)}` : ""}
                </em>
              </span>
              {/* repo URL path — owner/name linking to the file on GitHub. */}
              {repoHref ? (
                <a
                  className="vln-fx-repo"
                  href={repoHref}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={f.path ? `${f.repo} · ${f.path}${f.line ? `:${f.line}` : ""}` : f.repo}
                >
                  {f.repo || "—"}
                </a>
              ) : (
                <span className="vln-fx-repo">{f.repo || "—"}</span>
              )}
              <span className="vln-fx-a">{ageLabel(f.firstDetectedAt, now)}</span>
              <StateTag f={f} />
            </div>
          );
        })}
        {shown.length === 0 && (
          <div className="vln-empty">
            {overview.findings.length === 0
              ? "No findings yet. The audit runs automatically when a PR merges — or hit Re-scan."
              : "No findings match this filter."}
          </div>
        )}
      </div>
    </>
  );
};

// ─── finding detail ───────────────────────────────────────────────────────────

const DT_TABS = ["Overview", "Reachability", "History", "Similar"] as const;

const FindingDetail = ({
  finding,
  all,
  repos,
  onBack,
  onOpen,
  applyFinding,
  refresh,
  locked,
}: {
  finding: SecurityFinding | undefined;
  all: SecurityFinding[];
  repos: SecurityRepoView[];
  onBack: () => void;
  onOpen: (id: string) => void;
  applyFinding: (f: Partial<SecurityFinding> & { id: string }) => void;
  refresh: () => Promise<void>;
  locked: boolean;
}) => {
  const [tab, setTab] = React.useState<(typeof DT_TABS)[number]>("Overview");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<"false_positive" | "accept" | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setTab("Overview");
    setErr(null);
    setConfirm(null);
  }, [finding?.id]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  if (!finding) {
    return (
      <div className="page vln-page">
        <div className="tu-notice">
          Finding not found — it may have been resolved and pruned.{" "}
          <button className="btn sm" onClick={onBack}>
            Back to findings
          </button>
        </div>
      </div>
    );
  }
  const f = finding;
  const now = Date.now();
  const sla = slaLabel(f, now);
  const similar = similarFindings(f, all);
  const repo = repos.find((r) => r.id === f.repoId);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      const detail =
        e instanceof ApiError && (e.body as any)?.message
          ? String((e.body as any).message)
          : e instanceof Error
          ? e.message
          : String(e);
      setErr(detail);
    } finally {
      setBusy(null);
    }
  };

  const patch = (body: Parameters<typeof api.patchFinding>[2]) =>
    act(body.action, async () => {
      const res = await api.patchFinding(f.repoId, f.id, body);
      applyFinding(res.finding);
      setConfirm(null);
    });

  const createIssue = () =>
    act("issue", async () => {
      const res = await api.createFindingIssue(f.repoId, f.id);
      applyFinding({ id: f.id, state: "issue_created", issueNumber: res.issueNumber, issueUrl: res.issueUrl });
      void refresh();
    });

  const copyRemediation = async () => {
    try {
      await navigator.clipboard.writeText(f.remediation ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const terminal = f.state === "resolved" || f.state === "accepted" || f.state === "false_positive";

  return (
    <div className="page vln-page vln-dt">
      <div className="vln-dt-head">
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <SevPill sev={f.severity} />
          <ConfTag conf={f.confidence} />
          {f.state === "new" && <span className="vln-tag new">new</span>}
          {f.cwe && <span className="vln-tag">{f.cwe}</span>}
          <span className="vln-tag plain">{displayId(f)}</span>
          <StateTag f={f} />
          <div style={{ flex: 1 }} />
          <button className="vln-back" onClick={onBack}>
            <Icon name="chevron-r" size={11} /> back to findings <span className="mute">esc</span>
          </button>
        </div>
        <h2 className="vln-dt-title">{f.title}</h2>
      </div>

      <div className="vln-dt-tabs">
        {DT_TABS.map((t) => (
          <button key={t} className={`vln-dt-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t}
            {t === "Similar" ? ` (${similar.length})` : ""}
          </button>
        ))}
      </div>

      {err && <div className="tu-notice" style={{ margin: "12px 0 0" }}>{err}</div>}

      <div className="vln-dt-body">
        <div className="kv-grid vln-kv">
          <div className="kv">
            <div className="kv-k">surface</div>
            <div className="kv-v">
              <Icon name={SURFACE_META[f.surface].icon} size={12} /> {f.surface}
            </div>
          </div>
          <div className="kv">
            <div className="kv-k">location</div>
            <div className="kv-v mono" style={{ fontSize: 12 }}>
              {repo ? (
                <a
                  href={`https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${f.path}${f.line ? `#L${f.line}` : ""}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {f.path}
                  {f.line ? `:${f.line}` : ""}
                </a>
              ) : (
                <>
                  {f.path}
                  {f.line ? `:${f.line}` : ""}
                </>
              )}
            </div>
          </div>
          <div className="kv">
            <div className="kv-k">origin</div>
            <div className="kv-v">
              {f.introducedByPr && f.repo ? (
                <a href={`https://github.com/${f.repo}/pull/${f.introducedByPr}`} target="_blank" rel="noreferrer">
                  #{f.introducedByPr}
                </a>
              ) : (
                "audit scan"
              )}
              {f.introducedByAuthor && <small> · @{f.introducedByAuthor}</small>}
            </div>
          </div>
          <div className="kv">
            <div className="kv-k">confidence</div>
            <div className="kv-v">{f.confidence.replace("_", " ")}</div>
          </div>
          <div className="kv">
            <div className="kv-k">blast radius</div>
            <div className="kv-v" style={{ fontSize: 12 }}>{f.blastRadius || "—"}</div>
          </div>
          <div className="kv">
            <div className="kv-k">sla</div>
            <div className="kv-v" style={sla.breached ? { color: "var(--danger)" } : {}}>{sla.text}</div>
          </div>
        </div>

        {tab === "Overview" && (
          <>
            <div className="vln-block">
              <div className="vln-h">What's wrong</div>
              <div className="vln-analysis">
                {f.concern}
                {f.invariant && (
                  <div className="vln-invariant">
                    <b>Invariant:</b> {f.invariant}
                  </div>
                )}
              </div>
            </div>
            {f.evidence && (
              <div className="vln-block">
                <div className="vln-h">
                  Evidence <span>{f.path}{f.line ? `:${f.line}` : ""}</span>
                </div>
                <pre className="vln-code">{f.evidence}</pre>
              </div>
            )}
            {f.remediation && (
              <div className="vln-block">
                <div className="vln-h">
                  Suggested fix{" "}
                  <button className="vln-copy" onClick={() => void copyRemediation()}>
                    <Icon name="copy" size={11} /> {copied ? "copied" : "copy prompt"}
                  </button>
                </div>
                <pre className="vln-code">{f.remediation}</pre>
              </div>
            )}
            {f.regressionTest && (
              <div className="vln-block">
                <div className="vln-h">Regression test</div>
                <pre className="vln-code">{f.regressionTest}</pre>
              </div>
            )}
          </>
        )}

        {tab === "Reachability" && (
          <div className="vln-block">
            <div className="vln-h">
              Exploit path{" "}
              {f.dataflow && (
                <span>
                  {f.dataflow.source} → {f.dataflow.sink}
                </span>
              )}
            </div>
            {(f.exploitNarrative?.length ?? 0) > 0 ? (
              <div className="vln-tp">
                {f.exploitNarrative!.map((s, i) => (
                  <div
                    key={i}
                    className={`vln-tp-s ${i === 0 ? "hit" : ""} ${i === f.exploitNarrative!.length - 1 ? "sink" : ""}`}
                  >
                    <div className="vln-tp-d">{i + 1}</div>
                    <div className="vln-tp-n">{s}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="vln-empty">No exploit narrative recorded.</div>
            )}
            {f.dataflow && f.dataflow.steps.length > 0 && (
              <>
                <div className="vln-h" style={{ marginTop: 16 }}>Dataflow</div>
                <div className="vln-tp">
                  {f.dataflow.steps.map((s, i) => (
                    <div key={i} className="vln-tp-s">
                      <div className="vln-tp-d">·</div>
                      <div className="vln-tp-n">{s}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "History" && (
          <div className="vln-block">
            <div className="vln-h">Activity</div>
            {(f.activity ?? []).length === 0 && <div className="vln-empty">No activity yet.</div>}
            {[...(f.activity ?? [])].reverse().map((h, i) => (
              <div key={i} className="vln-hist">
                <span className="t mono">{ageLabel(h.at, now)} ago</span>
                <span>
                  {h.detail}
                  {h.actor && h.actor !== "audit-agent" ? ` — @${h.actor}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === "Similar" && (
          <div className="vln-block">
            <div className="vln-h">Similar findings</div>
            {similar.length === 0 && <div className="vln-empty">No similar findings.</div>}
            {similar.map((s) => (
              <div key={s.id} className="vln-sim" onClick={() => onOpen(s.id)}>
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <SevPill sev={s.severity} />
                  <span className="vln-sim-t">{s.title}</span>
                </div>
                <span className="mono mute" style={{ fontSize: 11 }}>{displayId(s)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* A locked plan can still read the finding; issue creation and triage are
          off, and the backend refuses them regardless. */}
      {locked && <LockedNotice />}

      <div className="vln-dt-foot">
        {/* Issue / bounty flow: one-click issue first; bounties ride the issue. */}
        {f.issueUrl ? (
          <a className="btn" href={f.issueUrl} target="_blank" rel="noreferrer">
            <Icon name="github" size={13} /> Issue #{f.issueNumber} <Icon name="external" size={10} />
          </a>
        ) : (
          !terminal &&
          (locked ? (
            <button className="btn" onClick={goUpgrade}>
              <Icon name="github" size={13} /> Create GitHub issue <ProLock />
            </button>
          ) : (
            <button className="btn primary" disabled={busy === "issue"} onClick={() => void createIssue()}>
              <Icon name="github" size={13} /> {busy === "issue" ? "Creating…" : "Create GitHub issue"}
            </button>
          ))
        )}
        {f.bounty ? (
          <span className="vln-tag ok" style={{ height: 26 }}>
            bounty {f.bounty.code} · {f.bounty.status} · {f.bounty.amountUsdc} USDC
          </span>
        ) : (
          f.issueUrl &&
          !terminal && (
            <span className="mono mute" style={{ fontSize: 11 }}>
              post a bounty on this issue from the Bounty tab
            </span>
          )
        )}

        <div style={{ flex: 1 }} />

        {locked ? (
          <span className="mono mute" style={{ fontSize: 11 }}>
            {terminal ? f.stateReason || STATE_LABEL[f.state]?.label : "triage paused"} <ProLock />
          </span>
        ) : terminal ? (
          <>
            <span className="mono mute" style={{ fontSize: 11 }}>
              {f.stateReason || STATE_LABEL[f.state]?.label}
            </span>
            <button className="btn ghost" disabled={busy === "reopen"} onClick={() => void patch({ action: "reopen" })}>
              Reopen
            </button>
          </>
        ) : confirm ? (
          <span className="vln-confirm">
            {confirm === "false_positive" ? "Mark false positive?" : "Accept this risk?"}
            <button className="vln-confirm-yes" onClick={() => void patch({ action: confirm })}>
              Confirm
            </button>
            /
            <button className="vln-confirm-no" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button className="btn ghost" onClick={() => setConfirm("false_positive")}>
              False positive
            </button>
            <button className="btn ghost" onClick={() => setConfirm("accept")}>
              Accept risk
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// ─── repo rail ────────────────────────────────────────────────────────────────

// Left-hand repo selector for the gate / policy subpages: lists every repo so
// the user can switch which one the body shows — one repo at a time, no
// all-at-once view. Each repo carries a gate-status dot (red = blocked,
// green = clear) for at-a-glance health.
const RepoRail = ({
  repos,
  value,
  onSelect,
}: {
  repos: SecurityRepoView[];
  value: string | undefined;
  onSelect: (id: string) => void;
}) => (
  <div className="vln-rail" role="tablist" aria-label="Repositories">
    {repos.map((r) => {
      const blocked = r.gate?.verdict === "fail";
      return (
        <button
          key={r.id}
          className={`vln-rail-item ${value === r.id ? "on" : ""}`}
          onClick={() => onSelect(r.id)}
          role="tab"
          aria-selected={value === r.id}
          title={`${r.owner}/${r.name}`}
        >
          <i className={`vln-rail-dot ${blocked ? "fail" : "pass"}`} />
          <span className="vln-rail-n">
            <span className="vln-rail-owner">{r.owner}/</span>
            {r.name}
          </span>
        </button>
      );
    })}
  </div>
);

// ─── merge gate ───────────────────────────────────────────────────────────────

// The merge gate is per-repo. The rail picks one repo; this resolves it (falling
// back to the first) and renders its full detail — rules, blocking findings, and
// the live scan terminal.
const GateView = ({
  overview,
  repoFilter,
  onOpen,
}: {
  overview: SecurityOverview;
  repoFilter: string | undefined;
  onOpen: (id: string) => void;
}) => {
  const repo = overview.repos.find((r) => r.id === repoFilter) ?? overview.repos[0];
  if (!repo) {
    return <div className="vln-empty">Connect a repository to see its merge gate.</div>;
  }
  return <GateRepoDetail repo={repo} overview={overview} onOpen={onOpen} />;
};

// Full single-repo gate: verdict, rules, and blocking findings.
const GateRepoDetail = ({
  repo,
  overview,
  onOpen,
}: {
  repo: SecurityRepoView;
  overview: SecurityOverview;
  onOpen: (id: string) => void;
}) => {
  const gate: GateResult = repo.gate;
  const blocking = overview.findings.filter((f) => gate.blockingFindingIds.includes(f.id));
  const blocked = gate.verdict === "fail";

  return (
    <div className="col gap-4" style={{ minWidth: 0 }}>
      <div className={`vln-verdict ${blocked ? "fail" : "pass"}`}>
        <div className="vln-verdict-icon">
          <Icon name={blocked ? "warn" : "check"} size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="vln-verdict-t">
            {blocked ? "MERGE BLOCKED" : "MERGE CLEAR"} · {repo.owner}/{repo.name}
          </div>
          <div className="vln-verdict-s">
            {blocked
              ? "Unresolved block-gated findings fail the devasign/security check on every open PR."
              : "All required gate rules pass — the devasign/security check reports success on open PRs."}{" "}
            Mark the <span className="mono" style={{ color: "var(--fg-dim)" }}>devasign/security</span> check
            as required on <span className="mono" style={{ color: "var(--fg-dim)" }}>{repo.defaultBranch}</span>{" "}
            to enforce it.
          </div>
        </div>
      </div>

      <div className="vln-pnl">
        <div className="vln-pnl-head">
          <h3 className="vln-pnl-t">Gate rules</h3>
          <div className="vln-pnl-s">
            {gate.rules.filter((r) => r.pass).length} of {gate.rules.length} passed
          </div>
        </div>
        <div>
          {gate.rules.map((r) => (
            <div key={r.id} className={`vln-rule ${r.pass ? "pass" : "fail"}`}>
              <span className="st">
                <Icon name={r.pass ? "check" : "x"} size={11} />
              </span>
              <span>
                {r.label} <code>· {r.count} found</code>
              </span>
              <span className={`vln-tag ${r.required ? "req" : ""}`}>
                {r.required ? "required" : "warn only"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="vln-pnl">
        <div className="vln-pnl-head">
          <h3 className="vln-pnl-t">Blocking findings</h3>
          <div className="vln-pnl-s">{blocking.length} blocking</div>
        </div>
        <div>
          {blocking.length === 0 && (
            <div className="vln-empty">Nothing blocking. Merges are clear.</div>
          )}
          {blocking.map((f) => (
            <div key={f.id} className="vln-blk">
              <SevPill sev={f.severity} />
              <div style={{ minWidth: 0 }}>
                <div className="vln-blk-t">{f.title}</div>
                <div className="vln-blk-l">
                  {displayId(f)} · {f.path}
                  {f.line ? `:${f.line}` : ""}
                  {f.bounty ? ` · bounty ${f.bounty.code} · ${f.bounty.amountUsdc} USDC` : ""}
                </div>
              </div>
              <button className="btn sm" onClick={() => onOpen(f.id)}>
                Review
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── scan policy ──────────────────────────────────────────────────────────────

const Tog = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
  <button
    className={`vln-sw ${on ? "" : "off"}`}
    onClick={onClick}
    disabled={disabled}
    aria-pressed={on}
  >
    <i />
  </button>
);

// Scan policy is per-repo. The rail picks one repo; this resolves it (falling
// back to the first) and edits that repo's policy.
const PolicyView = ({
  overview,
  repoFilter,
  refresh,
  locked,
}: {
  overview: SecurityOverview;
  repoFilter: string | undefined;
  refresh: () => Promise<void>;
  locked: boolean;
}) => {
  const repo = overview.repos.find((r) => r.id === repoFilter) ?? overview.repos[0];
  if (!repo) {
    return <div className="vln-empty">Connect a repository to configure its scan policy.</div>;
  }
  return <PolicyRepoEditor repo={repo} refresh={refresh} locked={locked} />;
};

const PolicyRepoEditor = ({
  repo,
  refresh,
  locked,
}: {
  repo: SecurityRepoView;
  refresh: () => Promise<void>;
  locked: boolean;
}) => {
  const [policy, setPolicy] = React.useState<RepoSecurityPolicy | null>(repo.policy ?? null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPolicy(repo.policy ?? null);
    setDirty(false);
    setErr(null);
  }, [repo.id]);

  if (!policy) {
    return <div className="vln-empty">Connect a repository to configure its scan policy.</div>;
  }

  const edit = (fn: (p: RepoSecurityPolicy) => RepoSecurityPolicy) => {
    if (locked) return; // controls are disabled too; this is the belt-and-braces
    setPolicy((p) => (p ? fn(p) : p));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await api.setSecurityPolicy(repo.id, policy);
      setPolicy(res.policy);
      setDirty(false);
      setSaved(true);
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const TRIGGERS: Array<{ k: keyof RepoSecurityPolicy["triggers"]; label: React.ReactNode; sub: string }> = [
    { k: "onMerge", label: <>audit every merge to <b>{repo.defaultBranch}</b></>, sub: "differential — only changed files pay" },
    { k: "onPrPush", label: "publish the devasign/security check on PRs", sub: "fails while block-gated findings exist" },
    { k: "nightly", label: "nightly sweep", sub: "cache-driven; unchanged repos cost nothing" },
    { k: "advisories", label: "dependency advisory feed", sub: "coming soon" },
  ];
  const ENGINES: Array<{ k: keyof RepoSecurityPolicy["engines"]; icon: string; n: string; d: string }> = [
    { k: "api", icon: "code", n: "API & backend", d: "authz · injection · tenant scoping · money paths" },
    { k: "frontend", icon: "globe", n: "Frontend", d: "DOM sinks · client-side secrets" },
    { k: "infra", icon: "terminal", n: "Infrastructure", d: "IaC · CI workflows · containers" },
    { k: "secrets", icon: "lock", n: "Secrets", d: "committed credentials, any file" },
    { k: "deps", icon: "git", n: "Dependencies", d: "manifests · lockfiles" },
  ];

  return (
    <div className="vln-pol">
      <div className="vln-pnl">
        <div className="vln-pnl-head">
          <h3 className="vln-pnl-t">Triggers {locked && <ProLock />}</h3>
          <div className="vln-pnl-s">{repo.owner}/{repo.name}</div>
        </div>
        <div>
          {TRIGGERS.map((t) => (
            <div key={t.k} className={`vln-eng ${policy.triggers[t.k] ? "" : "off"}`}>
              <span className="ico">
                <Icon name="play" size={13} />
              </span>
              <div>
                <div className="vln-eng-n">{t.label}</div>
                <div className="vln-eng-d">{t.sub}</div>
              </div>
              <Tog
                on={policy.triggers[t.k]}
                disabled={locked}
                onClick={() => edit((p) => ({ ...p, triggers: { ...p.triggers, [t.k]: !p.triggers[t.k] } }))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="vln-pnl">
        <div className="vln-pnl-head">
          <h3 className="vln-pnl-t">Engines</h3>
          <div className="vln-pnl-s">what the audit agent scans</div>
        </div>
        <div>
          {ENGINES.map((e) => (
            <div key={e.k} className={`vln-eng ${policy.engines[e.k] ? "" : "off"}`}>
              <span className="ico" style={{ color: policy.engines[e.k] ? "var(--accent)" : "var(--fg-faint)" }}>
                <Icon name={e.icon} size={14} />
              </span>
              <div>
                <div className="vln-eng-n">{e.n}</div>
                <div className="vln-eng-d">{e.d}</div>
              </div>
              <Tog
                on={policy.engines[e.k]}
                disabled={locked}
                onClick={() => edit((p) => ({ ...p, engines: { ...p.engines, [e.k]: !p.engines[e.k] } }))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="vln-pnl">
        <div className="vln-pnl-head">
          <h3 className="vln-pnl-t">Severity gates</h3>
          <div className="vln-pnl-s">block fails the check · warn shows · track is silent</div>
        </div>
        <div className="vln-gates">
          {SEVERITIES.map((sev) => (
            <div key={sev}>
              <SevPill sev={sev} />
              <div className="vln-gates-row">
                {(["block", "warn", "track"] as const).map((a) => {
                  // Critical can't be silently tracked (the backend refuses too).
                  const disabled = locked || (sev === "critical" && a === "track");
                  return (
                    <button
                      key={a}
                      className={`vln-gate-opt ${policy.gates[sev] === a ? "on" : ""}`}
                      disabled={disabled}
                      onClick={() => edit((p) => ({ ...p, gates: { ...p.gates, [sev]: a } }))}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {err && <div className="tu-notice">{err}</div>}
      <div className="flex items-center gap-3">
        {locked ? (
          <button className="btn primary" onClick={goUpgrade}>
            <Icon name="lock" size={12} /> Upgrade to edit the policy
          </button>
        ) : (
          <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save policy"}
          </button>
        )}
        {saved && !dirty && (
          <span className="mono" style={{ fontSize: 11, color: "var(--green)" }}>
            saved — gate republished across open PRs
          </span>
        )}
      </div>
    </div>
  );
};
