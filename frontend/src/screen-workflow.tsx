// @ts-nocheck
// Workflow screen — a node-based editor for the per-repo review pipeline.
//
// Three panes: a repository rail (left), a React Flow canvas of the pipeline
// (center), and a detail panel for the selected node (right). The pipeline is a
// fixed, linear chain — users can't add/remove nodes, only activate/deactivate
// the optional stages and steer each AI stage with a custom prompt.
//
// Tiering: toggling which optional stages run is BASIC (free). The entry-trigger
// policy, verdict mode and per-stage custom prompts are ADVANCED (Pro/Max): free
// users see them locked with an upgrade nudge. Saves are optimistic and persist
// per repo via PUT /api/repositories/:id/workflow.
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
import { api, type Repository, type RepoWorkflow, type StagePromptKey } from "./api";
import { useAuth } from "./auth-context";

type StageKey = "holistic" | "deferrals" | "docs";
type NodeId =
  | "trigger" | "ingest" | "criteria" | "review"
  | "holistic" | "deferrals" | "docs" | "verdict";

// Canonical pipeline nodes, in run order. The trigger is node 0 (auto-selected
// on load). `stageKey` marks an optional stage that can be toggled; `promptKey`
// marks a stage that makes an LLM call and so accepts a custom prompt.
type NodeDef = {
  id: NodeId;
  name: string;
  tag: string;        // category chip shown on the node
  icon: string;
  desc: string;
  mandatory: boolean; // always runs — no on/off switch
  stageKey?: StageKey;
  promptKey?: StagePromptKey;
  advanced?: boolean; // node exposes Pro/Max-only switches (trigger / verdict)
};

