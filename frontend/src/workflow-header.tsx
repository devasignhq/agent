// @ts-nocheck
// Workflow header widgets: the repo picker rendered inside the breadcrumb and
// the selected repo's details (reviews, flake, verification setup) on the right.
import React from "react";
import { Icon } from "./icons";
import { api, type Repository } from "./api";

export type WorkflowHeaderState = {
  repos: Repository[];
  repoId: string;
  repo: Repository | null;
  select: (id: string) => void;
};

function usePopover(open: boolean, onClose: () => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Deferred so the click that opened the popover doesn't close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  return ref;
}

export function RepoPicker({ repos, repoId, repo, select }: WorkflowHeaderState) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const close = React.useCallback(() => setOpen(false), []);
  const ref = usePopover(open, close);
  const searchable = repos.length > 6;
  const needle = q.trim().toLowerCase();
  const shown = needle ? repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(needle)) : repos;

  return (
    <div ref={ref} className="wf-repo-pick">
      <button
        type="button"
        className={`wf-repo-btn ${open ? "is-open" : ""}`}
        onClick={() => { setOpen((o) => !o); setQ(""); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={repos.length === 0}
        title={repo ? `${repo.owner}/${repo.name}` : undefined}
      >
        <Icon name="github" size={12} />
        <span className="wf-repo-btn-name">
          {repo ? <><span className="wf-repo-owner">{repo.owner}/</span>{repo.name}</> : repos.length === 0 ? "No repositories" : "Select repository"}
        </span>
        <Icon name="chevron-d" size={11} />
      </button>
      {open && (
        <div className="wf-repo-menu" role="listbox" aria-label="Repositories">
          {searchable && (
            <div className="wf-repo-search">
              <Icon name="search" size={12} />
              <input autoFocus className="input bare" placeholder="Filter repositories…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="wf-repo-list">
            {shown.length === 0 && <div className="wf-repo-none mute">No matches.</div>}
            {shown.map((r) => {
              const s = r.reviewStats;
              const picked = r.id === repoId;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`wf-repo-opt ${picked ? "is-picked" : ""}`}
                  onClick={() => { select(r.id); close(); }}
                >
                  <span className="wf-repo-opt-name"><span className="wf-repo-owner">{r.owner}/</span>{r.name}</span>
                  <span className="wf-repo-opt-meta">
                    {s ? `${s.total} ${s.total === 1 ? "review" : "reviews"}` : ""}
                    {picked && <Icon name="check" size={11} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const VERIFY_LABEL = {
  verified: "verified",
  pr_merged: "awaiting first run",
  pr_open: "setup PR open",
  pr_closed: "setup PR closed",
  none: "not set up",
};

// Never re-opens a PR the user closed themselves; "Update workflow" is the only
// way an onboarded repo gets a refreshed workflow.
function VerifySetupPanel({ repo }: { repo: Repository }) {
  const [setup, setSetup] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [mode, setMode] = React.useState("separate");
  const [workflow, setWorkflow] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(
    () => api.verifySetup(repo.id).then((s) => { setSetup(s); setFailed(false); }).catch(() => setFailed(true)),
    [repo.id]
  );
  React.useEffect(() => { void load(); }, [load]);

  if (!setup) {
    return <div className="wf-verify-body mute mono" style={{ fontSize: 11 }}>{failed ? "Couldn't load verification setup." : "loading…"}</div>;
  }
  const ob = setup.onboarding || { state: "none" };
  const workflows = setup.detected?.existingWorkflows || [];
  const frameworks = (setup.detected?.frameworks || []).map((f) => f.name).join(", ");
  const pillClass = ob.state === "verified" ? "ok" : ob.state === "pr_open" || ob.state === "pr_merged" ? "info" : "nit";
  const stateText =
    ob.state === "verified" ? "verified, a run succeeded" :
    ob.state === "pr_merged" ? "workflow merged, waiting for the first run" :
    ob.state === "pr_open" ? `setup PR #${ob.prNumber} open` :
    ob.state === "pr_closed" ? `setup PR #${ob.prNumber} was closed` : "not set up";
  const submit = async () => {
    setBusy(true);
    try {
      await api.requestSetupPr(repo.id, { mode, workflow: workflow || undefined });
      setTimeout(() => { void load(); setBusy(false); }, 2500);
    } catch { setBusy(false); }
  };

  return (
    <div className="wf-verify-body">
      <div className="wf-verify-row">
        <span className={`pill ${pillClass}`}>{stateText}</span>
        {ob.prUrl && <a className="wf-verify-link" href={ob.prUrl} target="_blank" rel="noreferrer">open PR <Icon name="external" size={10} /></a>}
      </div>
      {setup.detected && (
        <dl className="wf-verify-facts">
          <dt>Stack</dt><dd>{frameworks || "no test framework (bundled runner)"}</dd>
          <dt>App start</dt>
          <dd>{setup.devasignYml?.start ? <span className="mono">{setup.devasignYml.start}</span> : <span className="t-warn">not configured. Set verify.start and verify.url in .devasign.yml to enable browser tests</span>}</dd>
        </dl>
      )}
      {ob.missingSecrets && ob.missingSecrets.length > 0 && <div className="wf-verify-warn">missing secrets: {ob.missingSecrets.join(", ")}</div>}
      {ob.lastDiagnosis && <div className="wf-verify-warn">setup needs attention: {ob.lastDiagnosis.message}</div>}
      {ob.lastError && <div className="wf-verify-warn">{ob.lastError}</div>}
      <div className="wf-verify-actions">
        {ob.state !== "verified" && (
          <>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="separate">separate workflow</option>
              {workflows.length > 0 && <option value="extend">add a step to an existing workflow</option>}
            </select>
            {mode === "extend" && (
              <select className="input" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                <option value="">pick a workflow</option>
                {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            )}
          </>
        )}
        <button type="button" className="btn sm primary" disabled={busy} onClick={submit}>
          {busy ? "Opening…" : ob.state === "none" ? "Open setup PR" : ob.state === "verified" ? "Update workflow" : "Regenerate setup PR"}
        </button>
      </div>
    </div>
  );
}

export function RepoDetails({ repo }: { repo: Repository }) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const ref = usePopover(open, close);
  const s = repo.reviewStats;
  const flake = repo.flakeRate && repo.flakeRate.total > 0 ? repo.flakeRate : null;
  const state = repo.verify?.onboarding?.state || "none";

  return (
    <div className="wf-head-details">
      {s && (
        <span className="wf-head-stat" title={`${s.approved} approved · ${s.blocked} blocked`}>
          <b>{s.total}</b> {s.total === 1 ? "review" : "reviews"}
          <span className="wf-head-sep" />
          <span className="wf-stat-ok">✓ {s.approved}</span>
          <span className="wf-stat-blk">✕ {s.blocked}</span>
        </span>
      )}
      {flake && (
        <span className={`wf-head-stat ${flake.rate > 0.1 ? "t-warn" : ""}`} title="Quarantined generated tests over the last 30 verification runs">
          flake <b>{Math.round(flake.rate * 100)}%</b>
        </span>
      )}
      <div ref={ref} className="wf-verify">
        <button
          type="button"
          className={`btn ghost sm wf-verify-btn ${open ? "is-active" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Verification setup: ${VERIFY_LABEL[state] || state}`}
          title={`Verification: ${VERIFY_LABEL[state] || state}`}
        >
          <i className={`wf-verify-dot ${state}`} />
          <span>Verification</span>
          <span className="wf-verify-state">{VERIFY_LABEL[state] || state}</span>
          <Icon name="chevron-d" size={11} />
        </button>
        {open && (
          <div className="wf-verify-pop" role="dialog" aria-label="Verification setup">
            <div className="wf-verify-head">
              <span className="wf-verify-title">verification setup</span>
              <span className="mute mono" style={{ fontSize: 10 }}>{repo.owner}/{repo.name}</span>
            </div>
            <VerifySetupPanel key={repo.id} repo={repo} />
          </div>
        )}
      </div>
      <span className="wf-head-sep" aria-hidden="true" />
    </div>
  );
}
