// @ts-nocheck
// Workflow screen — visualize and customize the per-repo review pipeline.
//
// The pipeline DevAsign already runs on every PR is surfaced here as an ordered
// sequence of stages. Mandatory stages always run; optional stages (holistic /
// DEVASIGN.md docs / deferral scan) toggle on/off — that's the BASIC (free)
// tier. The entry-trigger policy and verdict mode are ADVANCED (Pro/Max): free
// users see them locked with an upgrade nudge. Saves are optimistic and persist
// per repo via PUT /api/repositories/:id/workflow.
import React from "react";
import { Icon } from "./icons";
import { api, type Repository, type RepoWorkflow } from "./api";
import { useAuth } from "./auth-context";

// Canonical pipeline stages, in run order. `mandatory` stages always run;
// `key` maps an optional stage to its RepoWorkflow.stages flag.
const STAGES = [
  { id: "ingest", name: "Ingest context", icon: "doc", mandatory: true,
    desc: "Pull the diff, linked tickets, attached Looms & design frames." },
  { id: "criteria", name: "Synthesize criteria", icon: "brain", mandatory: true,
    desc: "Derive the end goal & acceptance criteria the PR must meet." },
  { id: "review", name: "Review diff", icon: "code", mandatory: true,
    desc: "Check the diff against each acceptance criterion." },
  { id: "holistic", name: "Whole-repo review", icon: "git", key: "holistic",
    desc: "Check the change against the repo index for regressions, critical errors & security flaws." },
  { id: "deferrals", name: "Deferred-work scan", icon: "warn", key: "deferrals",
    desc: "Catch self-admitted punts — TODOs, stubs, NotImplemented buried in the diff." },
  { id: "docs", name: "DEVASIGN.md guidance", icon: "doc", key: "docs",
    desc: "Enforce your repo conventions & flag docs the change makes outdated." },
  { id: "verdict", name: "Post verdict", icon: "check", mandatory: true,
    desc: "Post the Check Run + PR review and notify your connected integrations." },
];

// One-click presets (advanced). Strict = maximum rigor; Balanced = quieter
// defaults; Light = lean + advisory (never blocks the merge).
const TEMPLATES: Record<string, Omit<RepoWorkflow, "version">> = {
  strict: {
    trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
    stages: { holistic: true, docs: true, deferrals: true },
    verdict: { blocking: true },
  },
  balanced: {
    trigger: { onSynchronize: true, skipDrafts: true, skipBots: true },
    stages: { holistic: true, docs: true, deferrals: true },
    verdict: { blocking: true },
  },
  light: {
    trigger: { onSynchronize: false, skipDrafts: true, skipBots: true },
    stages: { holistic: false, docs: true, deferrals: false },
    verdict: { blocking: false },
  },
};

const goUpgrade = () =>
  (window.location.href = `${window.location.origin}/?billing=upgrade`);

const Toggle = ({ on, onClick, locked = false }) => (
  <div
    className={`tog sm ${on ? "on" : ""}`}
    style={{ cursor: "pointer", ...(locked ? { opacity: 0.45 } : {}) }}
    role="switch"
    aria-checked={!!on}
    onClick={onClick}
  />
);

const ProLock = () => (
  <span className="pill purple" title="Pro/Max feature" style={{ fontSize: 10 }}>
    <Icon name="lock" size={9} /> Pro
  </span>
);