const NODE_DEFS: NodeDef[] = [
  { id: "trigger", name: "New PR", tag: "Trigger", icon: "play", mandatory: true, advanced: true,
    desc: "Runs whenever a pull request is opened or updated." },
  { id: "ingest", name: "Ingest context", tag: "Context", icon: "doc", mandatory: true,
    desc: "Pull the diff, linked tickets, attached Looms & design frames." },
  { id: "criteria", name: "Synthesize criteria", tag: "Agent", icon: "brain", mandatory: true, promptKey: "criteria",
    desc: "Derive the end goal & acceptance criteria the PR must meet." },
  { id: "review", name: "Review diff", tag: "Agent", icon: "code", mandatory: true, promptKey: "review",
    desc: "Check the diff against each acceptance criterion." },
  { id: "holistic", name: "Whole-repo review", tag: "Agent", icon: "git", mandatory: false, stageKey: "holistic", promptKey: "holistic",
    desc: "Check the change against the repo index for regressions, critical errors & security flaws." },
  { id: "deferrals", name: "Deferred-work scan", tag: "Agent", icon: "warn", mandatory: false, stageKey: "deferrals", promptKey: "deferrals",
    desc: "Catch self-admitted punts — TODOs, stubs, NotImplemented buried in the diff." },
  { id: "docs", name: "DEVASIGN.md guidance", tag: "Agent", icon: "doc", mandatory: false, stageKey: "docs", promptKey: "docs",
    desc: "Enforce your repo conventions & flag docs the change makes outdated." },
  { id: "verdict", name: "Post verdict", tag: "Output", icon: "check", mandatory: true, advanced: true,
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

// Is an optional stage currently on? Mandatory stages always run.
const nodeOn = (def: NodeDef, wf: RepoWorkflow) =>
  def.stageKey ? !!wf.stages[def.stageKey] : true;

// Whether to stamp a lock glyph on the node: only when the node's controls are
// entirely Pro/Max-locked. Optional stages keep their (free) on/off switch, so
// they never get the glyph even though their prompt is locked.
const nodeLocked = (def: NodeDef, advancedLocked: boolean) =>
  advancedLocked &&
  (def.id === "trigger" || def.id === "verdict" || (!!def.promptKey && def.mandatory));

// ── Custom React Flow node ──────────────────────────────────────────────────
function StageNode({ data }: NodeProps) {
  const { def, on, selected, locked } = data as any;
  return (
    <div className={`wf-node ${on ? "" : "is-off"} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="wf-node-handle" />
      <span className="wf-node-ico" style={{ color: on ? "var(--accent)" : "var(--fg-mute)" }}>
        <Icon name={def.icon} size={15} />
      </span>
      <div className="wf-node-text">
        <div className="wf-node-name">{def.name}</div>
        <div className="wf-node-tag">{def.tag}</div>
      </div>
      {locked ? (
        <span className="wf-node-flag" title="Pro/Max"><Icon name="lock" size={11} /></span>
      ) : def.stageKey ? (
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
  // Re-seed if the underlying value changes (e.g. a template was applied).
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

// ── Right-hand detail / edit panel for the selected node ─────────────────────
function NodeDetails({ def, wf, advancedLocked, onToggleStage, onToggleTrigger, onToggleBlocking, onSavePrompt }) {
  const on = nodeOn(def, wf);
  const status = def.mandatory ? "always on" : on ? "active" : "inactive";
  return (
    <>
      <div className="wf-panel-head">
        <span className="wf-node-ico" style={{ color: on ? "var(--accent)" : "var(--fg-mute)" }}>
          <Icon name={def.icon} size={16} />
        </span>
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

  // Advanced (paid): trigger policy + verdict mode + prompts. Locked → upgrade.
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
  const applyTemplate = (name: string) => {
    if (advancedLocked) return goUpgrade();
    save({ version: 1, ...TEMPLATES[name] });
  };

  const repo = repos.find((r) => r.id === repoId);
  const selectedDef = NODE_DEFS.find((n) => n.id === selectedId) || null;
  const noRepos = repos.length === 0 && !loading;

  return (
    <div className="wf-layout">
      {/* Left rail — repositories */}
      <aside className="wf-rail">
        <div className="wf-rail-head">Repositories</div>
        <div className="wf-rail-list">
          {repos.map((r) => (
            <button
              key={r.id}
              className={`wf-rail-item ${r.id === repoId ? "is-active" : ""}`}
              onClick={() => setRepoId(r.id)}
              title={`${r.owner}/${r.name}`}
            >
              <Icon name="github" size={13} />
              <span className="wf-rail-name">
                <span className="mute">{r.owner}/</span>{r.name}
              </span>
            </button>
          ))}
          {noRepos && <div className="wf-rail-empty mute">No repositories connected.</div>}
        </div>
      </aside>

      {/* Center — pipeline canvas */}
      <div className="wf-canvas">
        <div className="wf-toolbar">
          <div className="wf-toolbar-title mono">
            {repo ? `${repo.owner}/${repo.name}` : "Workflow"}
          </div>
          <div className="wf-toolbar-right">
            {err && <span className="wf-err" style={{ color: "var(--danger)" }}>{err}</span>}
            <span className="mute" style={{ fontSize: 11 }}>Templates</span>
            {([
              ["strict", "Strict"],
              ["balanced", "Balanced"],
              ["light", "Light"],
            ] as const).map(([id, name]) => (
              <button
                key={id}
                className="btn ghost sm"
                onClick={() => applyTemplate(id)}
                style={advancedLocked ? { opacity: 0.6 } : undefined}
                title={advancedLocked ? "Pro/Max feature" : `Apply the ${name} preset`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

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
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
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
      </div>

      {/* Right — node detail / edit */}
      <aside className="wf-panel">
        {wf && selectedDef && !noRepos ? (
          <NodeDetails
            def={selectedDef}
            wf={wf}
            advancedLocked={advancedLocked}
            onToggleStage={toggleStage}
            onToggleTrigger={toggleTrigger}
            onToggleBlocking={toggleBlocking}
            onSavePrompt={savePrompt}
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
