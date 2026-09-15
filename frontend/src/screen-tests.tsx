// @ts-nocheck
// Tests page — every test from the newest verify run of each PR, with evidence
// and the Adopt action. Pure logic lives in tests-view.ts.
import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "./icons";
import { api } from "./api";
import { useLiveTopic } from "./live-context";
import { RecordingBlock } from "./recording-block";
import { deletionCountdown, formatDuration } from "./verify-view";
import {
  EMPTY_FILTERS,
  browserBanner,
  categoryLabel,
  countRows,
  filterRows,
  markAdopted,
  markArchived,
  pickEvidence,
  repoOptions,
  soonestEvidenceExpiry,
  sortRows,
  statusLabel,
  statusTone,
  testDetail,
  testName,
} from "./tests-view";

const CATEGORY_CHIPS = [
  { key: null, label: "All" },
  { key: "e2e", label: "End-to-end" },
  { key: "unit", label: "Unit" },
];
const STATUS_CHIPS = [
  { key: "pass", label: "Passed" },
  { key: "fail", label: "Failed" },
  { key: "flaky", label: "Flaky" },
  { key: "not_run", label: "Not run" },
];
const ORIGIN_CHIPS = [
  { key: "generated", label: "Generated" },
  { key: "existing", label: "Existing" },
];

