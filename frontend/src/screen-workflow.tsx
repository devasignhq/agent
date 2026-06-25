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
import { api, type Repository, type RepoWorkflow, type StagePromptKey, type ActionWorkflow, type RepoGuidanceItem } from "./api";
import { useAuth } from "./auth-context";

type StageKey = "holistic" | "deferrals" | "docs";
type NodeId =
  // Main PR-review lane
  | "trigger" | "ingest" | "criteria" | "newcommit" | "review"
  | "holistic" | "backstop" | "secgate" | "preexisting"
  | "deferrals" | "docs" | "verdict" | "actions"
  // Maintainer-feedback lane (second entry path + loop back)
  | "mtrigger" | "manalyze" | "mrescore" | "mguide";

// How a node reads on the canvas + in the detail panel:
//  trigger  — an entry point (PR event, or a maintainer comment)
//  stage    — a pipeline step with its own controls (toggle / prompt)
//  branch   — one arm of a fork (e.g. whole-repo review vs. security backstop)
//  info     — a read-only step the agent always does; no controls, just a badge
type NodeKind = "trigger" | "stage" | "branch" | "info";

// Pipeline nodes. `pos` lays each out explicitly so the graph can branch and
// loop (no longer a single column). `stageKey` marks an optional stage in
// wf.stages; `promptKey` marks an LLM stage that accepts a custom prompt;
// `badge` stamps an "always on" / "advisory" pill on read-only nodes; `lane`
// separates the maintainer entry path from the main PR lane.
type NodeDef = {
  id: NodeId;
  name: string;
  tag: string;        // category, shown in the detail-panel header
  icon: string;
  color: string;      // per-node icon colour (a CSS var, e.g. "var(--info)")
  short: string;      // brief description on the node
  desc: string;       // fuller description in the panel
  pos: { x: number; y: number }; // explicit canvas position
  kind?: NodeKind;    // default "stage"
  mandatory?: boolean; // always runs — no on/off switch
  stageKey?: StageKey;
  promptKey?: StagePromptKey;
  advanced?: boolean; // node exposes Pro/Max-only switches
  readOnly?: boolean; // informational: panel shows desc + badge, no controls
  badge?: "always-on" | "advisory" | "auto";
  lane?: "pr" | "maintainer";
};

// Canvas geometry. Two lanes (main PR spine at x≈0, maintainer lane to the
// right); the security fork and the new-commit offshoot sit on either side.
const X_MAIN = 0;
const X_LEFT = -330;   // new-commit intent offshoot
const X_WR = -185;     // whole-repo review (left arm of the security fork)
const X_BK = 195;      // security backstop (right arm)
const X_MAINT = 540;   // maintainer-feedback lane
const ROW = 112;       // vertical spacing between rows

