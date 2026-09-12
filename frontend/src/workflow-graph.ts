// Pure layout + wiring tables for the Workflow canvas (no React), so the
// geometry can be unit-tested. screen-workflow.tsx renders them.
export type NodeId =
  // Main PR-review lane
  | "trigger" | "ingest" | "criteria" | "newcommit" | "review"
  | "holistic" | "backstop" | "secgate" | "preexisting"
  | "defects" | "deferrals" | "docs" | "crossrepo" | "verdict" | "actions"
  // Maintainer-feedback lane (second entry path + loop back)
  | "mtrigger" | "manalyze" | "mrescore" | "mguide";

export const NODE_W = 260;   // card width (mirrored by .wf-node)
export const NODE_H = 100;   // approximate card height, for overlap checks

// The PR lane runs clockwise as a ring: left→right along the top row, down at
// the far right, right→left along the bottom row. The maintainer lane sits
// inside the ring and loops back up into the trigger.
const CX = 340;        // column pitch
const TOP = 0;
const MID = 210;       // maintainer lane
const BOT = 420;
const FORK = 160;      // security fork arms sit this far above/below the top row
const col = (c: number) => c * CX;

export const LAYOUT: Record<NodeId, { x: number; y: number }> = {
  trigger: { x: col(0), y: TOP },
  ingest: { x: col(1), y: TOP },
  criteria: { x: col(2), y: TOP },
  newcommit: { x: col(1), y: TOP - FORK },
  review: { x: col(3), y: TOP },
  holistic: { x: col(4), y: TOP - FORK },
  backstop: { x: col(4), y: TOP + FORK },
  secgate: { x: col(5), y: TOP },
  preexisting: { x: col(6), y: TOP },
  defects: { x: col(7), y: TOP },
  deferrals: { x: col(7), y: BOT },
  docs: { x: col(6), y: BOT },
  crossrepo: { x: col(5), y: BOT },
  verdict: { x: col(4), y: BOT },
  actions: { x: col(3), y: BOT },
  mtrigger: { x: col(3), y: MID },
  manalyze: { x: col(2), y: MID },
  mrescore: { x: col(1), y: MID },
  mguide: { x: col(0), y: MID },
};

// Handle ids: side {t,b,l,r} + {t,s} target/source. Default wiring is
// right-source → left-target.
export const HANDLE_IDS = ["tt", "ts", "bt", "bs", "lt", "ls", "rt", "rs"] as const;
export type HandleId = (typeof HANDLE_IDS)[number];

export type EdgeKind = "seq" | "branch" | "loop";
export type EdgeDef = { from: NodeId; to: NodeId; fromH?: HandleId; toH?: HandleId; kind?: EdgeKind; label?: string; tags?: string[] };

export const EDGES: EdgeDef[] = [
  // Main lane — top row
  { from: "trigger", to: "ingest" },
  { from: "ingest", to: "criteria" },
  { from: "criteria", to: "review" },
  // New-commit intent offshoot (re-review only) → appends criteria
  { from: "trigger", to: "newcommit", fromH: "ts", toH: "lt", kind: "branch", label: "re-review", tags: ["new push"] },
  { from: "newcommit", to: "criteria", fromH: "rs", toH: "tt", kind: "branch", label: "append criteria" },
  // Security fork off the diff review, merging into the always-on gate
  { from: "review", to: "holistic", kind: "branch", label: "whole-repo", tags: ["on"] },
  { from: "review", to: "backstop", kind: "branch", label: "whole-repo", tags: ["off", "security only"] },
  { from: "holistic", to: "secgate" },
  { from: "backstop", to: "secgate" },
  { from: "secgate", to: "preexisting" },
  { from: "preexisting", to: "defects" },
  // Turn down at the far right, then flow back along the bottom row
  { from: "defects", to: "deferrals", fromH: "bs", toH: "tt" },
  { from: "deferrals", to: "docs", fromH: "ls", toH: "rt" },
  { from: "docs", to: "crossrepo", fromH: "ls", toH: "rt" },
  { from: "crossrepo", to: "verdict", fromH: "ls", toH: "rt" },
  { from: "verdict", to: "actions", fromH: "ls", toH: "rt" },
  // Maintainer-feedback lane (inside the ring) + loop back into the PR trigger
  { from: "mtrigger", to: "manalyze", fromH: "ls", toH: "rt" },
  { from: "manalyze", to: "mrescore", fromH: "ls", toH: "rt" },
  { from: "mrescore", to: "mguide", fromH: "ls", toH: "rt" },
  { from: "mguide", to: "trigger", fromH: "ts", toH: "bt", kind: "loop", label: "dev pushes", tags: ["re-review"] },
];

export const edgeHandles = (e: EdgeDef): { from: HandleId; to: HandleId } => ({ from: e.fromH || "rs", to: e.toH || "lt" });

export function usedHandles(edges: EdgeDef[]): Map<NodeId, Set<HandleId>> {
  const m = new Map<NodeId, Set<HandleId>>();
  const add = (id: NodeId, h: HandleId) => (m.get(id) || m.set(id, new Set()).get(id)!).add(h);
  for (const e of edges) {
    const h = edgeHandles(e);
    add(e.from, h.from);
    add(e.to, h.to);
  }
  return m;
}
