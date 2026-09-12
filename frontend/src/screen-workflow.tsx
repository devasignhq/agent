// @ts-nocheck
// Workflow screen — a node-based editor for the per-repo review pipeline.
//
// A full-bleed React Flow canvas of the pipeline with a floating detail panel
// for the selected node. The repo picker and the repo's details (reviews,
// verification setup) live in the app header (see workflow-header.tsx). The
// pipeline is a fixed graph — users can't add/remove nodes, only activate the
// optional steps.
//
// Tiering: toggling which optional stages run is BASIC (free). The entry-trigger
// policy, verdict mode, guidance materials and the GitHub Action step are
// ADVANCED (Pro/Max): free users see them locked with an upgrade nudge. Saves
// are optimistic and persist per repo via PUT /api/repositories/:id/workflow.
import React from "react";
import { useSearchParams } from "react-router-dom";
import {
  ReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  MarkerType,
  getBezierPath,
  useNodesState,
  useEdgesState,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "./icons";
import { api, type Repository, type RepoWorkflow, type ActionWorkflow, type RepoGuidanceItem } from "./api";
import { runSave } from "./optimistic-save";
import { useAuth } from "./auth-context";
import type { WorkflowHeaderState } from "./workflow-header";
import { EDGES, LAYOUT, NODE_W, edgeHandles, usedHandles, type EdgeKind, type NodeId } from "./workflow-graph";

type StageKey = "holistic" | "defects" | "deferrals" | "docs" | "crossRepo";

// How a node reads on the canvas + in the detail panel:
//  trigger  — an entry point (PR event, or a maintainer comment)
//  stage    — a pipeline step with its own controls (toggle / prompt)
//  branch   — one arm of a fork (e.g. whole-repo review vs. security backstop)
//  info     — a read-only step the agent always does; no controls, just a badge
type NodeKind = "trigger" | "stage" | "branch" | "info";

// Pipeline nodes (positions live in workflow-graph.ts). `stageKey` marks an optional stage in
// wf.stages; `badge` stamps an "always on" / "advisory" pill on read-only nodes; `lane`
// separates the maintainer entry path from the main PR lane.
type NodeDef = {
  id: NodeId;
  name: string;
  tag: string;        // category, shown in the detail-panel header
  icon: string;
  color: string;      // colour family (a CSS var): entry / context / criteria / review / security / quality / conventions / output
  short: string;      // brief description on the node
  desc: string;       // fuller description in the panel
  kind?: NodeKind;    // default "stage"
  mandatory?: boolean; // always runs — no on/off switch
  stageKey?: StageKey;
  advanced?: boolean; // node exposes Pro/Max-only switches
  readOnly?: boolean; // informational: panel shows desc + badge, no controls
  badge?: "always-on" | "advisory" | "auto";
  lane?: "pr" | "maintainer";
};

const NODE_DEFS: NodeDef[] = [
  // ── Main PR-review lane ──────────────────────────────────────────────────
  { id: "trigger", name: "New / updated PR", tag: "Trigger", icon: "play", color: "var(--info)", kind: "trigger", mandatory: true, advanced: true, lane: "pr",
    short: "Fires on PR opened / updated",
    desc: "Runs whenever a pull request is opened or updated. A new push to an open PR re-enters the pipeline as a re-review (which adds the new-commit intent step)." },
  { id: "ingest", name: "Ingest context", tag: "Context", icon: "doc", color: "var(--cyan)", mandatory: true, lane: "pr",
    short: "Diff, tickets, Looms & frames",
    desc: "Pull the diff, linked tickets, attached Looms & design frames, and the relevant slice of the repo index. Attach guidance materials below: videos, docs & PDFs the agent indexes and follows on every review of this repo." },
  { id: "criteria", name: "Synthesize criteria", tag: "Agent", icon: "brain", color: "var(--purple)", mandatory: true, lane: "pr",
    short: "Derive end goal & criteria",
    desc: "Derive the end goal & acceptance criteria the PR must meet." },
  { id: "newcommit", name: "New-commit intent review", tag: "Agent", icon: "git", color: "var(--purple)", kind: "info", readOnly: true, badge: "advisory", lane: "pr",
    short: "Re-reviews: new commits vs. intent",
    desc: "On a re-review after a fresh push, check the new commits against their own commit-message intent and the delta diff, then append acceptance criteria for any new checkable promises." },
  { id: "review", name: "Review diff", tag: "Agent", icon: "code", color: "var(--green)", mandatory: true, lane: "pr",
    short: "Diff vs. each criterion",
    desc: "Check the diff against each acceptance criterion." },
  { id: "holistic", name: "Whole-repo review", tag: "Agent", icon: "git", color: "var(--green)", kind: "branch", mandatory: false, stageKey: "holistic", lane: "pr",
    short: "Regressions, errors & security",
    desc: "Check the change against the repo index for regressions, critical errors & security flaws. Turning this off does NOT disable security. It reroutes to the security backstop, and the Security gate stays on." },
  { id: "backstop", name: "Security backstop", tag: "Security", icon: "shield", color: "var(--danger)", kind: "branch", readOnly: true, badge: "always-on", lane: "pr",
    short: "Security-only fallback",
    desc: "When the whole-repo review is off (or its index isn't built yet), a security-only pass still runs against the diff, so security is never skipped. Its custom prompt falls back to the whole-repo review's prompt when left blank." },
  { id: "secgate", name: "Security gate", tag: "Security", icon: "shield", color: "var(--danger)", kind: "info", readOnly: true, badge: "always-on", lane: "pr",
    short: "Always analyzed, can't be disabled",
    desc: "Security is analyzed on every review, whichever arm ran above. A vulnerability this PR introduces blocks the merge even in advisory mode." },
  { id: "preexisting", name: "Pre-existing vulnerabilities", tag: "Security", icon: "shield", color: "var(--danger)", kind: "info", readOnly: true, badge: "advisory", lane: "pr",
    short: "Surfaced from the index ⟲ re-verified",
    desc: "Surface vulnerabilities already living in files this PR touches or depends on (from the index security audit). Touched files are re-verified against the PR head, so a vuln this PR fixes is dropped and credited as resolved. Advisory, so it never blocks the merge." },
  { id: "defects", name: "Bug detection", tag: "Agent", icon: "bug", color: "var(--warn)", mandatory: false, stageKey: "defects", lane: "pr",
    short: "Correctness bugs, criteria aside",
    desc: "Review the changed code for correctness and robustness on its own terms: logic errors, null handling, error paths, async and concurrency, resource leaks, API misuse, data integrity. Independent of the acceptance criteria: a PR can meet every requirement and still be wrong. Runs on every PR whether or not the repo index is built. A bug severe enough to break a feature or lose data blocks the merge." },
  { id: "deferrals", name: "Deferred-work scan", tag: "Agent", icon: "warn", color: "var(--warn)", mandatory: false, stageKey: "deferrals", lane: "pr",
    short: "TODOs, stubs & silent punts",
    desc: "Catch self-admitted punts: TODOs, stubs, and NotImplemented buried in the diff." },
  { id: "docs", name: "DEVASIGN.md guidance", tag: "Agent", icon: "doc", color: "var(--pink)", mandatory: false, stageKey: "docs", lane: "pr",
    short: "Conventions & doc drift",
    desc: "Enforce your repo conventions & flag docs the change makes outdated." },
  { id: "crossrepo", name: "Cross-repo impact", tag: "Agent", icon: "git", color: "var(--pink)", mandatory: false, advanced: true, badge: "advisory", stageKey: "crossRepo", lane: "pr",
    short: "Breakage & parity across sibling repos",
    desc: "Check whether this PR breaks a consumer in another repository in your org, and flag capabilities it adds that sibling repos don't have yet. Reads the org map DevAsign builds in the background. Advisory, so it never blocks the merge." },
  { id: "verdict", name: "Post verdict", tag: "Output", icon: "check", color: "var(--lemon)", mandatory: true, advanced: true, lane: "pr",
    short: "Check Run + PR review + notify",
    desc: "Post the Check Run + PR review and notify your connected integrations." },
  { id: "actions", name: "Run GitHub Action", tag: "Action", icon: "terminal", color: "var(--lemon)", mandatory: false, advanced: true, lane: "pr",
    short: "Dispatch a workflow on finish",
    desc: "Dispatch a chosen GitHub Actions workflow after the review (workflow_dispatch)." },

  // ── Maintainer-feedback lane (second entry path, loops back to the trigger) ─
  { id: "mtrigger", name: "Maintainer comment", tag: "Trigger", icon: "message", color: "var(--info)", kind: "trigger", readOnly: true, lane: "maintainer",
    short: "Owner / member / collaborator reply",
    desc: "A comment from someone with authority over the repo (owner, member, or collaborator) re-enters the review to dispute a finding, raise the bar, or add context. Always on." },
  { id: "manalyze", name: "Analyze feedback", tag: "Agent", icon: "brain", color: "var(--purple)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    short: "Refine goal; classify the comment",
    desc: "Read the comment (and any videos/docs in it), refine the end goal, and classify it into disputes, re-opens, and brand-new criteria." },
  { id: "mrescore", name: "Re-score / re-open / add", tag: "Agent", icon: "brain", color: "var(--purple)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    short: "Clear FPs · re-open · raise the bar",
    desc: "Clear false positives (unmet→met, verified against the codebase), re-open passed criteria on the maintainer's authority (met→unmet), and add any new criteria. The security gate is never softened: a flip back to approved re-checks for introduced blockers first." },
  { id: "mguide", name: "Post guide / corrected verdict", tag: "Output", icon: "check", color: "var(--lemon)", kind: "info", readOnly: true, badge: "auto", lane: "maintainer",
    short: "Implementation guide or correction",
    desc: "Post an implementation guide (when the bar moved up) or a corrected verdict (when a dispute cleared). The developer's next push then loops back through the PR trigger." },
];

const USED_HANDLES = usedHandles(EDGES);

// One-click presets. Strict = maximum rigor; Balanced = quieter defaults;
// Light = lean + advisory (never blocks the merge). Only the core policy
// (trigger / stages / verdict) — actions are preserved on apply.
const TEMPLATES: Record<string, Pick<RepoWorkflow, "trigger" | "stages" | "verdict">> = {
  strict: {
    trigger: { onSynchronize: true, skipDrafts: false, skipBots: false },
    stages: { holistic: true, defects: true, docs: true, deferrals: true, crossRepo: true },
    verdict: { blocking: true },
  },
  balanced: {
    trigger: { onSynchronize: true, skipDrafts: true, skipBots: true },
    stages: { holistic: true, defects: true, docs: true, deferrals: true, crossRepo: true },
    verdict: { blocking: true },
  },
  light: {
    trigger: { onSynchronize: false, skipDrafts: true, skipBots: true },
    // Bug detection stays on even in Light: it's the one pass that catches a
    // wrong-but-criteria-satisfying diff. Light's verdict.blocking:false already
    // keeps it from stopping a merge.
    stages: { holistic: false, defects: true, docs: true, deferrals: false, crossRepo: false },
    verdict: { blocking: false },
  },
};


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
// optional stages off wf.stages[key]; the new-commit intent step only fires on
// re-reviews, so it dims when re-review-on-push is off. Everything else
// (mandatory steps, always-on security, the maintainer lane) is always lit —
// including the security backstop, which stays visible and shows "standby"
// while the whole-repo review covers security (see backstopStandby).
const nodeOn = (def: NodeDef, wf: RepoWorkflow) => {
  if (def.id === "actions") return !!wf.actions?.enabled;
  if (def.id === "newcommit") return !!wf.trigger.onSynchronize;
  if (def.stageKey) return !!wf.stages[def.stageKey];
  return true;
};

// The backstop is the fallback arm: idle while the whole-repo review is on.
const backstopStandby = (def: NodeDef, wf: RepoWorkflow) => def.id === "backstop" && !!wf.stages.holistic;

// Stamp a lock glyph only when ALL of a node's controls are Pro/Max-locked.
// Optional stages keep their (free) on/off switch, so they never get the glyph.
const nodeLocked = (def: NodeDef, advancedLocked: boolean) =>
  advancedLocked && (def.id === "trigger" || def.id === "verdict" || def.id === "actions");

// A node shows an on/off dot when it can be toggled (optional stage or the
// actions step) and isn't fully locked.
const nodeToggleable = (def: NodeDef) => !!def.stageKey || def.id === "actions";

// Does a workflow's core policy match a preset? (Ignores prompts & actions.)
const matchesPreset = (wf: RepoWorkflow, t: typeof TEMPLATES[string]) =>
  wf.trigger.onSynchronize === t.trigger.onSynchronize &&
  wf.trigger.skipDrafts === t.trigger.skipDrafts &&
  wf.trigger.skipBots === t.trigger.skipBots &&
  wf.stages.holistic === t.stages.holistic &&
  wf.stages.defects === t.stages.defects &&
  wf.stages.docs === t.stages.docs &&
  wf.stages.deferrals === t.stages.deferrals &&
  wf.verdict.blocking === t.verdict.blocking;

// The active preset, or "custom" once the workflow has been tweaked so it no
// longer matches Strict / Balanced / Light.
const activeMode = (wf: RepoWorkflow): string => {
  for (const [name, t] of Object.entries(TEMPLATES)) if (matchesPreset(wf, t)) return name;
  return "custom";
};

// Status chip text for read-only nodes.
const BADGE_TEXT: Record<NonNullable<NodeDef["badge"]>, string> = {
  "always-on": "always on",
  advisory: "advisory",
  auto: "auto",
};

// ── Custom React Flow node ──────────────────────────────────────────────────
const HANDLES = [
  { id: "tt", type: "target", pos: Position.Top }, { id: "ts", type: "source", pos: Position.Top },
  { id: "bt", type: "target", pos: Position.Bottom }, { id: "bs", type: "source", pos: Position.Bottom },
  { id: "lt", type: "target", pos: Position.Left }, { id: "ls", type: "source", pos: Position.Left },
  { id: "rt", type: "target", pos: Position.Right }, { id: "rs", type: "source", pos: Position.Right },
] as const;
const LANE_LABEL = { pr: "PR review", maintainer: "Maintainer" };

function StageNode({ data }: NodeProps) {
  const { def, on, selected, locked, handles, standby } = data as any;
  const status = standby ? "standby" : nodeToggleable(def) ? (on ? "on" : "off") : def.badge ? BADGE_TEXT[def.badge as keyof typeof BADGE_TEXT] : "always on";
  return (
    <div
      className={`wf-node wf-kind-${def.kind || "stage"} ${on ? "" : "is-off"} ${selected ? "is-selected" : ""}`}
      style={{ width: NODE_W, ["--nc" as any]: def.color }}
    >
      {HANDLES.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type={h.type}
          position={h.pos}
          isConnectable={false}
          className={`wf-node-handle ${handles.has(h.id) ? "" : "is-hidden"}`}
        />
      ))}
      <div className="wf-node-head">
        <span className="wf-node-ico"><Icon name={def.icon} size={16} /></span>
        <div className="wf-node-text">
          <div className="wf-node-name">{def.name}</div>
          <div className="wf-node-sub">{def.tag} / {LANE_LABEL[def.lane || "pr"]}</div>
        </div>
      </div>
      <div className="wf-node-chips">
        <span className={`wf-chip st-${status.replace(/\s+/g, "-")}`}>
          <span className="wf-chip-k">Status</span>{status}
        </span>
        {locked && (
          <span className="wf-chip is-pro" title="Pro/Max"><Icon name="lock" size={9} /> Pro</span>
        )}
      </div>
    </div>
  );
}
const nodeTypes = { stage: StageNode };

