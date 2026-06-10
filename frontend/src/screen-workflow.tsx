// @ts-nocheck
// Workflow screen — a node-based editor for the per-repo review pipeline.
//
// Three panes: a repository rail (left, styled like the Settings submenu and
// showing per-repo review counts), a React Flow canvas of the pipeline (center),
// and a detail panel for the selected node (right). The pipeline is a fixed,
// linear chain — users can't add/remove nodes, only activate/deactivate the
// optional steps and steer each AI stage with a custom prompt.
//
// Tiering: toggling which optional stages run is BASIC (free). The entry-trigger
// policy, verdict mode, per-stage custom prompts and the GitHub Action step are
// ADVANCED (Pro/Max): free users see them locked with an upgrade nudge. Saves
// are optimistic and persist per repo via PUT /api/repositories/:id/workflow.
import React from "react";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "./icons";
import { api, type Repository, type RepoWorkflow, type StagePromptKey, type ActionWorkflow } from "./api";
import { useAuth } from "./auth-context";

type StageKey = "holistic" | "deferrals" | "docs";
type NodeId =
  | "trigger" | "ingest" | "criteria" | "review"
  | "holistic" | "deferrals" | "docs" | "verdict" | "actions";

// Canonical pipeline nodes, in run order. The trigger is node 0 (auto-selected
// on load). `stageKey` marks an optional stage in wf.stages; `promptKey` marks a
// stage that makes an LLM call and accepts a custom prompt; `short` is the
// one-liner shown on the node, `desc` the fuller text in the detail panel.
type NodeDef = {
  id: NodeId;
  name: string;
  tag: string;        // category, shown in the detail-panel header
  icon: string;
  color: string;      // per-node icon colour (a CSS var, e.g. "var(--info)")
  short: string;      // brief description on the node
  desc: string;       // fuller description in the panel
  mandatory: boolean; // always runs — no on/off switch
  stageKey?: StageKey;
  promptKey?: StagePromptKey;
  advanced?: boolean; // node exposes Pro/Max-only switches
};

const NODE_DEFS: NodeDef[] = [
  { id: "trigger", name: "New / updated PR", tag: "Trigger", icon: "play", color: "var(--info)", mandatory: true, advanced: true,
    short: "Fires on PR opened / updated",
    desc: "Runs whenever a pull request is opened or updated." },
  { id: "ingest", name: "Ingest context", tag: "Context", icon: "doc", color: "var(--cyan)", mandatory: true,
    short: "Diff, tickets, Looms & frames",
    desc: "Pull the diff, linked tickets, attached Looms & design frames." },
  { id: "criteria", name: "Synthesize criteria", tag: "Agent", icon: "brain", color: "var(--purple)", mandatory: true, promptKey: "criteria",
    short: "Derive end goal & criteria",
    desc: "Derive the end goal & acceptance criteria the PR must meet." },
  { id: "review", name: "Review diff", tag: "Agent", icon: "code", color: "var(--accent)", mandatory: true, promptKey: "review",
    short: "Diff vs. each criterion",
    desc: "Check the diff against each acceptance criterion." },
  { id: "holistic", name: "Whole-repo review", tag: "Agent", icon: "git", color: "var(--green)", mandatory: false, stageKey: "holistic", promptKey: "holistic",
    short: "Regressions & security, repo-wide",
    desc: "Check the change against the repo index for regressions, critical errors & security flaws." },
  { id: "deferrals", name: "Deferred-work scan", tag: "Agent", icon: "warn", color: "var(--warn)", mandatory: false, stageKey: "deferrals", promptKey: "deferrals",
    short: "TODOs, stubs & silent punts",
    desc: "Catch self-admitted punts — TODOs, stubs, NotImplemented buried in the diff." },
  { id: "docs", name: "DEVASIGN.md guidance", tag: "Agent", icon: "doc", color: "var(--pink)", mandatory: false, stageKey: "docs", promptKey: "docs",
    short: "Conventions & doc drift",
    desc: "Enforce your repo conventions & flag docs the change makes outdated." },
  { id: "verdict", name: "Post verdict", tag: "Output", icon: "check", color: "var(--lemon)", mandatory: true, advanced: true,
    short: "Check Run + PR review + notify",
    desc: "Post the Check Run + PR review and notify your connected integrations." },
  { id: "actions", name: "Run GitHub Action", tag: "Action", icon: "terminal", color: "var(--danger)", mandatory: false, advanced: true,
    short: "Dispatch a workflow on finish",
    desc: "Dispatch a chosen GitHub Actions workflow after the review (workflow_dispatch)." },
];

