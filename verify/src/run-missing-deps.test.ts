// A generated test that loads a package's source dies on that package's missing
// node_modules; the run reports it as a setup diagnosis, not a failed criterion.
//   node --import tsx/esm --test src/run-missing-deps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./run.js";
import { staticTokenSource } from "./oidc.js";
import type { RunnerPlan, RunnerResults } from "./types.js";

const plan: RunnerPlan = {
  planId: "plan-deps",
  criteriaRevision: 1,
  criteria: [{ id: "1", text: "config loads", kind: "code" }],
  tests: [
    {
      id: "t1",
      path: ".devasign/tests/config.test.ts",
      content: 'import { test } from "node:test";\nimport { cfg } from "../../backend/src/config.ts";\ntest("cfg", () => { if (!cfg) throw new Error("no cfg"); });\n',
      criterionIds: ["1"],
      level: "unit",
      levelReason: "",
      origin: "generated",
      runner: "node-test",
      testSignature: "s",
      strategyVersion: 1,
      targetFiles: ["backend/src/config.ts"],
    },
  ],
  commands: [],
  playwright: { record: true, configFrom: null, installBrowsers: false },
  retries: { generated: 1, existing: 0 },
  uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 10 },
  unverifiable: [],
};

test("a package whose dependencies were never installed is diagnosed as missing_dependencies, with the install the workflow needs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dv-deps-"));
  mkdirSync(path.join(dir, "backend/src"), { recursive: true });
  writeFileSync(path.join(dir, "backend/package.json"), JSON.stringify({ name: "backend", type: "module", dependencies: { dotenv: "^16" } }));
  writeFileSync(path.join(dir, "backend/package-lock.json"), "{}");
  writeFileSync(path.join(dir, "backend/src/config.ts"), 'import "dotenv/config";\nexport const cfg = { ok: true };\n');
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const out = path.join(dir, "results.json");
  try {
    const code = await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 30_000, keep: false, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out });
    assert.equal(code, 0);
    const results: RunnerResults = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(results.results[0].status, "error");
    assert.equal(results.results[0].attempts.length, 1, "a load failure is not retried");
    assert.equal(results.doctor?.code, "missing_dependencies");
    assert.equal(results.doctor?.stage, "install");
    assert.deepEqual(results.doctor?.packages, [{ dir: "backend", install: "npm ci --prefix backend" }]);
    assert.match(results.doctor!.message, /backend\/ \(dotenv\)/);
    assert.match(results.doctor!.suggestedFix!.instructions, /`npm ci --prefix backend`/);
    assert.deepEqual(results.setup?.packages, ["backend"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