const shortSha = (sha) => (sha || "").slice(0, 7);
const when = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const TestsPage = ({ isMobile }) => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [filters, setFilters] = React.useState({ ...EMPTY_FILTERS, review: searchParams.get("review") });
  const [open, setOpen] = React.useState(null); // { key, focusArtifactId? }
  const [selected, setSelected] = React.useState(() => new Set()); // row keys
  const [archiveBusy, setArchiveBusy] = React.useState(false);

  const load = React.useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      setData(await api.verifyTests());
      setError(null);
    } catch (e) {
      setError(e?.message || "Couldn't load tests.");
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(false); }, [load]);
  useLiveTopic("verify", () => void load(true));

  // ?test=<testId> (with ?review=) opens that test once the rows arrive.
  React.useEffect(() => {
    const testId = searchParams.get("test");
    if (!testId || !data) return;
    const hit = data.rows.find((r) => r.testId === testId && (!filters.review || r.review.id === filters.review));
    if (hit) setOpen({ key: hit.key });
    searchParams.delete("test");
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = data ? sortRows(filterRows(data.rows, filters)) : [];
  const openRow = open && data ? data.rows.find((r) => r.key === open.key) : null;
  const reviewRow = filters.review && data ? data.rows.find((r) => r.review.id === filters.review) : null;
  const onAdopted = (key, adopted) => setData((d) => (d ? { ...d, rows: markAdopted(d.rows, key, adopted) } : d));
  const selectedShown = rows.filter((r) => selected.has(r.key));
  const allPicked = rows.length > 0 && selectedShown.length === rows.length;
  const toggle = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(rows.map((r) => r.key)));

  // Optimistic: flip the rows now, one request per PR, revert a PR's rows if it fails.
  const setArchived = async (targets, archived) => {
    const byReview = new Map();
    for (const r of targets) byReview.set(r.review.id, [...(byReview.get(r.review.id) || []), r.path]);
    setArchiveBusy(true);
    setData((d) => {
      if (!d) return d;
      let next = d.rows;
      for (const [reviewId, paths] of byReview) next = markArchived(next, reviewId, paths, archived);
      return { ...d, rows: next };
    });
    setSelected(new Set());
    const failed = [];
    await Promise.all([...byReview].map(async ([reviewId, paths]) => {
      try {
        await api.archiveTests(reviewId, paths, archived);
      } catch {
        failed.push([reviewId, paths]);
      }
    }));
    if (failed.length > 0) {
      setData((d) => {
        if (!d) return d;
        let next = d.rows;
        for (const [reviewId, paths] of failed) next = markArchived(next, reviewId, paths, !archived);
        return { ...d, rows: next };
      });
      setError(archived ? "Couldn't archive some tests. Try again." : "Couldn't restore some tests. Try again.");
    } else {
      setError(null);
    }
    setArchiveBusy(false);
  };
  const setView = (archived) => {
    set({ archived });
    setSelected(new Set());
  };

  if (loading && !data) {
    return (
      <div className="page">
        <div className="page-head"><div><h1 className="page-title">Tests</h1><div className="page-sub">loading…</div></div></div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="page">
        <div className="page-head"><div><h1 className="page-title">Tests</h1></div></div>
        <div className="tu-notice page-notice">{error} <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void load(false)}>Retry</button></div>
      </div>
    );
  }
  if (!data) return null;
  const c = countRows(data.rows);
  const banner = browserBanner(data.browserSetup);
  const filtered = filters.repo || filters.category || filters.status || filters.origin || filters.review || filters.archived || filters.q.trim();

  return (
    <div className="page vln-page">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-title">Tests</h1>
          <div className="page-sub">Tests DevAsign generated or ran to verify your pull requests.</div>
        </div>
      </div>
      {banner && (
        <div className="tu-notice page-notice" style={{ marginBottom: 12 }} title={banner.repos.join(", ")}>
          <Icon name="warn" size={13} />
          <span>
            {banner.text} —{" "}
            <a href={banner.href} onClick={(e) => { e.preventDefault(); navigate(banner.href); }}>{banner.action}</a>
          </span>
        </div>
      )}
      {error && <div className="tu-notice page-notice" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="vln-stats tst-stats">
        <div className="vln-stat"><div className="k">tests ran</div><div className="vln-stat-row"><div className="v">{c.ran}</div><div className="d">of {data.rows.length - c.archived} planned</div></div></div>
        <div className="vln-stat"><div className="k">end-to-end</div><div className="vln-stat-row"><div className="v">{c.e2e}</div></div></div>
        <div className="vln-stat"><div className="k">unit</div><div className="vln-stat-row"><div className="v">{c.unit}</div></div></div>
        <div className="vln-stat"><div className="k">passed</div><div className="vln-stat-row"><div className="v" style={{ color: c.passed > 0 ? "var(--green)" : undefined }}>{c.passed}</div></div></div>
        <div className={`vln-stat ${c.failed > 0 ? "alarm" : ""}`}><div className="k">failed</div><div className="vln-stat-row"><div className="v">{c.failed}</div></div></div>
      </div>
      {data.truncated && <div className="mute mono" style={{ fontSize: 11, marginBottom: 10 }}>Showing the newest 300 runs.</div>}

      {data.rows.length === 0 ? (
        <div className="vln-empty">
          <div>No verify runs yet.</div>
          <div className="mute" style={{ marginTop: 4 }}>Runs appear after the DevAsign verifier runs in a pull request's CI.</div>
        </div>
      ) : (
        <div className="vln-pnl">
          <div className="vln-pnl-head vln-pnl-head-wrap">
            <div className="tst-filters">
              <div className="vln-chips">
                {CATEGORY_CHIPS.map((ch) => (
                  <button key={String(ch.key)} className={`vln-chip ${filters.category === ch.key ? "on" : ""}`} onClick={() => set({ category: ch.key })}>{ch.label}</button>
                ))}
              </div>
              <div className="vln-chips">
                {STATUS_CHIPS.map((ch) => (
                  <button key={ch.key} className={`vln-chip ${filters.status === ch.key ? "on" : ""}`} onClick={() => set({ status: filters.status === ch.key ? null : ch.key })}>{ch.label}</button>
                ))}
              </div>
              <div className="vln-chips">
                {ORIGIN_CHIPS.map((ch) => (
                  <button key={ch.key} className={`vln-chip ${filters.origin === ch.key ? "on" : ""}`} onClick={() => set({ origin: filters.origin === ch.key ? null : ch.key })}>{ch.label}</button>
                ))}
              </div>
              <span className="tst-divider" aria-hidden="true" />
              <button
                className={`vln-chip tst-archived-chip ${filters.archived ? "on" : ""}`}
                aria-pressed={filters.archived}
                title={filters.archived ? "Back to active tests" : "Show archived tests"}
                onClick={() => setView(!filters.archived)}
              >
                <Icon name="archive" size={11} /> Archived <b>{c.archived}</b>
              </button>
              {reviewRow && (
                <button className="vln-chip on" onClick={() => { set({ review: null }); searchParams.delete("review"); setSearchParams(searchParams, { replace: true }); }} title="Clear">
                  PR #{reviewRow.review.prNumber} <Icon name="x" size={10} />
                </button>
              )}
            </div>
            <div className="vln-head-right">
              <select className="select" style={{ width: "auto", minWidth: 150, paddingRight: 28 }} value={filters.repo || "all"} onChange={(e) => set({ repo: e.target.value === "all" ? null : e.target.value })}>
                <option value="all">All repositories</option>
                {repoOptions(data.rows).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <div className="vln-search">
                <Icon name="search" size={13} />
                <input className="input bare" type="search" placeholder="Search tests, repos, PRs…" aria-label="Search tests" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
                {filters.q !== "" && (
                  <button className="vln-search-x" aria-label="Clear search" onClick={() => set({ q: "" })}><Icon name="x" size={11} /></button>
                )}
              </div>
            </div>
          </div>

          {(selectedShown.length > 0 || filters.archived) && (
            <div className="tst-selbar">
              {selectedShown.length > 0 ? (
                <>
                  <span className="mono" style={{ fontSize: 11 }}>{selectedShown.length} selected</span>
                  <button className="btn sm" disabled={archiveBusy} onClick={() => void setArchived(selectedShown, !filters.archived)}>
                    <Icon name="archive" size={12} /> {filters.archived ? "Restore" : "Archive"}
                  </button>
                  <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
                </>
              ) : (
                <span className="mono mute" style={{ fontSize: 11 }}>Viewing archived tests. Select tests to restore them to the list.</span>
              )}
            </div>
          )}
          <div className="tst-table">
          <div className="tst-head">
            <span className="vln-fx-sel">
              <input
                type="checkbox"
                aria-label="Select all shown tests"
                checked={allPicked}
                disabled={rows.length === 0}
                ref={(el) => { if (el) el.indeterminate = !allPicked && selectedShown.length > 0; }}
                onChange={toggleAll}
              />
            </span>
            <span>test</span>
            <span>type</span>
            <span>repository</span>
            <span>pr</span>
            <span>status</span>
            <span>evidence</span>
            <span>action</span>
          </div>
          {rows.map((r) => (
            <TestRow key={r.key} r={r} picked={selected.has(r.key)} onToggle={() => toggle(r.key)} onOpen={(focusArtifactId) => setOpen({ key: r.key, focusArtifactId })} onAdopted={onAdopted} navigate={navigate} />
          ))}
          </div>
          {rows.length === 0 && (
            <div className="vln-empty">
              <div>{filters.archived && c.archived === 0 ? "No archived tests." : "No tests match these filters."}</div>
              {filtered && !(filters.archived && c.archived === 0) && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => { setFilters(EMPTY_FILTERS); searchParams.delete("review"); setSearchParams(searchParams, { replace: true }); }}>Clear filters</button>}
            </div>
          )}
        </div>
      )}

      {openRow && (
        <TestDrawer row={openRow} focusArtifactId={open.focusArtifactId} onClose={() => setOpen(null)} onAdopted={onAdopted} onArchive={(archived) => void setArchived([openRow], archived)} archiveBusy={archiveBusy} />
      )}
    </div>
  );
};

