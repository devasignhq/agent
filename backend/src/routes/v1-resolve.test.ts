// Offline: the resolve handler's "no plan is coming" answers — the App's own
// onboarding PR, and a PR the webhook declined to review — which runners get browser tests,
// and which job a resolve lets claim a run: the PR's own, or the one the App dispatched.
//   DATABASE_URL= node --import tsx/esm --test src/routes/v1-resolve.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { artifactsHandler, makeRunnerAuth, parseResolveBody, resolveHandler, resultsHandler } from "./v1.js";
import { DISPATCH_EXPIRE_MS, NO_REVIEW_GRACE_MS, noteRunnerPoll, runnerDispatchPayload } from "../verify/runs.js";
import { setArtifactStorageForTests } from "../verify/storage.js";

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

// The PR's own pull_request job: its signed ref names the PR it may resolve.
const prClaims = (pr: number) => ({ ref: `refs/pull/${pr}/merge`, event_name: "pull_request", repository: "acme/widgets", run_id: "900", run_attempt: "1" });

const req = (repo: any, pr: number, over: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) =>
  ({ body: { sha: SHA, pr, ...over }, runner: { repo, claims: { ...prClaims(pr), ...claims }, plan: "pro" } }) as any;

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

function seedReadyRun(verifyConfig: Record<string, unknown> | undefined, verifyConfigFrom?: string, repo = seedRepo()) {
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

// ---- which job may claim a run: the PR's own, or the one the App dispatched ----

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const storage = {
  signPut: async (key: string) => ({ url: `https://put.example/${key}`, headers: {} }),
  signGet: async (key: string) => `https://get.example/${key}`,
  head: async () => null,
  remove: async () => {},
};

// A job the App's repository_dispatch started: it runs on the default branch, so its ref names no PR.
const DISPATCHED = { ref: "refs/heads/main", event_name: "repository_dispatch", repository: "acme/widgets", run_id: "555", run_attempt: "1" };

type Token = { id: string; nonce: string };
const runRow = (id: string) => db.find("verifyRuns", (r) => r.id === id)!;
const tokenFor = (runId: string) => (runnerDispatchPayload(runRow(runId)) as { probe: Token }).probe;

const onRun = (runId: string, r: any, body: unknown) => ({ ...r, params: { runId }, body });

test("the claim a resolve records is the signed token's, never the body's", async () => {
  const seed = seedReadyRun(undefined);
  const res = fakeRes();
  const body = { actions: { runId: "31337", jobUrl: "https://evil.example/job", runnerOs: "Linux" } };
  await resolveHandler(req(seed.repo, seed.prNumber, body, { run_attempt: "2" }), res);
  assert.equal(res.body.status, "ready");
  const meta = runRow(seed.runId).runnerMeta!;
  assert.deepEqual([meta.actionsRunId, meta.runAttempt], ["900", "2"]);
  assert.equal(meta.jobUrl, "https://github.com/acme/widgets/actions/runs/900");
  assert.equal(meta.runnerOs, "Linux", "the body still describes the machine it ran on");

  const named = fakeRes();
  await resultsHandler(onRun(seed.runId, req(seed.repo, seed.prNumber, {}, { run_id: "31337", run_attempt: "2" }), { runId: seed.runId, sha: SHA, results: [] }), named);
  assert.deepEqual([named.statusCode, named.body.error], [403, "actions_run_mismatch"], "the run the body named cannot report for it");
});

test("a token whose ref names no PR is refused every run the App did not dispatch it for", async () => {
  // Such a job could be any PR's dispatch — and it runs that PR's install scripts before the CLI —
  // or a hand-started workflow. `pr` and `sha` are public; only the nonce is not.
  type Seeded = { runId: string; token: Token; neighbour: Token };
  const cases: Array<[string, (s: Seeded) => { body?: Record<string, unknown>; claims?: Record<string, unknown>; repo?: any }]> = [
    ["a dispatch job that echoes no token", () => ({})],
    ["a workflow_dispatch job, even one holding the real token", (s) => ({ body: { probe: s.token }, claims: { event_name: "workflow_dispatch" } })],
    ["the run's id with a nonce of the right length but wrong bytes", (s) => ({ body: { probe: { id: s.runId, nonce: "X".repeat(s.token.nonce.length) } } })],
    ["another PR's genuine dispatch token, pointed at this PR", (s) => ({ body: { probe: s.neighbour } })],
    ["the real token for a sha the App did not dispatch", (s) => ({ body: { probe: s.token, sha: "c".repeat(40) } })],
    ["the real token from another repo's runner", (s) => ({ body: { probe: s.token }, repo: seedRepo() })],
    ["the real token once its dispatch has expired", (s) => {
      db.update("verifyRuns", (r) => r.id === s.runId, { dispatch: { ...runRow(s.runId).dispatch!, at: Date.now() - DISPATCH_EXPIRE_MS - 1_000 } });
      return { body: { probe: s.token } };
    }],
  ];
  for (const [label, build] of cases) {
    const seed = seedReadyRun(undefined);
    const neighbour = seedReadyRun(undefined, undefined, seed.repo);
    const { body = {}, claims = {}, repo = seed.repo } = build({ runId: seed.runId, token: tokenFor(seed.runId), neighbour: tokenFor(neighbour.runId) });
    const res = fakeRes();
    await resolveHandler(req(repo, seed.prNumber, { setup: { frameworks: [{ name: "vitest" }] }, ...body }, { ...DISPATCHED, ...claims }), res);
    assert.deepEqual([res.statusCode, res.body.error], [403, "dispatch_unverified"], label);
    assert.match(res.body.detail, /client_payload\.probe/, label);
    assert.deepEqual([runRow(seed.runId).status, runRow(seed.runId).runnerMeta], ["awaiting_runner", undefined], `${label} leaves the run unclaimed`);
    assert.equal(db.find("repositories", (r) => r.id === repo.id)!.verify?.detected, undefined, `${label} writes no repo setup either`);
    // The control: only the flipped condition is what refused it.
    const ok = fakeRes();
    await resolveHandler(req(seed.repo, seed.prNumber, { probe: tokenFor(seed.runId) }, DISPATCHED), ok);
    assert.equal(ok.body.status, "ready", `${label}, corrected, claims the run`);
  }
});

test("a dispatch token for a run a newer one replaced is told superseded, and claims neither", async () => {
  const seed = seedReadyRun(undefined);
  const token = tokenFor(seed.runId);
  const old = runRow(seed.runId);
  const newer = db.insert("verifyRuns", { ...old, id: uuid(), attempt: 2, dispatch: undefined, createdAt: old.createdAt + 1 });
  const res = fakeRes();
  await resolveHandler(req(seed.repo, seed.prNumber, { probe: token }, DISPATCHED), res);
  assert.deepEqual(res.body, { ok: true, status: "empty", runId: null, reason: "superseded" });
  assert.equal(runRow(newer.id).runnerMeta, undefined);
  assert.equal(runRow(seed.runId).runnerMeta, undefined);
});

// ---- a re-dispatched run as one story: the App's payload, GitHub's event file, the published CLI ----

test("a re-dispatched run survives every hop — and only its own job, attempt by attempt, reports on it", async () => {
  const seed = seedReadyRun(undefined);
  const githubRepoId = 800_000 + Math.floor(Math.random() * 1e6);
  db.update("repositories", (r) => r.id === seed.repo.id, { githubRepoId });

  // 1. The PR's own job gave up before the plan landed, so the planner re-dispatches CI with this payload.
  const payload = runnerDispatchPayload(runRow(seed.runId));
  // 2. GitHub writes that client_payload into the event file the dispatched job reads.
  const dir = mkdtempSync(path.join(tmpdir(), "devasign-redispatch-"));
  tmpDirs.push(dir);
  const eventPath = path.join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ action: "devasign-verify", client_payload: payload, repository: { full_name: "acme/widgets" } }));
  // 3. The published CLI reads it — verify/src/context.ts itself, not a restatement of its rules.
  const cli: any = await import(new URL("../../../verify/src/context.ts", import.meta.url).href);
  const attempt = (n: number) =>
    cli.readContext({
      cwd: dir,
      env: { GITHUB_EVENT_NAME: "repository_dispatch", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/widgets", GITHUB_RUN_ID: "555", GITHUB_RUN_ATTEMPT: String(n), GITHUB_ACTIONS: "true" },
    });
  const first = attempt(1);
  assert.deepEqual([first.pr, first.sha, first.probe?.id], [seed.prNumber, SHA, seed.runId], "the CLI echoes the App's token back");

  // 4. Every request passes the runner gate; the signed claims, never the body, say whose job it is.
  const asJob = async (ctx: any, body: unknown, runId?: string) => {
    const claims = { repository: "acme/widgets", repository_id: String(githubRepoId), sha: "f".repeat(40), ref: "refs/heads/main", event_name: ctx.event, run_id: ctx.runId, run_attempt: String(ctx.runAttempt) };
    const r: any = { headers: { authorization: "Bearer signed" }, params: runId ? { runId } : {}, body };
    let admitted = false;
    await makeRunnerAuth({ verify: async () => ({ ok: true, claims }) as any })(r, fakeRes(), () => void (admitted = true));
    assert.ok(admitted, "a dispatched job passes the runner gate");
    return r;
  };
  // Exactly the body resolvePlan() sends, built from the context above.
  const resolveBody = (ctx: any) => ({
    sha: ctx.sha, pr: ctx.pr, event: ctx.event, attempt: ctx.runAttempt, actions: { runId: ctx.runId, jobUrl: ctx.jobUrl, runnerOs: "Linux" },
    cliVersion: "1.9.1", capabilities: ["managed_boot", "boot_probe"], ...(ctx.probe ? { probe: ctx.probe } : {}),
  });
  const results = { runId: seed.runId, sha: SHA, planId: seed.planId, cliVersion: "1.9.1", results: [] };
  const signBody = { files: [{ clientRef: "log", kind: "log", path: ".devasign/run.log", bytes: 10, contentType: "text/plain" }] };

  // 5. The dispatched job resolves: it is handed the plan and recorded as the run's claimer.
  const resolved = fakeRes();
  await resolveHandler(await asJob(first, resolveBody(first)), resolved);
  assert.deepEqual([resolved.body.status, resolved.body.runId], ["ready", seed.runId], JSON.stringify(resolved.body));
  assert.deepEqual([runRow(seed.runId).runnerMeta!.actionsRunId, runRow(seed.runId).runnerMeta!.runAttempt], ["555", "1"]);

  setArtifactStorageForTests(storage as any);
  try {
    // 6. It signs its artifacts.
    const signed = fakeRes();
    await artifactsHandler(await asJob(first, signBody, seed.runId), signed);
    assert.equal(signed.statusCode, 200, JSON.stringify(signed.body));

    // 7. Another PR's dispatched job in the same repo, holding its own genuine token, gets nowhere.
    const neighbour = seedReadyRun(undefined, undefined, seed.repo);
    const intruder = { ...first, runId: "556", probe: tokenFor(neighbour.runId) };
    const taken = fakeRes();
    await resolveHandler(await asJob(intruder, resolveBody(intruder)), taken);
    assert.deepEqual([taken.statusCode, taken.body.error], [403, "dispatch_unverified"]);
    const forged = fakeRes();
    await resultsHandler(await asJob(intruder, results, seed.runId), forged);
    assert.deepEqual([forged.statusCode, forged.body.error], [403, "actions_run_mismatch"]);

    // 8. The job dies and is re-run: GitHub replays the same event file, so attempt 2 re-claims the run.
    const second = attempt(2);
    const reclaimed = fakeRes();
    await resolveHandler(await asJob(second, resolveBody(second)), reclaimed);
    assert.equal(reclaimed.body.status, "ready");
    assert.equal(runRow(seed.runId).runnerMeta!.runAttempt, "2");

    // 9. The first attempt's late report is refused; the attempt that holds the claim is judged.
    const stale = fakeRes();
    await resultsHandler(await asJob(first, results, seed.runId), stale);
    assert.deepEqual([stale.statusCode, stale.body.error], [403, "actions_run_mismatch"]);
    const posted = fakeRes();
    await resultsHandler(await asJob(second, results, seed.runId), posted);
    assert.deepEqual([posted.statusCode, posted.body.status], [200, "judging"], JSON.stringify(posted.body));
  } finally {
    setArtifactStorageForTests(undefined);
  }
});
