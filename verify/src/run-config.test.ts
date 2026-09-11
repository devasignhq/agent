// A branch cut before onboarding has no .devasign.yml; the runner boots from the plan's copy.
//   node --import tsx/esm --test src/run-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./run.js";
import { staticTokenSource } from "./oidc.js";
import type { RunnerPlan, RunnerResults } from "./types.js";

const MISSING = "DEVASIGN_RUN_CONFIG_TEST_UNSET";

const plan = (verifyConfig?: RunnerPlan["verifyConfig"]): RunnerPlan => ({
  planId: "plan-boot",
  criteriaRevision: 1,
  criteria: [{ id: "1", text: "The pill offers a shape toggle", kind: "ui" }],
  tests: [
    {
      id: "t1",
      path: ".devasign/tests/e2e/pill.spec.ts",
      content: 'import { test } from "@playwright/test";\ntest("pill", async () => {});\n',
      criterionIds: ["1"],
      level: "e2e",
      levelReason: "",
      origin: "generated",
      runner: "playwright",
      testSignature: "s",
      strategyVersion: 1,
      targetFiles: [],
    },
  ],
  commands: [],
  playwright: { record: true, configFrom: null, installBrowsers: true },
  retries: { generated: 0, existing: 0 },
  uploadLimits: { maxFileBytes: 1e6, maxTotalBytes: 1e6, maxFiles: 10 },
  unverifiable: [],
  ...(verifyConfig ? { verifyConfig } : {}),
});

async function doctorFor(p: RunnerPlan): Promise<RunnerResults["doctor"]> {
  const dir = mkdtempSync(path.join(tmpdir(), "dv-boot-"));
  writeFileSync(path.join(dir, "index.html"), "<main></main>\n");
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(p));
  const out = path.join(dir, "results.json");
  try {
    const code = await run({ apiUrl: "", token: staticTokenSource("t"), resolveTimeoutMs: 1_000, testTimeoutMs: 30_000, keep: false, cwd: dir, planFile: path.join(dir, "plan.json"), resultsOut: out });
    assert.equal(code, 0);
    return JSON.parse(readFileSync(out, "utf8")).doctor;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a checkout without a verify block boots the app from the one the plan carries", async () => {
  delete process.env[MISSING];
  // An env var the job lacks stops preflight before any browser spawns, and it can only
  // come from the plan's block — so the diagnosis says which block the runner used.
  const doctor = await doctorFor(plan({ start: "npm run dev", url: "http://localhost:5173", env: [MISSING] }));
  assert.equal(doctor?.code, "missing_secret");
  assert.deepEqual(doctor?.missingSecrets, [MISSING]);
});

test("with no verify block anywhere, the runner still reports that nothing tells it how to start the app", async () => {
  const doctor = await doctorFor(plan());
  assert.equal(doctor?.code, "no_start_command");
});