const TestRow = ({ r, picked, onToggle, onOpen, onAdopted, navigate }) => (
  <div className={`tst-row ${r.status}`} onClick={() => onOpen(undefined)}>
    <span className="vln-fx-sel" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" aria-label={`Select ${testName(r.path)}`} checked={picked} onChange={onToggle} />
    </span>
    <div className="tst-name">
      <span className="vln-fx-t">{testName(r.path)}</span>
      <span className="vln-fx-l" title={r.path}>{r.path}{r.origin === "existing" ? " · existing" : ""}</span>
    </div>
    <span className="tst-cat" title={r.level}>{categoryLabel(r.category)}</span>
    <span className="vln-fx-repo" title={r.repo.name}>{r.repo.name}</span>
    <a className="tst-pr" href={`/reviews/${r.review.id}`} title={r.review.prTitle} onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/reviews/${r.review.id}`); }}>#{r.review.prNumber}</a>
    <span className={`pill ${statusTone(r.status)}`}><i className="dot"></i> {statusLabel(r.status)}</span>
    <div className="tst-ev" onClick={(e) => e.stopPropagation()}>
      {pickEvidence(r).map((ev) => (
        <button key={ev.artifactId} type="button" className={`tst-ev-btn ${ev.expired ? "expired" : ""}`} title={ev.expired ? `${ev.kind} expired` : `View ${ev.kind}`} onClick={() => onOpen(ev.artifactId)}>
          {ev.kind}
        </button>
      ))}
      {r.evidence.length === 0 && <span className="mono mute" style={{ fontSize: 10 }}>—</span>}
    </div>
    <div onClick={(e) => e.stopPropagation()}>
      <AdoptAction r={r} onAdopted={onAdopted} />
    </div>
  </div>
);

// One-click "Adopt": opens a PR committing the generated test into the repo.
const AdoptAction = ({ r, onAdopted, size = "sm" }) => {
  const [state, setState] = React.useState(null); // null | "busy" | { error }
  if (r.origin !== "generated") return <span className="mono mute" style={{ fontSize: 10 }}>in repo</span>;
  if (r.adopted) {
    return <a className="tst-adopted" href={r.adopted.prUrl} target="_blank" rel="noreferrer">PR #{r.adopted.prNumber} opened <Icon name="external" size={10} /></a>;
  }
  if (r.status === "not_run") return <span className="mono mute" style={{ fontSize: 10 }}>—</span>;
  const adopt = async () => {
    setState("busy");
    try {
      const out = await api.adoptTests(r.review.id, r.run.id, [r.testId]);
      if (out.status === "opened" && out.prUrl) {
        onAdopted(r.key, { prUrl: out.prUrl, prNumber: out.prNumber ?? 0, at: Date.now() });
        setState(null);
      } else {
        setState({ error: out.reason || out.status });
      }
    } catch (e) {
      setState({ error: e?.message || "failed" });
    }
  };
  return (
    <button type="button" className={`btn ${size} ghost`} disabled={state === "busy"} title="Open a PR that adds this test to the repository's own suite" onClick={adopt}>
      {state === "busy" ? "Opening PR…" : state?.error ? `Failed: ${state.error}` : "Adopt"}
    </button>
  );
};

const TestDrawer = ({ row, focusArtifactId, onClose, onAdopted, onArchive, archiveBusy }) => {
  const navigate = useNavigate();
  const [runId, setRunId] = React.useState(row.run.id);
  const [view, setView] = React.useState(null);
  const [runs, setRuns] = React.useState([]);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fetchView = React.useCallback(async () => {
    try {
      const v = await api.verifyRun(row.review.id, runId);
      setView(v.latest);
      setRuns(v.runs || []);
      setErr(null);
    } catch (e) {
      setErr(e?.message || "Couldn't load this run.");
    }
  }, [row.review.id, runId]);
  React.useEffect(() => { void fetchView(); }, [fetchView]);

  const d = testDetail(view, row.testId);
  const evidenceExpiry = d ? soonestEvidenceExpiry(d) : null;
  const current = runId === row.run.id;
  const adoptRow = d?.test.adopted && !row.adopted ? { ...row, adopted: d.test.adopted } : row;

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono mute" style={{ fontSize: 11 }}>{row.repo.name} · PR #{row.review.prNumber}</div>
            <div className="drawer-title">{testName(row.path)}</div>
            <div className="mono mute" style={{ fontSize: 11, marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className={`pill ${statusTone(row.status)}`}><i className="dot"></i> {statusLabel(row.status)}</span>
              <span>{row.level} · {row.runner}{row.origin === "existing" ? " · existing test" : " · generated"}</span>
              {row.archived && <span className="pill mute">archived</span>}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        </div>

        <div className="drawer-body">
          {err && <div className="tu-notice page-notice" style={{ marginBottom: 12 }}>{err}</div>}
          {!view && !err && <div className="mono mute" style={{ fontSize: 12 }}>loading…</div>}
          {view && !d && <div className="mono mute" style={{ fontSize: 12 }}>This test was not part of the selected run.</div>}
          {d && (
            <>
              <div className="drawer-section">
                <div className="drawer-label">what it checks</div>
                {d.criteria.length === 0 && <div className="mono mute" style={{ fontSize: 12 }}>No acceptance criteria linked.</div>}
                {d.criteria.map((cr) => (
                  <div key={cr.id} className="tst-crit">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{cr.text}</div>
                      {cr.reason && <div className="mono mute" style={{ fontSize: 11.5, marginTop: 3 }}>{cr.reason}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="drawer-section">
                <div className="drawer-label">result</div>
                {!d.result ? (
                  <div className="mono mute" style={{ fontSize: 12 }}>The runner did not report a result for this test.</div>
                ) : (
                  <>
                    {d.result.error && <pre className="vln-code" style={{ marginBottom: 10, whiteSpace: "pre-wrap" }}>{d.result.error}</pre>}
                    <table className="tst-attempts">
                      <thead><tr><th>attempt</th><th>status</th><th>duration</th><th>error</th></tr></thead>
                      <tbody>
                        {d.result.attempts.map((a) => (
                          <tr key={a.n}>
                            <td>{a.n}</td>
                            <td><span className={`pill ${statusTone(a.status)}`}><i className="dot"></i> {statusLabel(a.status)}</span></td>
                            <td>{formatDuration(a.durationMs)}</td>
                            <td style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{a.error || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>

              <div className="drawer-section">
                <div className="drawer-label">evidence</div>
                {evidenceExpiry != null && (
                  <div className="mono mute tst-retention">Evidence is kept for 30 days — {deletionCountdown(evidenceExpiry, Date.now())}.</div>
                )}
                {d.recordings.length === 0 && d.others.length === 0 && <div className="mono mute" style={{ fontSize: 12 }}>No recordings or logs were uploaded for this test.</div>}
                {d.recordings.map((rec) => (
                  <RecordingBlock key={rec.artifactId} rec={rec} testName={testName(row.path)} durationMs={d.result?.durationMs || 0} initiallyOpen={focusArtifactId ? rec.artifactId === focusArtifactId : rec === d.recordings[d.recordings.length - 1]} onStale={fetchView} />
                ))}
                {d.others.length > 0 && (
                  <div className="row" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, height: "auto", padding: "8px 0", border: 0 }}>
                    {d.others.map((o) => o.getUrl
                      ? <a key={o.artifactId} className={`btn sm ghost ${o.artifactId === focusArtifactId ? "is-active" : ""}`} href={o.getUrl} target="_blank" rel="noreferrer">{o.kind}{o.attempt ? ` · attempt ${o.attempt}` : ""} <Icon name="external" size={10} /></a>
                      : <span key={o.artifactId} className="pill nit">{o.kind} expired</span>
                    )}
                  </div>
                )}
              </div>

              <div className="drawer-section">
                <div className="drawer-label">run</div>
                <div className="kv-grid tst-kv" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
                  <div className="kv"><div className="kv-k">pull request</div><div className="kv-v mono" style={{ fontSize: 12 }}><a href={`/reviews/${row.review.id}`} onClick={(e) => { e.preventDefault(); navigate(`/reviews/${row.review.id}`); }}>#{row.review.prNumber} {row.review.prTitle}</a></div></div>
                  <div className="kv"><div className="kv-k">commit</div><div className="kv-v mono" style={{ fontSize: 12 }}>{shortSha(view.run.sha)}</div></div>
                  <div className="kv"><div className="kv-k">run status</div><div className="kv-v mono" style={{ fontSize: 12 }}>{view.run.status}</div></div>
                  <div className="kv"><div className="kv-k">ran</div><div className="kv-v mono" style={{ fontSize: 12 }}>{when(view.run.createdAt)}</div></div>
                  <div className="kv"><div className="kv-k">test file</div><div className="kv-v mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{d.test.path}</div></div>
                  <div className="kv"><div className="kv-k">check run</div><div className="kv-v mono" style={{ fontSize: 12 }}>{view.report?.checkRunUrl ? <a href={view.report.checkRunUrl} target="_blank" rel="noreferrer">open on GitHub</a> : "—"}</div></div>
                </div>
              </div>

              {runs.length > 1 && (
                <div className="drawer-section">
                  <div className="drawer-label">earlier runs of this pull request</div>
                  <div className="tst-runs">
                    {runs.map((r) => (
                      <button key={r.id} type="button" className={`tst-run ${r.id === runId ? "on" : ""}`} onClick={() => setRunId(r.id)}>
                        <span>{shortSha(r.sha)}</span>
                        <span>attempt {r.attempt}</span>
                        <span>{r.status}</span>
                        <span className="mute">{when(r.createdAt)}</span>
                        {r.id === row.run.id && <span className="mute">· latest</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer-foot">
          <span className="mono mute" style={{ fontSize: 11 }}>
            {row.origin === "generated" ? (adoptRow.adopted ? "Adopted into the repository's suite" : current ? "Generated by DevAsign for this PR" : "Adopt from the latest run") : "Part of the repository's own suite"}
          </span>
          <div className="drawer-foot-actions">
            {current && <AdoptAction r={adoptRow} onAdopted={onAdopted} size="" />}
            <button className="btn ghost" disabled={archiveBusy} onClick={() => onArchive(!row.archived)}>
              <Icon name="archive" size={13} /> {row.archived ? "Restore" : "Archive"}
            </button>
            <a className="btn" href={`/reviews/${row.review.id}`} onClick={(e) => { e.preventDefault(); navigate(`/reviews/${row.review.id}`); }}><Icon name="agent" size={13} /> Open review</a>
          </div>
        </div>
      </div>
    </div>
  );
};
