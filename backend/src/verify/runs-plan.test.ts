// Offline: what the runner is handed must carry the plan's uncovered criteria
// and the repo's fail-on default, or CI cannot say why nothing ran.
//   DATABASE_URL= node --import tsx/esm --test src/verify/runs-plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { buildRunView, e2eGate, runnerPlanFor } from "./runs.js";
import { setArtifactStorageForTests, type ArtifactStorage } from "./storage.js";
import type { Repository, VerifyArtifact, VerifyPlan, VerifyRun } from "../types.js";

const run = { reviewId: "no-such-review", criteriaRevision: 1 } as VerifyRun;
const plan = {
  id: "p1",
  criteriaRevision: 1,
  tests: [],
  commands: [],
  unverifiable: [{ criterionId: "1", reason: "no app start / login configured", fixUrl: "https://app/workflow?repo=r" }],
} as unknown as VerifyPlan;

test("runnerPlanFor carries unverifiable reasons with their fix links and defaults fail-on to never", () => {
  const out = runnerPlanFor(run, plan, {} as Repository);
  assert.deepEqual(out.unverifiable, plan.unverifiable);
  assert.equal(out.failOn, "never");
});

test("runnerPlanFor passes the repo's stored fail-on setting through, including unverifiable", () => {
  const strict = runnerPlanFor(run, plan, { workflow: { verify: { e2e: "auto", failOn: "unverifiable" } } } as unknown as Repository);
  assert.equal(strict.failOn, "unverifiable");
  const legacy = runnerPlanFor(run, plan, { workflow: { verify: { failOn: "bogus" } } } as unknown as Repository);
  assert.equal(legacy.failOn, "never");
});

test("runnerPlanFor hands the runner the verify block the plan was made with, and none when it had none", () => {
  const verifyConfig = { start: "npm run dev -- --port 5173", url: "http://localhost:5173", ready: "/" };
  const out = runnerPlanFor(run, { ...plan, verifyConfig, verifyConfigFrom: "base" } as VerifyPlan, {} as Repository);
  assert.deepEqual(out.verifyConfig, verifyConfig);
  assert.equal("verifyConfig" in runnerPlanFor(run, plan, {} as Repository), false);
});

test("e2eGate holds browser tests back only from plans that need the runner's managed boot", () => {
  const start = { start: "npm run dev", url: "http://localhost:5173" };
  const tests = [{ runner: "vitest" }, { runner: "playwright" }] as VerifyPlan["tests"];
  const servers = { tests, verifyConfig: { ...start, servers: [{ name: "api", start: "npm run api", url: "http://localhost:4000" }] } };
  assert.equal(e2eGate(servers, undefined, true), "runner_outdated");
  assert.equal(e2eGate(servers, ["boot_probe"], true), "runner_outdated");
  assert.equal(e2eGate(servers, ["managed_boot"], true), null);
  assert.equal(e2eGate(servers, ["managed_boot"], false), "managed_boot_off");
  assert.equal(e2eGate(servers, undefined, false), "managed_boot_off", "an update would not help while the switch is off");
  assert.equal(e2eGate({ ...servers, tests: tests.slice(0, 1) }, undefined, false), null, "nothing to hold back without browser tests");
  assert.equal(e2eGate({ tests, verifyConfig: { ...start, login: { script: "node login.mjs" } } }, [], true), "runner_outdated");
  assert.equal(e2eGate({ tests, verifyConfig: { ...start, login: { strategy: "form" } } }, [], true), null, "legacy strategies need nothing new");
  assert.equal(e2eGate({ tests, verifyConfig: start, verifyConfigFrom: "base_boot" }, [], true), "runner_outdated");
  assert.equal(e2eGate({ tests, verifyConfig: start, verifyConfigFrom: "base_boot" }, ["managed_boot"], false), null, "base start/url boots through webServer, which the switch leaves on");
  assert.equal(e2eGate({ tests, verifyConfig: start, verifyConfigFrom: "base_boot" }, undefined, false), "runner_outdated", "an old runner still boots from its start-less checkout block");
  assert.equal(e2eGate({ ...servers, verifyConfigFrom: "base_boot" }, ["managed_boot"], false), "managed_boot_off");
  assert.equal(e2eGate({ tests, verifyConfig: start, verifyConfigFrom: "base" }, [], false), null);
  assert.equal(e2eGate({ tests }, undefined, false), null);
});