const NODE_DEFS: NodeDef[] = [
  // ── Main PR-review lane ──────────────────────────────────────────────────
  { id: "trigger", name: "New / updated PR", tag: "Trigger", icon: "play", color: "var(--info)", kind: "trigger", mandatory: true, advanced: true, lane: "pr",
    pos: { x: X_MAIN, y: 0 },
    short: "Fires on PR opened / updated",
    desc: "Runs whenever a pull request is opened or updated. A new push to an open PR re-enters the pipeline as a re-review (which adds the new-commit intent step)." },
  { id: "ingest", name: "Ingest context", tag: "Context", icon: "doc", color: "var(--cyan)", mandatory: true, lane: "pr",
    pos: { x: X_MAIN, y: ROW },
    short: "Diff, tickets, Looms & frames",
    desc: "Pull the diff, linked tickets, attached Looms & design frames, and the relevant slice of the repo index. Attach guidance materials below — videos, docs & PDFs the agent indexes and follows on every review of this repo." },
  { id: "criteria", name: "Synthesize criteria", tag: "Agent", icon: "brain", color: "var(--purple)", mandatory: true, promptKey: "criteria", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 2 },
    short: "Derive end goal & criteria",
    desc: "Derive the end goal & acceptance criteria the PR must meet." },
  { id: "newcommit", name: "New-commit intent review", tag: "Agent", icon: "git", color: "var(--purple)", kind: "info", readOnly: true, badge: "advisory", lane: "pr",
    pos: { x: X_LEFT, y: ROW * 2 },
    short: "Re-reviews: new commits vs. intent",
    desc: "On a re-review after a fresh push, check the new commits against their own commit-message intent and the delta diff, then append acceptance criteria for any new checkable promises." },
  { id: "review", name: "Review diff", tag: "Agent", icon: "code", color: "var(--accent)", mandatory: true, promptKey: "review", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 3 },
    short: "Diff vs. each criterion",
    desc: "Check the diff against each acceptance criterion." },
  { id: "holistic", name: "Whole-repo review", tag: "Agent", icon: "git", color: "var(--green)", kind: "branch", mandatory: false, stageKey: "holistic", promptKey: "holistic", lane: "pr",
    pos: { x: X_WR, y: ROW * 4 },
    short: "Regressions, errors & security",
    desc: "Check the change against the repo index for regressions, critical errors & security flaws. Turning this off does NOT disable security — it reroutes to the security backstop, and the Security gate stays on." },
  { id: "backstop", name: "Security backstop", tag: "Security", icon: "shield", color: "var(--danger)", kind: "branch", readOnly: true, badge: "always-on", lane: "pr",
    pos: { x: X_BK, y: ROW * 4 },
    short: "Security-only fallback",
    desc: "When the whole-repo review is off (or its index isn't built yet), a security-only pass still runs against the diff — so security is never skipped." },
  { id: "secgate", name: "Security gate", tag: "Security", icon: "shield", color: "var(--danger)", kind: "info", readOnly: true, badge: "always-on", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 5 },
    short: "Always analyzed — can't be disabled",
    desc: "Security is analyzed on every review, whichever arm ran above. A vulnerability this PR introduces blocks the merge even in advisory mode." },
  { id: "preexisting", name: "Pre-existing vulnerabilities", tag: "Security", icon: "shield", color: "var(--warn)", kind: "info", readOnly: true, badge: "advisory", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 6 },
    short: "Surfaced from the index ⟲ re-verified",
    desc: "Surface vulnerabilities already living in files this PR touches or depends on (from the index security audit). Touched files are re-verified against the PR head, so a vuln this PR fixes is dropped and credited as resolved. Advisory — never blocks the merge." },
  { id: "deferrals", name: "Deferred-work scan", tag: "Agent", icon: "warn", color: "var(--warn)", mandatory: false, stageKey: "deferrals", promptKey: "deferrals", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 7 },
    short: "TODOs, stubs & silent punts",
    desc: "Catch self-admitted punts — TODOs, stubs, NotImplemented buried in the diff." },
  { id: "docs", name: "DEVASIGN.md guidance", tag: "Agent", icon: "doc", color: "var(--pink)", mandatory: false, stageKey: "docs", promptKey: "docs", lane: "pr",
    pos: { x: X_MAIN, y: ROW * 8 },
    short: "Conventions & doc drift",
    desc: "Enforce your repo conventions & flag docs the change makes outdated." },
  { id: "verdict", name: "Post verdict", tag: "Output", icon: "check", color: "var(--lemon)", mandatory: true, advanced: true, lane: "pr",
    pos: { x: X_MAIN, y: ROW * 9 },
    short: "Check Run + PR review + notify",
    desc: "Post the Check Run + PR review and notify your connected integrations." },
  { id: "actions", name: "Run GitHub Action", tag: "Action", icon: "terminal", color: "var(--danger)", mandatory: false, advanced: true, lane: "pr",
    pos: { x: X_MAIN, y: ROW * 10 },
    short: "Dispatch a workflow on finish",
    desc: "Dispatch a chosen GitHub Actions workflow after the review (workflow_dispatch)." },

  // ── Maintainer-feedback lane (second entry path, loops back to the trigger) ─
  { id: "mtrigger", name: "Maintainer comment", tag: "Trigger", icon: "message", color: "var(--info)", kind: "trigger", readOnly: true, lane: "maintainer",
    pos: { x: X_MAINT, y: 0 },
    short: "Owner / member / collaborator reply",
    desc: "A comment from someone with authority over the repo (owner, member, or collaborator) re-enters the review — to dispute a finding, raise the bar, or add context. Always on." },
  { id: "manalyze", name: "Analyze feedback", tag: "Agent", icon: "brain", color: "var(--purple)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    pos: { x: X_MAINT, y: ROW },
    short: "Refine goal; classify the comment",
    desc: "Read the comment (and any videos/docs in it), refine the end goal, and classify it into disputes, re-opens, and brand-new criteria." },
  { id: "mrescore", name: "Re-score / re-open / add", tag: "Agent", icon: "brain", color: "var(--purple)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    pos: { x: X_MAINT, y: ROW * 2 },
    short: "Clear FPs · re-open · raise the bar",
    desc: "Clear false positives (unmet→met, verified against the codebase), re-open passed criteria on the maintainer's authority (met→unmet), and add any new criteria. The security gate is never softened — a flip back to approved re-checks for introduced blockers first." },
  { id: "mguide", name: "Post guide / corrected verdict", tag: "Output", icon: "check", color: "var(--lemon)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    pos: { x: X_MAINT, y: ROW * 3 },
    short: "Implementation guide or correction",
    desc: "Post an implementation guide (when the bar moved up) or a corrected verdict (when a dispute cleared). The developer's next push then loops back through the PR trigger." },
];

