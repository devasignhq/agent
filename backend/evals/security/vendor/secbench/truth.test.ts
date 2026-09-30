// The benchmark's ground truth, proven by running it. Every case's control and
// probe execute against both fixture trees and must land on the verdict
// manifest.json claims — so a fixture that stops being vulnerable (or a decoy
// that becomes exploitable) fails here instead of quietly skewing the eval.
// Uses the shipped judgeProof, so the benchmark and production share one rule.
// No network (fetch is stubbed) / no LLM. Run:
//   DATABASE_URL= node --import tsx/esm --test evals/security/vendor/secbench/truth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeProof, type AttemptOutcome } from "../../../../src/security/proof.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(HERE, "manifest.json"), "utf8")) as Manifest;
const ATTEMPTS = 2;

type Expected = "verified" | "not_reproduced" | "untestable:not_reachable" | "not_verified";
type Case = {
  id: string;
  kind: "real" | "decoy";
  title: string;
  path: string;
  symbol?: string;
  classAliases: string[];
  proof: "runtime" | "reachability" | "none";
  entry?: string;
  expected: Record<"vulnerable" | "fixed", Expected>;
};
type Manifest = { version: number; trees: Record<string, string>; cases: Case[] };

let sqliteAvailable = true;
try {
  await import("node:sqlite");
} catch {
  sqliteAvailable = false;
}
const skip = sqliteAvailable ? false : "node:sqlite is unavailable (needs Node >= 22.13)";

// Mirrors the CLI's rule (verify/src/classify.ts): only assertion evidence is a
// failure; any other throw is an error and can never prove a finding.
async function attempt(run: () => Promise<void>): Promise<AttemptOutcome> {
  try {
    await run();
    return "pass";
  } catch (err: any) {
    return err?.code === "ERR_ASSERTION" ? "fail" : "error";
  }
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

test("the two trees hold the same files and differ only in the manifest's real-bug files", () => {
  const vulnerable = path.join(HERE, manifest.trees.vulnerable);
  const fixed = path.join(HERE, manifest.trees.fixed);
  assert.deepEqual(filesUnder(vulnerable), filesUnder(fixed), "the trees must carry an identical path set");

  const differing = filesUnder(vulnerable).filter(
    (rel) => readFileSync(path.join(vulnerable, rel), "utf8") !== readFileSync(path.join(fixed, rel), "utf8")
  );
  const realPaths = manifest.cases.filter((c) => c.kind === "real").map((c) => c.path);
  assert.deepEqual([...differing].sort(), [...realPaths].sort());
});

test("every runtime case reaches the app only through createApp", () => {
  for (const c of manifest.cases.filter((x) => x.proof === "runtime")) {
    const source = readFileSync(path.join(HERE, "cases", `${c.id}.ts`), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec === "node:assert/strict" || spec === "../harness.ts",
        `${c.id} imports ${spec}; cases may only use the harness and node:assert`
      );
    }
  }
});

for (const tree of ["vulnerable", "fixed"] as const) {
  for (const c of manifest.cases.filter((x) => x.proof === "runtime")) {
    test(`${tree}: ${c.id} — ${c.title}`, { skip }, async () => {
      const { bootTree } = await import("./harness.ts");
      const { control, probe } = await import(`./cases/${c.id}.ts`);
      const booted = await bootTree(tree);
      try {
        const controls: AttemptOutcome[] = [];
        const probes: AttemptOutcome[] = [];
        for (let i = 0; i < ATTEMPTS; i++) controls.push(await attempt(() => control(booted.ctx)));
        for (let i = 0; i < ATTEMPTS; i++) probes.push(await attempt(() => probe(booted.ctx)));

        assert.deepEqual(
          controls,
          Array(ATTEMPTS).fill("pass"),
          `the control must pass on every attempt, else the test is broken rather than the app (got ${controls.join(",")})`
        );
        const verdict = judgeProof({ control: controls, probe: probes });
        assert.equal(
          verdict.status,
          c.expected[tree],
          `expected ${c.expected[tree]}, got ${verdict.status}${verdict.reason ? `/${verdict.reason}` : ""} from probes ${probes.join(",")}`
        );
      } finally {
        await booted.close();
      }
    });
  }
}

for (const tree of ["vulnerable", "fixed"] as const) {
  for (const c of manifest.cases.filter((x) => x.proof === "reachability")) {
    test(`${tree}: ${c.id} — ${c.title}`, { skip }, async () => {
      const { isReachable } = await import("./harness.ts");
      assert.equal(c.expected[tree], "untestable:not_reachable");
      assert.equal(
        isReachable(tree, c.entry ?? "src/server.ts", c.path),
        false,
        `${c.path} is reachable from ${c.entry}, so it is not an unreachable-code decoy any more`
      );
    });
  }
}

test("the manifest covers every case file, and vice versa", () => {
  const onDisk = readdirSync(path.join(HERE, "cases"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  const expected = manifest.cases.filter((c) => c.proof === "runtime").map((c) => c.id).sort();
  assert.deepEqual(onDisk, expected);
});