test("a withheld plan keeps a mixed command's other tests and leaves commands without tests alone", () => {
  const t = (id: string, runner: string) => ({ id, runner, criterionIds: ["1"] });
  const mixed = {
    ...plan,
    verifyConfig: { start: "s", url: "http://localhost:1", login: { script: "node login.mjs" } },
    tests: [t("pw", "playwright"), t("u", "vitest")],
    commands: [
      { id: "mixed", runner: "vitest", cmd: "x", testIds: ["pw", "u"], timeoutMs: 1 },
      { id: "only-pw", runner: "playwright", cmd: "y", testIds: ["pw"], timeoutMs: 1 },
      { id: "none", runner: "bundled", cmd: "z", testIds: [], timeoutMs: 1 },
    ],
  } as unknown as VerifyPlan;
  const out = runnerPlanFor(run, mixed, {} as Repository);
  assert.deepEqual(out.commands.map((c) => [c.id, c.testIds]), [["mixed", ["u"]], ["none", []]]);
  assert.deepEqual(mixed.commands[0].testIds, ["pw", "u"], "the stored plan is not mutated");
  assert.equal(runnerPlanFor(run, mixed, {} as Repository, { capabilities: ["managed_boot"] }).commands.length, 3);
});

test("a signed-in run's trace links expire within 300s; other artifacts and plans keep the configured TTL", async () => {
  const ttls = new Map<string, number>();
  const fake: ArtifactStorage = {
    signPut: async () => ({ url: "", headers: {} }),
    signGet: async (key, ttl) => (ttls.set(key, ttl), `https://r2/${key}`),
    head: async () => null,
    remove: async () => {},
  };
  const prevTtl = config.artifacts.getUrlTtlSeconds;
  const ids: string[] = [];
  const view = async (verifyConfig?: VerifyPlan["verifyConfig"]) => {
    const runId = uuid(), planId = uuid();
    ids.push(runId);
    db.insert("verifyPlans", { ...plan, id: planId, runId, ...(verifyConfig ? { verifyConfig } : {}) } as VerifyPlan);
    for (const kind of ["trace", "video"] as const) {
      db.insert("verifyArtifacts", { id: `${runId}-${kind}`, schemaVersion: 1, runId, repoId: "r", criterionIds: [], kind, path: kind, storageKey: `${runId}/${kind}`, bytes: 1, contentType: "x", posterArtifactId: null, state: "uploaded", expiresAt: Date.now() + 1e6, uploadedAt: 1, expiredAt: null, createdAt: 1 } as VerifyArtifact);
    }
    const out = await buildRunView({ id: runId, reviewId: "no-such-review", criteriaRevision: 1, planId, resultsId: null, tokenUsage: {} } as unknown as VerifyRun, { includeUsage: false });
    const expiresIn = (kind: string) => out.artifacts.find((a) => a.kind === kind)!.urlExpiresAt! - Date.now();
    return { trace: ttls.get(`${runId}/trace`), video: ttls.get(`${runId}/video`), traceExpiresIn: expiresIn("trace"), videoExpiresIn: expiresIn("video") };
  };
  try {
    setArtifactStorageForTests(fake);
    config.artifacts.getUrlTtlSeconds = 3600;
    const signedIn = await view({ start: "s", url: "http://localhost:1", login: { script: "node login.mjs" } });
    assert.equal(signedIn.trace, 300);
    assert.equal(signedIn.video, 3600);
    assert.ok(signedIn.traceExpiresIn <= 300_000 && signedIn.traceExpiresIn > 290_000, "urlExpiresAt matches the shorter link");
    assert.ok(signedIn.videoExpiresIn > 3_000_000);
    const plain = await view({ start: "s", url: "http://localhost:1", login: { strategy: "form" } });
    assert.equal(plain.trace, 3600);
    assert.equal((await view()).trace, 3600);
    config.artifacts.getUrlTtlSeconds = 60;
    assert.equal((await view({ start: "s", url: "http://localhost:1", login: { script: "x" } })).trace, 60, "never lengthens a shorter configured TTL");
  } finally {
    config.artifacts.getUrlTtlSeconds = prevTtl;
    setArtifactStorageForTests(undefined);
    db.remove("verifyArtifacts", (a) => ids.includes(a.runId));
    db.remove("verifyPlans", (p) => ids.includes(p.runId));
  }
});
