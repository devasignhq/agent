// node --import tsx/esm --test src/artifacts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planUploads, resolveArtifactRefs } from "./artifacts.js";
import { Workspace } from "./workspace.js";
import type { LocalArtifact } from "./types.js";

test("planUploads honours per-file, total, and count limits, evidence first", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dv-art-"));
  const mk = (name: string, bytes: number, kind: LocalArtifact["kind"]): LocalArtifact => {
    const p = path.join(dir, name);
    writeFileSync(p, Buffer.alloc(bytes));
    return { clientRef: name, kind, path: p, displayPath: name, contentType: "x", criterionIds: [] };
  };
  const arts = [mk("big.webm", 5000, "video"), mk("a.log", 10, "log"), mk("t.txt", 10, "test_file"), mk("v2.webm", 100, "video"), { clientRef: "gone", kind: "log", path: path.join(dir, "nope"), displayPath: "nope", contentType: "x", criterionIds: [] } as LocalArtifact];
  const { files, skipped } = planUploads(arts, { maxFileBytes: 1000, maxTotalBytes: 150, maxFiles: 10 });
  assert.deepEqual(files.map((f) => f.clientRef), ["a.log", "t.txt", "v2.webm"]);
  assert.deepEqual(skipped.map((s) => [s.clientRef, s.reason]), [["gone", "missing"], ["big.webm", "too_large"]]);
  const capped = planUploads(arts.slice(0, 4), { maxFileBytes: 10_000, maxTotalBytes: 10_000, maxFiles: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.skipped.filter((s) => s.reason === "quota").length, 2);
});

test("resolveArtifactRefs swaps refs for ids and drops unuploaded ones", () => {
  const out = resolveArtifactRefs([{ id: "r", testId: "t", criterionIds: [], test: "x", runner: "bundled", level: "unit", origin: "generated", status: "pass", durationMs: 1, artifactIds: ["log:1", "missing"], attempts: [{ n: 1, status: "pass", durationMs: 1, artifactIds: ["log:1"] }] }], new Map([["log:1", "id-1"]]));
  assert.deepEqual(out[0].artifactIds, ["id-1"]);
  assert.deepEqual(out[0].attempts[0].artifactIds, ["id-1"]);
});

test("Workspace writes only under .devasign/ and cleanup removes what it created, keeping a pre-existing dir", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-ws-"));
  const ws = new Workspace(root);
  ws.write(".devasign/tests/a.test.ts", "x");
  assert.throws(() => ws.write("package.json", "{}"), /refusing to write outside/);
  assert.throws(() => ws.write("../escape.ts", "x"), /refusing to write outside/);
  ws.cleanup();
  assert.equal(existsSync(path.join(root, ".devasign")), false);
  const root2 = mkdtempSync(path.join(os.tmpdir(), "dv-ws2-"));
  mkdirSync(path.join(root2, ".devasign", "hooks"), { recursive: true });
  writeFileSync(path.join(root2, ".devasign", "hooks", "pre-push"), "#!/bin/sh");
  const ws2 = new Workspace(root2);
  ws2.write(".devasign/tests/b.test.ts", "x");
  ws2.cleanup();
  assert.equal(existsSync(path.join(root2, ".devasign", "hooks", "pre-push")), true, "the customer's hooks survive");
  assert.equal(existsSync(path.join(root2, ".devasign", "tests")), false);
});