// Explicit edges. `seq` is the normal top→bottom flow; `branch` is a labelled
// fork (drawn in the accent colour); `loop` is a dashed feedback edge. Handle
// ids match the six handles StageNode renders (tt/bs/lt/ls/rt/rs).
type EdgeKind = "seq" | "branch" | "loop";
type EdgeDef = { from: NodeId; to: NodeId; fromH?: string; toH?: string; kind?: EdgeKind; label?: string };
const EDGES: EdgeDef[] = [
  // Main lane
  { from: "trigger", to: "ingest" },
  { from: "ingest", to: "criteria" },
  { from: "criteria", to: "review" },
  // New-commit intent offshoot (re-review only) → appends criteria
  { from: "trigger", to: "newcommit", fromH: "ls", toH: "tt", kind: "branch", label: "re-review (new push)" },
  { from: "newcommit", to: "criteria", fromH: "rs", toH: "lt", kind: "branch", label: "append criteria" },
  // Security fork off the diff review, merging into the always-on gate
  { from: "review", to: "holistic", kind: "branch", label: "whole-repo on" },
  { from: "review", to: "backstop", kind: "branch", label: "off → security only" },
  { from: "holistic", to: "secgate" },
  { from: "backstop", to: "secgate" },
  { from: "secgate", to: "preexisting" },
  { from: "preexisting", to: "deferrals" },
  { from: "deferrals", to: "docs" },
  { from: "docs", to: "verdict" },
  { from: "verdict", to: "actions" },
  // Maintainer-feedback lane + loop back into the PR trigger
  { from: "mtrigger", to: "manalyze" },
  { from: "manalyze", to: "mrescore" },
  { from: "mrescore", to: "mguide" },
  { from: "mguide", to: "trigger", fromH: "ls", toH: "rt", kind: "loop", label: "dev pushes → re-review" },
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

// Is a node "lit" right now? The actions step keys off wf.actions.enabled;
// optional stages off wf.stages[key]. The security backstop is the fallback
// arm, so it's lit only when the whole-repo review is OFF; the new-commit
// intent step only fires on re-reviews, so it dims when re-review-on-push is
// off. Everything else (mandatory steps, always-on security, the maintainer
// lane) is always lit.
const nodeOn = (def: NodeDef, wf: RepoWorkflow) => {
  if (def.id === "actions") return !!wf.actions?.enabled;
  if (def.id === "backstop") return !wf.stages.holistic;
  if (def.id === "newcommit") return !!wf.trigger.onSynchronize;
  if (def.stageKey) return !!wf.stages[def.stageKey];
  return true;
};

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

// The active preset, or "custom" once the workflow has been tweaked so it no
// longer matches Strict / Balanced / Light.
const activeMode = (wf: RepoWorkflow): string => {
  for (const [name, t] of Object.entries(TEMPLATES)) if (matchesPreset(wf, t)) return name;
  return "custom";
};

// Short text stamped on read-only nodes so the always-on / advisory nature
// reads at a glance on the canvas (the "auto" maintainer steps stay unstamped).
const BADGE_TEXT: Record<NonNullable<NodeDef["badge"]>, string> = {
  "always-on": "always on",
  advisory: "advisory",
  auto: "",
};

// ── Custom React Flow node ──────────────────────────────────────────────────
function StageNode({ data }: NodeProps) {
  const { def, on, selected, locked } = data as any;
  const badgeText = def.badge ? BADGE_TEXT[def.badge as keyof typeof BADGE_TEXT] : "";
  // Per-node icon colour flows through the --nc custom property (used by the
  // icon square + the on dot). Sharp edges throughout, matching the app buttons.
  // Six handles (top/bottom + both sides) so branch and loop edges attach
  // cleanly; all are invisible (styled away in .wf-node-handle).
  return (
    <div
      className={`wf-node wf-kind-${def.kind || "stage"} ${def.lane === "maintainer" ? "wf-lane-m" : ""} ${on ? "" : "is-off"} ${selected ? "is-selected" : ""}`}
      style={{ ["--nc" as any]: def.color }}
    >
      {def.kind === "trigger" && <span className="wf-node-tab">{def.tag}</span>}
      <Handle id="tt" type="target" position={Position.Top} isConnectable={false} className="wf-node-handle" />
      <Handle id="lt" type="target" position={Position.Left} isConnectable={false} className="wf-node-handle" />
      <Handle id="ls" type="source" position={Position.Left} isConnectable={false} className="wf-node-handle" />
      <Handle id="rt" type="target" position={Position.Right} isConnectable={false} className="wf-node-handle" />
      <Handle id="rs" type="source" position={Position.Right} isConnectable={false} className="wf-node-handle" />
      <span className="wf-node-ico">
        <Icon name={def.icon} size={15} />
      </span>
      <div className="wf-node-text">
        <div className="wf-node-name">{def.name}</div>
        <div className="wf-node-desc">{def.short}</div>
      </div>
      {locked ? (
        <span className="wf-node-flag" title="Pro/Max"><Icon name="lock" size={11} /></span>
      ) : badgeText ? (
        <span className={`wf-node-badge ${def.badge}`}>{badgeText}</span>
      ) : nodeToggleable(def) ? (
        <span className={`wf-node-dot ${on ? "on" : "off"}`} title={on ? "active" : "inactive"} />
      ) : null}
      <Handle id="bs" type="source" position={Position.Bottom} isConnectable={false} className="wf-node-handle" />
    </div>
  );
}
const nodeTypes = { stage: StageNode };

// Build the React Flow nodes/edges from the workflow + current selection.
function buildGraph(wf: RepoWorkflow, selectedId: string, advancedLocked: boolean) {
  const nodes = NODE_DEFS.map((def) => ({
    id: def.id,
    type: "stage",
    position: def.pos,
    data: {
      def,
      on: nodeOn(def, wf),
      selected: def.id === selectedId,
      locked: nodeLocked(def, advancedLocked),
    },
    // Nodes can be dragged to re-space the layout; edges follow automatically and
    // the wiring can't be changed (connect/select are off at the canvas level).
    draggable: true,
    selectable: false,
  }));
  const edges = EDGES.map((e) => {
    const isLoop = e.kind === "loop";
    const isBranch = e.kind === "branch";
    const color = isLoop ? "var(--purple)" : isBranch ? "var(--accent)" : EDGE_COLOR;
    return {
      id: `${e.from}__${e.to}__${e.label || e.kind || "seq"}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.fromH || "bs",
      targetHandle: e.toH || "tt",
      type: "smoothstep",
      label: e.label,
      labelShowBg: true,
      labelStyle: { fill: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 },
      labelBgStyle: { fill: "var(--bg-1)", fillOpacity: 0.94 },
      labelBgPadding: [6, 3] as [number, number],
      animated: isLoop,
      style: {
        stroke: color,
        strokeWidth: 1.5,
        ...(isLoop ? { strokeDasharray: "5 4" } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });
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

// ── Guidance materials editor (advanced) — on the "Ingest context" node ──────
// Self-contained like ActionsEditor: fetches the repo's guidance list and lets
// the user attach a video link, a documentation link, or a PDF. New items index
// asynchronously (status starts "indexing"), so we poll until everything settles.
function guidanceErrText(e: any): string {
  const m = e?.message || "Couldn't add — try again.";
  switch (m) {
    case "invalid_url": return "That doesn't look like a valid URL.";
    case "not_a_pdf": return "That file isn't a PDF.";
    case "file_too_large": return "PDF is too large (max 15MB).";
    case "too_many_items": return "You've reached the maximum number of materials.";
    case "upgrade_required": return "That's a Pro/Max feature.";
    default: return m;
  }
}

function GuidanceStatus({ item }: { item: RepoGuidanceItem }) {
  if (item.status === "ready")
    return <span className="pill green"><i className="dot" /> ready</span>;
  if (item.status === "errored")
    return <span className="pill danger" title={item.error || ""}><i className="dot" /> failed</span>;
  return <span className="pill running"><i className="dot" /> indexing…</span>;
}

function GuidanceEditor({ repoId, locked }) {
  const [items, setItems] = React.useState<RepoGuidanceItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [video, setVideo] = React.useState("");
  const [doc, setDoc] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const reload = React.useCallback(
    () => api.repoGuidance(repoId).then((r) => setItems(r.items || [])).catch(() => {}),
    [repoId]
  );

  React.useEffect(() => {
    if (locked) return;
    let alive = true;
    setLoading(true);
    api
      .repoGuidance(repoId)
      .then((r) => alive && setItems(r.items || []))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [repoId, locked]);

  // Poll while anything is still indexing so the status flips to ready/failed.
  React.useEffect(() => {
    if (locked || !items.some((i) => i.status === "indexing")) return;
    const t = setInterval(() => { void reload(); }, 2500);
    return () => clearInterval(t);
  }, [items, locked, reload]);

  if (locked) {
    return (
      <div className="wf-prompt">
        <div className="wf-prompt-head">
          <span className="wf-label">Guidance materials</span>
          <ProLock />
        </div>
        <div className="wf-prompt-locked" onClick={goUpgrade}>
          <Icon name="lock" size={12} />
          <span>Attach videos, docs & PDFs the agent must follow on every review — a Pro/Max feature. Upgrade to add →</span>
        </div>
      </div>
    );
  }

  const addLink = async (kind: "video" | "doc", url: string, clear: () => void) => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr(null);
    try {
      const { item } = await api.addRepoGuidanceLink(repoId, kind, u);
      setItems((cur) => [...cur, item]);
      clear();
    } catch (e) { setErr(guidanceErrText(e)); }
    finally { setBusy(false); }
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setErr("PDF is too large (max 15MB)."); return; }
    setBusy(true); setErr(null);
    try {
      const { item } = await api.uploadRepoGuidancePdf(repoId, file);
      setItems((cur) => [...cur, item]);
    } catch (e) { setErr(guidanceErrText(e)); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    const prev = items;
    setItems((cur) => cur.filter((i) => i.id !== id));
    try { await api.deleteRepoGuidance(repoId, id); }
    catch { setItems(prev); }
  };

  const iconFor = (k: string) => (k === "video" ? "play" : k === "pdf" ? "doc" : "link");

  return (
    <div className="wf-guidance">
      <div className="wf-field">
        <span className="wf-label">Guidance materials</span>
        <div className="wf-prompt-foot mute" style={{ textAlign: "left", marginTop: 0 }}>
          Indexed immediately, then used as a guide on every review of this repo.
        </div>
      </div>

      {loading ? (
        <div className="mute mono" style={{ fontSize: 12 }}>loading…</div>
      ) : items.length === 0 ? (
        <div className="mute mono" style={{ fontSize: 12 }}>No materials yet.</div>
      ) : (
        <ul className="wf-guidance-list">
          {items.map((it) => (
            <li key={it.id} className="wf-guidance-item">
              <Icon name={iconFor(it.kind)} size={12} />
              <div className="wf-guidance-meta">
                <div className="wf-guidance-title" title={it.url || it.title}>{it.title}</div>
                <GuidanceStatus item={it} />
              </div>
              <button className="wf-guidance-x" onClick={() => remove(it.id)} title="Remove" aria-label="Remove">
                <Icon name="x" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="wf-field">
        <span className="wf-label">Video link</span>
        <div className="wf-guidance-add">
          <input
            className="input"
            placeholder="YouTube, Loom, Vimeo…"
            value={video}
            onChange={(e) => setVideo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink("video", video, () => setVideo(""))}
          />
          <button className="btn sm" disabled={busy || !video.trim()} onClick={() => addLink("video", video, () => setVideo(""))}>Add</button>
        </div>
      </div>

      <div className="wf-field">
        <span className="wf-label">Documentation link</span>
        <div className="wf-guidance-add">
          <input
            className="input"
            placeholder="https://…"
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink("doc", doc, () => setDoc(""))}
          />
          <button className="btn sm" disabled={busy || !doc.trim()} onClick={() => addLink("doc", doc, () => setDoc(""))}>Add</button>
        </div>
      </div>

      <div className="wf-field">
        <span className="wf-label">PDF</span>
        <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={onPick} />
        <button className="btn ghost sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Icon name="doc" size={12} /> Upload PDF
        </button>
      </div>

      {err && <div className="wf-guidance-err">{err}</div>}
    </div>
  );
}

// ── Right-hand detail / edit panel for the selected node ─────────────────────
function NodeDetails({ def, wf, repoId, advancedLocked, onToggleStage, onToggleTrigger, onToggleBlocking, onSavePrompt, onSaveActions }) {
  const on = nodeOn(def, wf);
  const status =
    def.badge === "always-on"
      ? "always on"
      : def.badge === "advisory"
      ? "advisory"
      : def.mandatory
      ? "always on"
      : on
      ? "active"
      : "inactive";
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

        {/* Read-only informational node: always-on / advisory / automatic step
            the agent does unconditionally — a status pill, no controls. */}
        {def.readOnly && (
          <div className="wf-ctl-group">
            {def.badge === "always-on" ? (
              <span className="pill" style={{ color: "var(--green)" }}><i className="dot" /> Always on — can't be disabled</span>
            ) : def.badge === "advisory" ? (
              <span className="pill" style={{ color: "var(--warn)" }}><i className="dot" /> Advisory — never blocks the merge</span>
            ) : (
              <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot" /> Automatic</span>
            )}
            {def.id === "newcommit" && !on && (
              <div className="wf-ctl-desc mute">Inactive right now: “Re-review on new pushes” is off, so re-reviews don't run.</div>
            )}
            {def.id === "backstop" && (
              <div className="wf-ctl-desc mute">
                {on
                  ? "Active now — the whole-repo review is off, so this security-only pass is what runs."
                  : "Idle now — the whole-repo review is on and already covers security."}
              </div>
            )}
          </div>
        )}

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

        {/* Security can't be switched off via the whole-repo toggle. */}
        {def.id === "holistic" && (
          <div className="wf-ctl-desc mute" style={{ marginTop: 8 }}>
            Turning this off doesn't disable security — a security-only backstop still runs and the Security gate stays on.
          </div>
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
          <>
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
            {!wf.verdict.blocking && (
              <div className="wf-ctl-desc mute" style={{ marginTop: 8 }}>
                ⚠ Security carve-out: a vulnerability this PR introduces still holds REQUEST_CHANGES even in advisory mode.
              </div>
            )}
          </>
        )}

        {/* Mandatory, non-AI step with no switches. */}
        {def.mandatory && !def.promptKey && def.id !== "trigger" && def.id !== "verdict" && (
          <span className="pill" style={{ color: "var(--fg-mute)" }}>
            <i className="dot" /> always on
          </span>
        )}

        {/* Ingest node: repo-scoped guidance materials (ADVANCED). */}
        {def.id === "ingest" && (
          <GuidanceEditor key={repoId} repoId={repoId} locked={advancedLocked} />
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

const WorkflowPage = ({ onRepoChange }: { onRepoChange?: (name: string | null) => void } = {}) => {
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
  // Transient "write staged but not yet durable" notice — distinct from a hard
  // error: on a not_durable 503 we keep the optimistic state and show this calm
  // notice instead of reverting (see save()).
  const [pending, setPending] = React.useState(false);
  // Monotonic token so a scheduled re-confirm (or a slow in-flight save) only acts
  // while it's still the latest save — a newer change supersedes it.
  const saveSeq = React.useRef(0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Keep the canvas in sync with the workflow + current selection. Rebuilding
  // refreshes each node's data (on/selected/locked), but we must NOT clobber any
  // position the user dragged a node to — so carry the live positions over by id.
  // (Empty on first build → nodes start at their canonical def.pos.)
  React.useEffect(() => {
    if (!wf) return;
    const { nodes, edges } = buildGraph(wf, selectedId, advancedLocked);
    setRfNodes((prev) => {
      const posById = new Map(prev.map((n) => [n.id, n.position]));
      return nodes.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n));
    });
    setRfEdges(edges);
  }, [wf, selectedId, advancedLocked, setRfNodes, setRfEdges]);

  // Optimistic save: paint `next` immediately, persist, revert on failure.
  //
  // Exception — a transient durability blip (HTTP 503 not_durable, e.g. a DB
  // cold-start): the backend has ALREADY applied the write to its in-memory cache
  // and staged it; its heartbeat persists it within ~15s, so the optimistic state
  // already matches backend truth. Reverting would make the UI disagree with a
  // reload. So we keep the optimistic state, show a calm "queued" notice (not a red
  // error) and re-confirm ONCE after a short delay — the barrier only 503s after
  // exhausting its own multi-second retry loop, so an immediate retry just re-hangs.
  const save = React.useCallback(
    async (next: RepoWorkflow, isRetry = false) => {
      if (!repoId) return;
      const seq = ++saveSeq.current; // claim latest; stale callbacks below no-op
      const prev = wf;
      setWf(next);
      setErr(null);
      try {
        await api.setRepoWorkflow(repoId, next);
        if (seq === saveSeq.current) setPending(false); // confirmed durable
      } catch (e: any) {
        if (seq !== saveSeq.current) return; // a newer save superseded this one
        const transient = e?.status === 503 && e?.body?.error === "not_durable";
        if (transient) {
          setPending(true); // keep the optimistic state — do NOT revert
          if (!isRetry) {
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => {
              if (seq === saveSeq.current) void save(next, true);
            }, 4000);
          }
          return;
        }
        setPending(false);
        setWf(prev); // hard failure — revert
        setErr(
          e?.message === "upgrade_required"
            ? "That control is a Pro/Max feature."
            : e?.body?.message || e?.message || "Couldn't save — reverted."
        );
      }
    },
    [repoId, wf]
  );

  // Drop any pending re-confirm if the page unmounts mid-wait.
  React.useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    []
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

  // Surface the selected repo's name to the app shell for the header breadcrumb
  // (user / Workflow / repo). Clear it on unmount so other pages don't inherit it.
  React.useEffect(() => {
    onRepoChange?.(repo ? repo.name : null);
  }, [repo, onRepoChange]);
  React.useEffect(() => () => onRepoChange?.(null), [onRepoChange]);

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
            onInit={(inst) => requestAnimationFrame(() => inst.fitView({ padding: 0.12, maxZoom: 1 }))}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
            nodesDraggable
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

      {/* Mode selector — sits top-left of the canvas, where the repo name used
          to be (the repo name now lives in the header breadcrumb). */}
      {!noRepos && (
        <div className="wf-toolbar">
          <div className="wf-toolbar-left">
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
            {/* "Custom" isn't an applyable preset — a read-only status that
                lights up when the workflow is tweaked off every preset. */}
            <span
              className={`wf-mode-btn is-custom ${mode === "custom" ? "is-active" : ""}`}
              title="Your settings don't match Strict, Balanced, or Light"
            >
              Custom
            </span>
          </div>
          {pending && (
            <span className="wf-err" style={{ color: "var(--warn)" }}>
              Saving… your change is queued and will save automatically.
            </span>
          )}
          {err && <span className="wf-err" style={{ color: "var(--danger)" }}>{err}</span>}
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
