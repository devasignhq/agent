import { test } from "node:test";
import assert from "node:assert/strict";
import { EDGES, HANDLE_IDS, LAYOUT, NODE_H, NODE_W, edgeHandles, usedHandles, type NodeId } from "./workflow-graph.ts";

const ids = Object.keys(LAYOUT) as NodeId[];

test("every edge joins two laid-out nodes through valid handles", () => {
  for (const e of EDGES) {
    assert.ok(LAYOUT[e.from], `unknown source ${e.from}`);
    assert.ok(LAYOUT[e.to], `unknown target ${e.to}`);
    const h = edgeHandles(e);
    assert.ok(HANDLE_IDS.includes(h.from) && h.from.endsWith("s"), `${e.from}→${e.to}: source handle ${h.from}`);
    assert.ok(HANDLE_IDS.includes(h.to) && h.to.endsWith("t"), `${e.from}→${e.to}: target handle ${h.to}`);
  }
});

test("no two cards overlap", () => {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = LAYOUT[ids[i]], b = LAYOUT[ids[j]];
      const apart = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
      assert.ok(apart, `${ids[i]} overlaps ${ids[j]}`);
    }
  }
});

// A bezier whose target sits behind its source handle curls back on itself.
test("horizontal edges point the way they flow", () => {
  for (const e of EDGES) {
    const h = edgeHandles(e);
    const a = LAYOUT[e.from], b = LAYOUT[e.to];
    if (h.from === "rs" && h.to === "lt") assert.ok(b.x >= a.x + NODE_W, `${e.from}→${e.to} flows right but target is behind`);
    if (h.from === "ls" && h.to === "rt") assert.ok(b.x + NODE_W <= a.x, `${e.from}→${e.to} flows left but target is ahead`);
    if (h.from === "bs" && h.to === "tt") assert.ok(b.y >= a.y + NODE_H, `${e.from}→${e.to} flows down but target is above`);
    if (h.from === "ts" && h.to === "bt") assert.ok(b.y + NODE_H <= a.y, `${e.from}→${e.to} flows up but target is below`);
  }
});

test("every node is wired and only its used sides get a visible handle", () => {
  const used = usedHandles(EDGES);
  for (const id of ids) assert.ok(used.get(id)?.size, `${id} has no edges`);
  assert.deepEqual([...used.get("trigger")!].sort(), ["bt", "rs", "ts"]);
  assert.deepEqual([...used.get("deferrals")!].sort(), ["ls", "tt"]);
});

test("the pipeline is one connected graph with both entry points reaching the verdict", () => {
  const next = new Map<NodeId, NodeId[]>();
  for (const e of EDGES) next.set(e.from, [...(next.get(e.from) || []), e.to]);
  const reach = (start: NodeId) => {
    const seen = new Set<NodeId>([start]);
    const stack = [start];
    while (stack.length) for (const n of next.get(stack.pop()!) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return seen;
  };
  assert.ok(reach("trigger").has("actions"));
  assert.ok(reach("mtrigger").has("verdict"));
  assert.equal(reach("mtrigger").size, ids.length);
});
