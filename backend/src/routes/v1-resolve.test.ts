// Offline: the resolve handler's "no plan is coming" answers — the App's own
// onboarding PR, and a PR the webhook declined to review — and which runners get browser tests.
//   DATABASE_URL= node --import tsx/esm --test src/routes/v1-resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { parseResolveBody, resolveHandler } from "./v1.js";
import { NO_REVIEW_GRACE_MS, noteRunnerPoll } from "../verify/runs.js";

const SHA = "a".repeat(40);

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

function seedRepo(onboardingPrNumber?: number) {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: uuid(), accountId: 1, accountLogin: "acme", installationId: 77, repoIds: [] } as any);
  return db.insert("repositories", {
    id: uuid(), installationId: installId, owner: "acme", name: "widgets", defaultBranch: "main",
    private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
    verify: { onboarding: onboardingPrNumber ? { state: "pr_open", prNumber: onboardingPrNumber } : { state: "none" } },
  } as any);
}

const req = (repo: any, pr: number, over: Record<string, unknown> = {}) =>
  ({ body: { sha: SHA, pr, ...over }, runner: { repo, claims: { ref: "refs/heads/x" }, plan: "pro" } }) as any;

test("the App's own onboarding PR resolves empty at once, never pending", async () => {
  const repo = seedRepo(17);
  const res = fakeRes();
  await resolveHandler(req(repo, 17), res);
  assert.equal(res.body.status, "empty");
  assert.equal(res.body.reason, "onboarding_pr");
  // A different PR on the same repo is unaffected.
  const other = fakeRes();
  await resolveHandler(req(repo, 18), other);
  assert.equal(other.body.status, "pending");
});

test("no review row yet stays pending — the webhook may still be in flight", async () => {
  const repo = seedRepo();
  const res = fakeRes();
  await resolveHandler(req(repo, 42), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "pending");
  assert.ok(res.body.giveUpAfterMs > 0, "tells the runner when to stop burning CI minutes");
});

test("a runner that has polled past the grace with still no review row gets empty", async () => {
  const repo = seedRepo();
  // Backdate the first poll: the webhook has had its full grace window to arrive.
  noteRunnerPoll(repo.id, 43, SHA, Date.now() - NO_REVIEW_GRACE_MS - 1_000);
  const res = fakeRes();
  await resolveHandler(req(repo, 43), res);
  assert.equal(res.body.status, "empty");
  assert.equal(res.body.reason, "not_reviewed");
});