// Keep the fitted graph clear of the floating panel (right) and mode bar (top);
// on mobile the panel stacks below the canvas instead. The panel sits outside
// the canvas' un-zoomed box, so its size is scaled by the app zoom.
const uiZoom = () => parseFloat(getComputedStyle(document.body).zoom as string) || 1;
const PANEL_W = 340;
const fitViewFor = (isMobile: boolean, panelW: number) =>
  isMobile
    ? { padding: "16px", maxZoom: 1 }
    : { padding: { top: `${56 * uiZoom()}px`, right: `${(panelW + 32) * uiZoom()}px`, bottom: "24px", left: "24px" }, maxZoom: 1 };

// The detail panel's left edge lines up with the header's Verification button,
// whose width follows the repo's verification state — so measure, don't guess.
function usePanelWidth(): number {
  const [w, setW] = React.useState(PANEL_W);
  React.useEffect(() => {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    const measure = () => {
      const v = topbar.querySelector(".wf-verify");
      const actions = topbar.querySelector(".topbar-actions");
      if (!v || !actions) return setW(PANEL_W);
      setW(Math.round((actions.getBoundingClientRect().right - v.getBoundingClientRect().left) / uiZoom()));
    };
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(topbar, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", measure);
    return () => { mo.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return w;
}
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1.5;

// Bezier edge with a floating label chip (bold label + muted tag pills).
function ChipEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const d = (data || {}) as { kind?: EdgeKind; label?: string; tags?: string[] };
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {d.label && (
        <EdgeLabelRenderer>
          <div className={`wf-edge-chip is-${d.kind || "seq"}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            <b>{d.label}</b>
            {(d.tags || []).map((t) => <span key={t} className="wf-edge-tag">{t}</span>)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { chip: ChipEdge };

// Build the React Flow nodes/edges from the workflow + current selection.
function buildGraph(wf: RepoWorkflow, selectedId: string, advancedLocked: boolean) {
  const nodes = NODE_DEFS.map((def) => ({
    id: def.id,
    type: "stage",
    position: LAYOUT[def.id],
    data: {
      def,
      on: nodeOn(def, wf),
      selected: def.id === selectedId,
      locked: nodeLocked(def, advancedLocked),
      handles: USED_HANDLES.get(def.id) || new Set(),
      standby: backstopStandby(def, wf),
    },
    // Nodes can be dragged to re-space the layout; the wiring can't be changed.
    draggable: true,
    selectable: false,
  }));
  const edges = EDGES.map((e) => ({
    id: `${e.from}__${e.to}`,
    source: e.from,
    target: e.to,
    sourceHandle: edgeHandles(e).from,
    targetHandle: edgeHandles(e).to,
    type: "chip",
    data: { kind: e.kind || "seq", label: e.label, tags: e.tags },
    animated: e.kind === "loop",
    style: { stroke: "var(--wf-edge)", strokeWidth: 1.25, ...(e.kind === "loop" ? { strokeDasharray: "4 4" } : {}) },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--wf-edge)", width: 12, height: 12 },
  }));
  return { nodes, edges };
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
          <span>Dispatch a GitHub Actions workflow after each review. This is a Pro/Max feature. Upgrade to edit →</span>
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
            No Actions access yet. Grant the GitHub App <span className="mono">actions:read</span> /{" "}
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
  const m = e?.message || "Couldn't add. Try again.";
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
          <span>Attach videos, docs & PDFs the agent must follow on every review. This is a Pro/Max feature. Upgrade to add →</span>
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
      ) : items.length === 0 ? null : (
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
function NodeDetails({ def, wf, repoId, advancedLocked, onToggleStage, onToggleTrigger, onToggleBlocking, onSaveActions }) {
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
              <span className="pill" style={{ color: "var(--green)" }}><i className="dot" /> Always on, can't be disabled</span>
            ) : def.badge === "advisory" ? (
              <span className="pill" style={{ color: "var(--warn)" }}><i className="dot" /> Advisory, never blocks the merge</span>
            ) : (
              <span className="pill" style={{ color: "var(--fg-mute)" }}><i className="dot" /> Automatic</span>
            )}
            {def.id === "newcommit" && !on && (
              <div className="wf-ctl-desc mute">Inactive right now: “Re-review on new pushes” is off, so re-reviews don't run.</div>
            )}
            {def.id === "backstop" && (
              <div className="wf-ctl-desc mute">
                {backstopStandby(def, wf)
                  ? "Standby: the whole-repo review is on and already covers security."
                  : "Active now: the whole-repo review is off, so this security-only pass is what runs."}
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
            Turning this off doesn't disable security. A security-only backstop still runs and the Security gate stays on.
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
                    : "advisory COMMENT, never blocks the merge"}
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
        {def.mandatory && def.id !== "trigger" && def.id !== "verdict" && (
          <span className="pill" style={{ color: "var(--fg-mute)" }}>
            <i className="dot" /> always on
          </span>
        )}

        {/* Ingest node: repo-scoped guidance materials (ADVANCED). */}
        {def.id === "ingest" && (
          <GuidanceEditor key={repoId} repoId={repoId} locked={advancedLocked} />
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

const WorkflowPage = ({ onHeader, isMobile = false }: { onHeader?: (s: WorkflowHeaderState | null) => void; isMobile?: boolean } = {}) => {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [repos, setRepos] = React.useState<Repository[]>([]);
  // `?repo=<id>` preselects a repo (the fix link on an unverifiable criterion lands here).
  const [repoId, setRepoId] = React.useState<string>(params.get("repo") || "");
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
  // Always reflects the currently-selected repo (assigned every render), so a
  // deferred save can tell whether the user switched repos while it was in flight.
  const repoIdRef = React.useRef(repoId);
  repoIdRef.current = repoId;

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const flowRef = React.useRef<HTMLDivElement>(null);
  const rfInst = React.useRef<any>(null);

  // Cmd/Ctrl + wheel zooms about the pointer. Handled here (capture phase, ahead
  // of React Flow's own wheel handler) so it works whatever key state RF tracks.
  React.useEffect(() => {
    const el = flowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !rfInst.current) return;
      e.preventDefault();
      e.stopPropagation();
      const inst = rfInst.current;
      const { x, y, zoom } = inst.getViewport();
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.pow(2, -e.deltaY * 0.01)));
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      inst.setViewport({ x: px - ((px - x) / zoom) * next, y: py - ((py - y) / zoom) * next, zoom: next });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true } as any);
  }, [wf]);

  // Load the user's repos once; default to the first.
  React.useEffect(() => {
    let alive = true;
    api
      .repositories()
      .then((rs) => {
        if (!alive) return;
        setRepos(rs);
        setRepoId((cur) => (cur && rs.some((r) => r.id === cur) ? cur : rs[0]?.id || ""));
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

  // Optimistic save with durability-aware error handling: paint `next` immediately,
  // keep it on a transient `not_durable` (re-confirming once), revert on a hard
  // failure. The state machine lives in runSave (optimistic-save.ts) so it can be
  // unit-tested without a DOM; here we just bind it to React state + refs.
  const save = React.useCallback(
    (next: RepoWorkflow, isRetry = false) =>
      runSave(
        {
          scopeId: repoId,
          activeScopeId: () => repoIdRef.current,
          getPrev: () => wf,
          persist: (id, n) => api.setRepoWorkflow(id, n),
          setValue: setWf,
          setErr,
          setPending,
          seqRef: saveSeq,
          retryTimer,
          scheduleRetry: (fn, ms) => setTimeout(fn, ms),
        },
        next,
        isRetry
      ),
    [repoId, wf]
  );

  // Drop any pending re-confirm if the page unmounts mid-wait.
  React.useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    []
  );

  // Switching repos invalidates any in-flight or scheduled save for the previous
  // repo: bump the token so its deferred state no-ops, drop the pending re-confirm,
  // and clear the transient notice/error so the new repo starts from a clean slate.
  React.useEffect(() => {
    saveSeq.current++;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    setPending(false);
    setErr(null);
  }, [repoId]);

  // Basic (free): toggle which optional stages run.
  const toggleStage = (key: StageKey) =>
    wf && save({ ...wf, stages: { ...wf.stages, [key]: !wf.stages[key] } });

  // Advanced (paid): trigger policy + verdict mode + actions.
  const toggleTrigger = (key: string) => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, trigger: { ...wf.trigger, [key]: !wf.trigger[key] } });
  };
  const toggleBlocking = () => {
    if (advancedLocked) return goUpgrade();
    if (wf) save({ ...wf, verdict: { blocking: !wf.verdict.blocking } });
  };
  const saveActions = (patch: Partial<RepoWorkflow["actions"]>) => {
    if (advancedLocked) return goUpgrade();
    if (!wf) return;
    const actions = { enabled: false, workflow: "", runWhen: "passed", ...(wf.actions || {}), ...patch };
    save({ ...wf, actions });
  };
  // Apply a mode but preserve actions (merge over the current workflow).
  const applyMode = (name: string) => {
    if (advancedLocked) return goUpgrade();
    if (!wf) return;
    save({ ...wf, version: 1, ...TEMPLATES[name] });
  };

  const repo = repos.find((r) => r.id === repoId) || null;
  const selectedDef = NODE_DEFS.find((n) => n.id === selectedId) || null;
  const noRepos = repos.length === 0 && !loading;
  const mode = wf ? activeMode(wf) : null;
  const panelW = usePanelWidth();
  const fit = React.useMemo(() => fitViewFor(isMobile, panelW), [isMobile, panelW]);

  const select = React.useCallback(
    (id: string) => {
      setRepoId(id);
      setParams({ repo: id }, { replace: true });
    },
    [setParams]
  );

  // Surface the repo picker + selected repo's details to the app header.
  // Cleared on unmount so other pages don't inherit it.
  React.useEffect(() => {
    onHeader?.({ repos, repoId, repo, select });
  }, [repos, repoId, repo, select, onHeader]);
  React.useEffect(() => () => onHeader?.(null), [onHeader]);

  return (
    <div className="wf-layout" style={{ ["--wf-panel-w" as any]: `${panelW}px` }}>
      <div className="wf-flow" ref={flowRef}>
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
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => setSelectedId(n.id as NodeId)}
            onInit={(inst) => { rfInst.current = inst; requestAnimationFrame(() => inst.fitView(fit)); }}
            fitView
            fitViewOptions={fit}
            minZoom={ZOOM_MIN}
            maxZoom={ZOOM_MAX}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            panOnScroll
            proOptions={{ hideAttribution: false }}
          />
        )}
      </div>

      {/* Mode selector — floats top-left over the canvas. */}
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