// One-click presets. Strict = maximum rigor; Balanced = quieter defaults;
// Light = lean + advisory (never blocks the merge). Only the core policy
// (trigger / stages / verdict) — prompts & actions are preserved on apply.
const TEMPLATES: Record<string, Pick<RepoWorkflow, "trigger" | "stages" | "verdict">> = {
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

const PROMPT_MAX = 2000;
const EDGE_COLOR = "#39414c";
const NODE_GAP = 108; // vertical spacing between nodes on the canvas

const goUpgrade = () =>
  (window.location.href = `${window.location.origin}/?billing=upgrade`);

const Toggle = ({ on, onClick, locked = false }) => (
  <div
    className={`tog ${on ? "on" : ""}`}
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

// Is a node currently "on"? Mandatory stages always run; the actions step keys
// off wf.actions.enabled; optional stages off wf.stages[key].
const nodeOn = (def: NodeDef, wf: RepoWorkflow) =>
  def.id === "actions" ? !!wf.actions?.enabled : def.stageKey ? !!wf.stages[def.stageKey] : true;

// Stamp a lock glyph only when ALL of a node's controls are Pro/Max-locked.
// Optional stages keep their (free) on/off switch, so they never get the glyph
// even though their prompt is locked.
const nodeLocked = (def: NodeDef, advancedLocked: boolean) =>
  advancedLocked &&
  (def.id === "trigger" ||
    def.id === "verdict" ||
    def.id === "actions" ||
    (!!def.promptKey && def.mandatory));

// A node shows an on/off dot when it can be toggled (optional stage or the
// actions step) and isn't fully locked.
const nodeToggleable = (def: NodeDef) => !!def.stageKey || def.id === "actions";

// Does a workflow's core policy match a preset? (Ignores prompts & actions.)
const matchesPreset = (wf: RepoWorkflow, t: typeof TEMPLATES[string]) =>
  wf.trigger.onSynchronize === t.trigger.onSynchronize &&
  wf.trigger.skipDrafts === t.trigger.skipDrafts &&
  wf.trigger.skipBots === t.trigger.skipBots &&
  wf.stages.holistic === t.stages.holistic &&
  wf.stages.docs === t.stages.docs &&
  wf.stages.deferrals === t.stages.deferrals &&
  wf.verdict.blocking === t.verdict.blocking;

const activeMode = (wf: RepoWorkflow): string | null => {
  for (const [name, t] of Object.entries(TEMPLATES)) if (matchesPreset(wf, t)) return name;
  return null;
};

// ── Custom React Flow node ──────────────────────────────────────────────────
function StageNode({ data }: NodeProps) {
  const { def, on, selected, locked } = data as any;
  // Per-node icon colour flows through the --nc custom property (used by the
  // icon square + the on dot). Sharp edges throughout, matching the app buttons.
  return (
    <div
      className={`wf-node ${on ? "" : "is-off"} ${selected ? "is-selected" : ""}`}
      style={{ ["--nc" as any]: def.color }}
    >
      {def.id === "trigger" && <span className="wf-node-tab">Trigger</span>}
      <Handle type="target" position={Position.Top} isConnectable={false} className="wf-node-handle" />
      <span className="wf-node-ico">
        <Icon name={def.icon} size={15} />
      </span>
      <div className="wf-node-text">
        <div className="wf-node-name">{def.name}</div>
        <div className="wf-node-desc">{def.short}</div>
      </div>
      {locked ? (
        <span className="wf-node-flag" title="Pro/Max"><Icon name="lock" size={11} /></span>
      ) : nodeToggleable(def) ? (
        <span className={`wf-node-dot ${on ? "on" : "off"}`} title={on ? "active" : "inactive"} />
      ) : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="wf-node-handle" />
    </div>
  );
}
const nodeTypes = { stage: StageNode };

// Build the React Flow nodes/edges from the workflow + current selection.
function buildGraph(wf: RepoWorkflow, selectedId: string, advancedLocked: boolean) {
  const nodes = NODE_DEFS.map((def, i) => ({
    id: def.id,
    type: "stage",
    position: { x: 0, y: i * NODE_GAP },
    data: {
      def,
      on: nodeOn(def, wf),
      selected: def.id === selectedId,
      locked: nodeLocked(def, advancedLocked),
    },
    draggable: false,
    selectable: false,
  }));
  const edges = NODE_DEFS.slice(1).map((def, i) => ({
    id: `${NODE_DEFS[i].id}__${def.id}`,
    source: NODE_DEFS[i].id,
    target: def.id,
    type: "smoothstep",
    style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 16, height: 16 },
  }));
  return { nodes, edges };
}

// ── Per-stage custom prompt editor (advanced) ───────────────────────────────
function PromptEditor({ promptKey, value, locked, onSave }) {
  const [text, setText] = React.useState(value || "");
  // Re-seed if the underlying value changes (e.g. a mode was applied).
  React.useEffect(() => setText(value || ""), [value]);

  if (locked) {
    return (
      <div className="wf-prompt">
        <div className="wf-prompt-head">
          <span className="wf-label">Custom prompt</span>
          <ProLock />
        </div>
        <div className="wf-prompt-locked" onClick={goUpgrade}>
          <Icon name="lock" size={12} />
          <span>Steer this step with your own instructions — a Pro/Max feature. Upgrade to edit →</span>
        </div>
      </div>
    );
  }

  const commit = () => {
    const next = text.trim();
    if (next !== (value || "")) onSave(promptKey, next);
  };
  return (
    <div className="wf-prompt">
      <div className="wf-prompt-head">
        <span className="wf-label">Custom prompt</span>
        <span className="mute" style={{ fontSize: 11 }}>appended to this step's agent instructions</span>
      </div>
      <textarea
        className="textarea wf-textarea"
        value={text}
        placeholder="e.g. Pay extra attention to error handling, N+1 queries, and missing tests…"
        onChange={(e) => setText(e.target.value.slice(0, PROMPT_MAX))}
        onBlur={commit}
        rows={7}
      />
      <div className="wf-prompt-foot mute">
        {text.length}/{PROMPT_MAX} · saved when you click away
      </div>
    </div>
  );
}

// ── "Run GitHub Action" editor (advanced) ───────────────────────────────────
function ActionsEditor({ repoId, actions, locked, onSave }) {
  const a = actions || { enabled: false, workflow: "", runWhen: "passed" };
  const [list, setList] = React.useState({ loading: true, workflows: [] as ActionWorkflow[], error: null as string | null });

  React.useEffect(() => {
    if (locked) return;
    let alive = true;
    setList({ loading: true, workflows: [], error: null });
    api
      .repoActionWorkflows(repoId)
      .then((r) => alive && setList({ loading: false, workflows: r.workflows || [], error: r.error || null }))
      .catch((e) => alive && setList({ loading: false, workflows: [], error: e?.message || "failed" }));
    return () => {
      alive = false;
    };
  }, [repoId, locked]);

  if (locked) {
    return (
      <div className="wf-prompt">
        <div className="wf-prompt-head">
          <span className="wf-label">GitHub Action</span>
          <ProLock />
        </div>
        <div className="wf-prompt-locked" onClick={goUpgrade}>
          <Icon name="lock" size={12} />
          <span>Dispatch a GitHub Actions workflow after each review — a Pro/Max feature. Upgrade to edit →</span>
        </div>
      </div>
    );
  }

  // Keep the stored workflow selectable even if the live list is empty/unavailable.
  const options = list.workflows.slice();
  if (a.workflow && !options.some((w) => w.file === a.workflow)) {
    options.unshift({ id: -1, name: a.workflow, file: a.workflow });
  }

  return (
    <>
      <label className="wf-ctl">
        <Toggle on={a.enabled} onClick={() => onSave({ enabled: !a.enabled })} />
        <div>
          <div className="wf-ctl-name">{a.enabled ? "Enabled" : "Disabled"}</div>
          <div className="wf-ctl-desc mute">Dispatch a workflow when a review finishes.</div>
        </div>
      </label>

      <div className="wf-field">
        <span className="wf-label">Workflow</span>
        {list.loading ? (
          <div className="mute mono" style={{ fontSize: 12 }}>loading workflows…</div>
        ) : list.error === "actions_unavailable" ? (
          <div className="wf-prompt-foot mute" style={{ textAlign: "left" }}>
            No Actions access yet — grant the GitHub App <span className="mono">actions:read</span> /{" "}
            <span className="mono">actions:write</span>, then reload.
          </div>
        ) : options.length === 0 ? (
          <div className="wf-prompt-foot mute" style={{ textAlign: "left" }}>
            No workflows found in <span className="mono">.github/workflows</span>.
          </div>
        ) : (
          <select className="input" value={a.workflow} onChange={(e) => onSave({ workflow: e.target.value })}>
            <option value="">Select a workflow…</option>
            {options.map((w) => (
              <option key={w.file} value={w.file}>
                {w.name} ({w.file})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="wf-field">
        <span className="wf-label">Run when</span>
        <select className="input" value={a.runWhen} onChange={(e) => onSave({ runWhen: e.target.value })}>
          <option value="passed">Review approved</option>
          <option value="always">Every review</option>
        </select>
        <div className="wf-prompt-foot mute" style={{ textAlign: "left" }}>
          Dispatched on the PR's head branch (needs a <span className="mono">workflow_dispatch</span> trigger).
        </div>
      </div>
    </>
  );
}

// ── Right-hand detail / edit panel for the selected node ─────────────────────
function NodeDetails({ def, wf, repoId, advancedLocked, onToggleStage, onToggleTrigger, onToggleBlocking, onSavePrompt, onSaveActions }) {
  const on = nodeOn(def, wf);
  const status = def.mandatory ? "always on" : on ? "active" : "inactive";
  return (
    <>
      <div className="wf-panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="wf-panel-title">{def.name}</div>
          <div className="wf-panel-sub mute">{def.tag} · {status}</div>
        </div>
      </div>

      <div className="wf-panel-body">
        <p className="wf-panel-desc">{def.desc}</p>

        {/* Optional stage: activate / deactivate (BASIC, free). */}
        {def.stageKey && (
          <label className="wf-ctl">
            <Toggle on={on} onClick={() => onToggleStage(def.stageKey)} />
            <div>
              <div className="wf-ctl-name">{on ? "Stage enabled" : "Stage disabled"}</div>
              <div className="wf-ctl-desc mute">Turn this step off to skip it on every review.</div>
            </div>
          </label>
        )}

        {/* Trigger node: entry policy (ADVANCED). */}
        {def.id === "trigger" && (
          <div className="wf-ctl-group">
            {([
              ["onSynchronize", "Re-review on new pushes", "Re-run when commits are pushed to an open PR"],
              ["skipDrafts", "Skip draft PRs", "Ignore drafts until they're marked ready for review"],
              ["skipBots", "Skip bot PRs", "Ignore Dependabot / Renovate / other bot authors"],
            ] as const).map(([key, name, desc]) => (
              <label key={key} className="wf-ctl">
                <Toggle on={wf.trigger[key]} locked={advancedLocked} onClick={() => onToggleTrigger(key)} />
                <div>
                  <div className="wf-ctl-name">
                    {name} {advancedLocked && <ProLock />}
                  </div>
                  <div className="wf-ctl-desc mute">{desc}</div>
                </div>
              </label>
            ))}
          </div>
        )}

        {/* Verdict node: blocking vs advisory (ADVANCED). */}
        {def.id === "verdict" && (
          <label className="wf-ctl">
            <Toggle on={wf.verdict.blocking} locked={advancedLocked} onClick={onToggleBlocking} />
            <div>
              <div className="wf-ctl-name">
                Block merge on changes requested {advancedLocked && <ProLock />}
              </div>
              <div className="wf-ctl-desc mute">
                {wf.verdict.blocking
                  ? "REQUEST_CHANGES gates the PR"
                  : "advisory COMMENT — never blocks the merge"}
              </div>
            </div>
          </label>
        )}

        {/* Mandatory, non-AI step with no switches. */}
        {def.mandatory && !def.promptKey && def.id !== "trigger" && def.id !== "verdict" && (
          <span className="pill" style={{ color: "var(--fg-mute)" }}>
            <i className="dot" /> always on
          </span>
        )}

        {/* AI stage: custom prompt (ADVANCED). */}
        {def.promptKey && (
          <PromptEditor
            key={def.id}
            promptKey={def.promptKey}
            value={wf.prompts?.[def.promptKey] || ""}
            locked={advancedLocked}
            onSave={onSavePrompt}
          />
        )}

        {/* GitHub Action step (ADVANCED). */}
        {def.id === "actions" && (
          <ActionsEditor
            key={repoId}
            repoId={repoId}
            actions={wf.actions}
            locked={advancedLocked}
            onSave={onSaveActions}
          />
        )}
      </div>
    </>
  );
}

const WorkflowPage = () => {
  const { user } = useAuth();
  const [repos, setRepos] = React.useState<Repository[]>([]);
  const [repoId, setRepoId] = React.useState<string>("");
  const [wf, setWf] = React.useState<RepoWorkflow | null>(null);
  const [selectedId, setSelectedId] = React.useState<NodeId>("trigger");
  const [advancedLocked, setAdvancedLocked] = React.useState(
    (user?.plan || "free") === "free"
  );
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

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

  // Load the selected repo's workflow whenever the selection changes; reset the
  // canvas selection back to the trigger (auto-selected first node).
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
        setSelectedId("trigger");
      })
      .catch((e) => alive && setErr(e?.message || "Couldn't load workflow"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoId]);

  // Keep the canvas in sync with the workflow + current selection.
  React.useEffect(() => {
    if (!wf) return;
    const { nodes, edges } = buildGraph(wf, selectedId, advancedLocked);
    setRfNodes(nodes);
    setRfEdges(edges);
  }, [wf, selectedId, advancedLocked, setRfNodes, setRfEdges]);

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
  const toggleStage = (key: StageKey) =>
    wf && save({ ...wf, stages: { ...wf.stages, [key]: !wf.stages[key] } });

  // Advanced (paid): trigger policy + verdict mode + prompts + actions.
  const toggleTrigger = (key: string) => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, trigger: { ...wf.trigger, [key]: !wf.trigger[key] } });
  };
  const toggleBlocking = () => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, verdict: { blocking: !wf.verdict.blocking } });
  };
  const savePrompt = (key: StagePromptKey, text: string) => {
    if (advancedLocked) return goUpgrade();
    if (!wf) return;
    const prompts = { ...(wf.prompts || {}) };
    if (text) prompts[key] = text;
    else delete prompts[key];
    save({ ...wf, prompts });
  };
  const saveActions = (patch: Partial<RepoWorkflow["actions"]>) => {
    if (advancedLocked) return goUpgrade();
    if (!wf) return;
    const actions = { enabled: false, workflow: "", runWhen: "passed", ...(wf.actions || {}), ...patch };
    save({ ...wf, actions });
  };
  // Apply a mode but preserve prompts/actions (merge over the current workflow).
  const applyMode = (name: string) => {
    if (advancedLocked) return goUpgrade();
    if (!wf) return;
    save({ ...wf, version: 1, ...TEMPLATES[name] });
  };

  const repo = repos.find((r) => r.id === repoId);
  const selectedDef = NODE_DEFS.find((n) => n.id === selectedId) || null;
  const noRepos = repos.length === 0 && !loading;
  const mode = wf ? activeMode(wf) : null;

  return (
    <div className="wf-layout">
      {/* Full-bleed canvas — the floating panels below sit over it. */}
      <div className="wf-flow">
        {noRepos ? (
          <div className="wf-canvas-empty">
            <div className="card" style={{ maxWidth: 460 }}>
              <div className="card-body mute" style={{ fontSize: 13 }}>
                No repositories connected yet. Install the DevAsign GitHub App under{" "}
                <span className="mono" style={{ color: "var(--fg)" }}>Settings → Repository</span>{" "}
                to start customizing review workflows.
              </div>
            </div>
          </div>
        ) : !wf ? (
          <div className="wf-canvas-empty mono mute">loading…</div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => setSelectedId(n.id as NodeId)}
            onInit={(inst) => requestAnimationFrame(() => inst.fitView({ padding: 0.18, maxZoom: 1 }))}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
            minZoom={0.4}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            panOnScroll
            proOptions={{ hideAttribution: false }}
          >
            <Background color="var(--line)" gap={22} size={1} />
          </ReactFlow>
        )}
      </div>

      {/* Floating left section — repositories, laid out like the agent's review queue */}
      <aside className="wf-rail pr-queue">
        <div className="pr-queue-head">
          <h3 className="card-title">Repositories</h3>
        </div>
        <div className="pr-queue-list">
          {noRepos && (
            <div className="mute mono" style={{ padding: 20, fontSize: 12, textAlign: "center" }}>
              No repositories connected.
            </div>
          )}
          {repos.map((r) => {
            const s = r.reviewStats;
            return (
              <div
                key={r.id}
                className={`pr-card ${r.id === repoId ? "picked" : ""}`}
                onClick={() => setRepoId(r.id)}
                title={`${r.owner}/${r.name}`}
              >
                <div className="pr-card-row">
                  <span className="mono mute" style={{ fontSize: 11 }}>{r.owner}</span>
                  <Icon name="github" size={12} />
                </div>
                <div className="pr-card-title">{r.name}</div>
                {s && (
                  <div className="pr-card-row" style={{ marginTop: 6 }}>
                    <span className="mono mute" style={{ fontSize: 11 }}>
                      {s.total} {s.total === 1 ? "review" : "reviews"}
                    </span>
                    <span className="mono" style={{ fontSize: 11 }}>
                      <span className="wf-stat-ok">✓ {s.approved}</span>
                      {" · "}
                      <span className="wf-stat-blk">✕ {s.blocked}</span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Repo name + Mode — directly on the canvas (no card behind them) */}
      {!noRepos && (
        <div className="wf-toolbar">
          <span className="wf-toolbar-title mono">
            {repo ? `${repo.owner}/${repo.name}` : "Workflow"}
          </span>
          <div className="wf-toolbar-right">
            {err && <span className="wf-err" style={{ color: "var(--danger)" }}>{err}</span>}
            <span className="mute" style={{ fontSize: 11 }}>Mode</span>
            {([
              ["strict", "Strict"],
              ["balanced", "Balanced"],
              ["light", "Light"],
            ] as const).map(([id, name]) => (
              <button
                key={id}
                className={`wf-mode-btn ${mode === id ? "is-active" : ""}`}
                onClick={() => applyMode(id)}
                style={advancedLocked ? { opacity: 0.6 } : undefined}
                title={advancedLocked ? "Pro/Max feature" : `Apply ${name} mode`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floating right section — node detail / edit */}
      <aside className="wf-panel wf-float">
        {wf && selectedDef && !noRepos ? (
          <NodeDetails
            def={selectedDef}
            wf={wf}
            repoId={repoId}
            advancedLocked={advancedLocked}
            onToggleStage={toggleStage}
            onToggleTrigger={toggleTrigger}
            onToggleBlocking={toggleBlocking}
            onSavePrompt={savePrompt}
            onSaveActions={saveActions}
          />
        ) : (
          <div className="wf-panel-empty mute">
            {noRepos ? "Connect a repository to begin." : "Select a node to edit it."}
          </div>
        )}
      </aside>
    </div>
  );
};

export { WorkflowPage };
export default WorkflowPage;