const WorkflowPage = () => {
  const { user } = useAuth();
  const [repos, setRepos] = React.useState<Repository[]>([]);
  const [repoId, setRepoId] = React.useState<string>("");
  const [wf, setWf] = React.useState<RepoWorkflow | null>(null);
  const [advancedLocked, setAdvancedLocked] = React.useState(
    (user?.plan || "free") === "free"
  );
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  // Load the user's repos once; default to the first.
  React.useEffect(() => {
    let alive = true;
    api
      .repositories()
      .then((rs) => {
        if (!alive) return;
        setRepos(rs);
        setRepoId((cur) => cur || rs[0]?.id || "");
        if (rs.length === 0) setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Load the selected repo's workflow whenever the selection changes.
  React.useEffect(() => {
    if (!repoId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .repoWorkflow(repoId)
      .then((v) => {
        if (!alive) return;
        setWf(v.workflow);
        setAdvancedLocked(v.advancedLocked);
      })
      .catch((e) => alive && setErr(e?.message || "Couldn't load workflow"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoId]);

  // Optimistic save: paint `next` immediately, persist, revert on failure.
  const save = React.useCallback(
    async (next: RepoWorkflow) => {
      if (!repoId) return;
      const prev = wf;
      setWf(next);
      setErr(null);
      try {
        await api.setRepoWorkflow(repoId, next);
      } catch (e: any) {
        setWf(prev); // revert
        setErr(
          e?.message === "upgrade_required"
            ? "That control is a Pro/Max feature."
            : e?.message || "Couldn't save — reverted."
        );
      }
    },
    [repoId, wf]
  );

  // Basic (free): toggle which optional stages run.
  const toggleStage = (key: string) =>
    wf && save({ ...wf, stages: { ...wf.stages, [key]: !wf.stages[key] } });

  // Advanced (paid): trigger policy + verdict mode. Locked → upgrade nudge.
  const toggleTrigger = (key: string) => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, trigger: { ...wf.trigger, [key]: !wf.trigger[key] } });
  };
  const toggleBlocking = () => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, verdict: { blocking: !wf.verdict.blocking } });
  };
  const applyTemplate = (name: string) => {
    if (advancedLocked) return goUpgrade();
    save({ version: 1, ...TEMPLATES[name] });
  };

  const repo = repos.find((r) => r.id === repoId);

  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Workflow</h1>
          <div className="page-sub">
            Customize how DevAsign reviews each repository
          </div>
        </div>
        {repos.length > 0 && (
          <select
            className="input"
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            style={{ maxWidth: 280, fontFamily: "var(--mono)", fontSize: 12 }}
            aria-label="Repository"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {repos.length === 0 && !loading && (
        <div className="card">
          <div className="card-body mute" style={{ fontSize: 13 }}>
            No repositories connected yet. Install the DevAsign GitHub App under{" "}
            <span className="mono" style={{ color: "var(--fg)" }}>
              Settings → Repository
            </span>{" "}
            to start customizing review workflows.
          </div>
        </div>
      )}

      {err && (
        <div
          className="mute"
          style={{ color: "var(--danger)", fontSize: 12, marginBottom: 12 }}
        >
          {err}
        </div>
      )}

      {repo && wf && (
        <>
          {/* Templates (advanced) */}
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              <h3 className="card-title">Templates</h3>
              {advancedLocked && <ProLock />}
            </div>
            <div className="card-body">
              <div className="mute" style={{ fontSize: 12, marginBottom: 12 }}>
                Apply a starter preset, then fine-tune below.
              </div>
              <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                {[
                  ["strict", "Strict", "Review everything · block on issues"],
                  ["balanced", "Balanced", "Quieter defaults · skip bots & drafts"],
                  ["light", "Light", "Lean · advisory only (never blocks)"],
                ].map(([id, name, tag]) => (
                  <button
                    key={id}
                    className="btn ghost"
                    onClick={() => applyTemplate(id)}
                    style={{
                      flexDirection: "column",
                      alignItems: "flex-start",
                      height: "auto",
                      padding: "10px 14px",
                      ...(advancedLocked ? { opacity: 0.6 } : {}),
                    }}
                  >
                    <span className="mono" style={{ fontSize: 12 }}>
                      {name}
                    </span>
                    <span className="mute" style={{ fontSize: 11 }}>
                      {tag}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Trigger (entry node, advanced) */}
          <div className={`card wf-node ${advancedLocked ? "wf-locked" : ""}`}>
            <div className="card-head">
              <div className="flex items-center gap-2">
                <span className="wf-ico" style={{ color: "var(--accent)" }}>
                  <Icon name="play" size={13} />
                </span>
                <h3 className="card-title">New PR — trigger</h3>
              </div>
              {advancedLocked ? (
                <span
                  className="mono"
                  style={{ fontSize: 11, cursor: "pointer", color: "var(--accent)" }}
                  onClick={goUpgrade}
                >
                  Upgrade to edit →
                </span>
              ) : (
                <span className="pill ok" style={{ fontSize: 10 }}>
                  <i className="dot"></i> entry
                </span>
              )}
            </div>
            <div className="card-body col gap-2">
              {[
                ["onSynchronize", "Re-review on new pushes", "Re-run when commits are pushed to an open PR"],
                ["skipDrafts", "Skip draft PRs", "Ignore drafts until they're marked ready for review"],
                ["skipBots", "Skip bot PRs", "Ignore Dependabot / Renovate / other bot authors"],
              ].map(([key, name, desc]) => (
                <label key={key} className="flex items-center gap-3 wf-row">
                  <Toggle
                    on={wf.trigger[key]}
                    locked={advancedLocked}
                    onClick={() => toggleTrigger(key)}
                  />
                  <span className="mono" style={{ fontSize: 12, minWidth: 180 }}>
                    {name}
                  </span>
                  <span className="mute" style={{ fontSize: 12 }}>
                    {desc}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Pipeline stages */}
          {STAGES.map((s) => {
            const optional = !s.mandatory && s.key;
            const on = optional ? wf.stages[s.key] : true;
            return (
              <React.Fragment key={s.id}>
                <div className="wf-connector" />
                <div className={`card wf-node ${optional && !on ? "wf-off" : ""}`}>
                  <div className="card-body flex items-center gap-3">
                    <span
                      className="wf-ico"
                      style={{ color: on ? "var(--accent)" : "var(--fg-mute)" }}
                    >
                      <Icon name={s.icon} size={14} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 13 }}>
                        {s.name}
                      </div>
                      <div className="mute" style={{ fontSize: 12, marginTop: 2 }}>
                        {s.desc}
                      </div>
                      {/* Verdict node carries the blocking-vs-advisory control (advanced). */}
                      {s.id === "verdict" && (
                        <label
                          className="flex items-center gap-2"
                          style={{ marginTop: 8 }}
                        >
                          <Toggle
                            on={wf.verdict.blocking}
                            locked={advancedLocked}
                            onClick={toggleBlocking}
                          />
                          <span className="mono" style={{ fontSize: 12 }}>
                            Block merge on changes requested
                          </span>
                          {advancedLocked ? (
                            <ProLock />
                          ) : (
                            <span className="mute" style={{ fontSize: 11 }}>
                              {wf.verdict.blocking
                                ? "REQUEST_CHANGES gates the PR"
                                : "advisory COMMENT — never blocks"}
                            </span>
                          )}
                        </label>
                      )}
                    </div>
                    {s.mandatory ? (
                      <span
                        className="pill"
                        style={{ fontSize: 10, color: "var(--fg-mute)" }}
                      >
                        <i className="dot"></i> always on
                      </span>
                    ) : (
                      <Toggle on={on} onClick={() => toggleStage(s.key)} />
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </>
      )}

      {loading && repos.length > 0 && (
        <div className="mute mono" style={{ fontSize: 12, marginTop: 12 }}>
          loading…
        </div>
      )}
    </div>
  );
};

export { WorkflowPage };
export default WorkflowPage;