test("a review row created during the grace wins over the decline heuristic", async () => {
  const repo = seedRepo();
  noteRunnerPoll(repo.id, 44, SHA, Date.now() - NO_REVIEW_GRACE_MS - 1_000);
  db.insert("prReviews", {
    id: uuid(), repoId: repo.id, prNumber: 44, prTitle: "t", headSha: SHA, baseSha: "b",
    status: "queued", verdict: null, criteria: [], taskId: null, additions: null, deletions: null,
    changedFiles: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  const res = fakeRes();
  await resolveHandler(req(repo, 44), res);
  assert.equal(res.body.status, "pending", "a real review must never be answered 'empty'");
});

test("parseResolveBody keeps known capabilities once each and drops everything else", () => {
  const body = parseResolveBody({ sha: SHA, pr: 1, capabilities: ["managed_boot", 7, "managed_boot", "rm -rf /", null, "boot_probe", { x: 1 }] });
  assert.deepEqual(body?.capabilities, ["managed_boot", "boot_probe"]);
  assert.equal(parseResolveBody({ sha: SHA, pr: 1, capabilities: "managed_boot" })?.capabilities, undefined);
  assert.equal(parseResolveBody({ sha: SHA, pr: 1 })?.capabilities, undefined);
});

let nextPr = 100;
const test_ = (id: string, runner: string) =>
  ({ id, path: `${id}.spec.ts`, content: "x", criterionIds: ["1"], level: runner === "playwright" ? "e2e" : "unit", levelReason: "", origin: "generated", runner, testSignature: id, strategyVersion: 1, targetFiles: [] });

function seedReadyRun(verifyConfig: Record<string, unknown> | undefined, verifyConfigFrom?: string) {
  const repo = seedRepo();
  const prNumber = nextPr++;
  const review = db.insert("prReviews", {
    id: uuid(), repoId: repo.id, prNumber, prTitle: "t", headSha: SHA, baseSha: "b", status: "done", verdict: null,
    criteria: [{ id: "1", text: "the page shows the user's name", kind: "ui" }], taskId: null, additions: null, deletions: null,
    changedFiles: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  const runId = uuid();
  const plan = db.insert("verifyPlans", {
    id: uuid(), schemaVersion: 1, runId, repoId: repo.id, criteriaRevision: 1,
    tests: [test_("e2e-1", "playwright"), test_("unit-1", "node-test")],
    commands: [
      { id: "c-pw", runner: "playwright", cmd: "npx playwright test", testIds: ["e2e-1"], timeoutMs: 1, needsBrowsers: true },
      { id: "c-node", runner: "node-test", cmd: "node --test", testIds: ["unit-1"], timeoutMs: 1 },
    ],
    unverifiable: [], ...(verifyConfig ? { verifyConfig } : {}), ...(verifyConfigFrom ? { verifyConfigFrom } : {}), createdAt: Date.now(),
  } as any);
  db.insert("verifyRuns", {
    id: runId, schemaVersion: 1, reviewId: review.id, repoId: repo.id, installationId: repo.installationId, prNumber, sha: SHA, attempt: 1,
    status: "awaiting_runner", skipReason: null, error: null, criteriaRevision: 1, planTier: "pro", planId: plan.id, resultsId: null,
    verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  return { repo, prNumber, runId, planId: plan.id };
}

async function resolveReady(seed: ReturnType<typeof seedReadyRun>, over: Record<string, unknown> = {}) {
  const res = fakeRes();
  await resolveHandler(req(seed.repo, seed.prNumber, over), res);
  assert.equal(res.body.status, "ready");
  return { plan: res.body.plan, meta: db.find("verifyRuns", (r) => r.id === seed.runId)!.runnerMeta! };
}

const START = { start: "npm run dev", url: "http://localhost:5173" };
const SERVERS = { ...START, servers: [{ name: "api", start: "npm run api", url: "http://localhost:4000" }] };
const LOGIN = { ...START, login: { script: "node scripts/login.mjs" } };

for (const [label, cfg, from] of [["servers", SERVERS, undefined], ["a login script", LOGIN, undefined], ["base-branch boot keys", START, "base_boot"]] as const) {
  test(`a runner without managed_boot gets no browser tests on a plan with ${label}`, async () => {
    const seed = seedReadyRun(cfg, from);
    const { plan, meta } = await resolveReady(seed);
    assert.deepEqual(plan.tests.map((t: any) => t.id), ["unit-1"]);
    assert.deepEqual(plan.commands.map((c: any) => c.id), ["c-node"]);
    assert.equal(plan.playwright, null);
    assert.equal("managedBoot" in plan, false);
    assert.equal(meta.e2eWithheld, "runner_outdated");
    assert.equal(meta.capabilities, undefined);
    const stored = db.find("verifyPlans", (p) => p.id === seed.planId)!;
    assert.deepEqual(stored.tests.map((t) => t.id), ["e2e-1", "unit-1"], "the stored plan keeps its browser tests");
    assert.equal(stored.commands.length, 2);
  });
}

test("a managed_boot runner gets every test, and a later resolve clears a withheld mark", async () => {
  const seed = seedReadyRun(SERVERS);
  assert.equal((await resolveReady(seed)).meta.e2eWithheld, "runner_outdated");
  const { plan, meta } = await resolveReady(seed, { capabilities: ["managed_boot"] });
  assert.deepEqual(plan.tests.map((t: any) => t.id), ["e2e-1", "unit-1"]);
  assert.deepEqual(plan.commands.map((c: any) => c.id), ["c-pw", "c-node"]);
  assert.notEqual(plan.playwright, null);
  assert.equal(meta.e2eWithheld, undefined);
  assert.deepEqual(meta.capabilities, ["managed_boot"]);
});

test("a start/url-only plan is never gated, whatever the runner", async () => {
  for (const cfg of [START, undefined]) {
    const { plan, meta } = await resolveReady(seedReadyRun(cfg));
    assert.deepEqual(plan.tests.map((t: any) => t.id), ["e2e-1", "unit-1"]);
    assert.notEqual(plan.playwright, null);
    assert.equal(meta.e2eWithheld, undefined);
  }
});

test("the managed-boot kill switch withholds browser tests even from a new runner and tells it so", async () => {
  const prev = config.verify.managedBoot;
  config.verify.managedBoot = false;
  try {
    const { plan, meta } = await resolveReady(seedReadyRun(LOGIN), { capabilities: ["managed_boot"] });
    assert.deepEqual(plan.tests.map((t: any) => t.id), ["unit-1"]);
    assert.equal(plan.playwright, null);
    assert.equal(plan.managedBoot, false);
    assert.equal(meta.e2eWithheld, "managed_boot_off");
    const legacy = await resolveReady(seedReadyRun(START), { capabilities: ["managed_boot"] });
    assert.deepEqual(legacy.plan.tests.map((t: any) => t.id), ["e2e-1", "unit-1"], "start/url-only plans keep the webServer path");
    assert.equal(legacy.plan.managedBoot, false);
    assert.equal(legacy.meta.e2eWithheld, undefined);
    const baseBoot = await resolveReady(seedReadyRun(START, "base_boot"), { capabilities: ["managed_boot"] });
    assert.deepEqual(baseBoot.plan.tests.map((t: any) => t.id), ["e2e-1", "unit-1"], "base-branch start/url boots through webServer on a new runner");
    assert.equal(baseBoot.meta.e2eWithheld, undefined);
    assert.equal((await resolveReady(seedReadyRun(START, "base_boot"))).meta.e2eWithheld, "runner_outdated");
  } finally {
    config.verify.managedBoot = prev;
  }
});
