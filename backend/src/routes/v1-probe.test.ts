// Offline: the boot probes a run is offered — the setup PR's own CI and the on-demand re-check
// — and the two endpoints they report through. Only signed claims decide, never the body.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/routes/v1-probe.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { setArtifactStorageForTests } from "../verify/storage.js";
import { PROBE_EXPIRE_MS } from "../verify/reaper.js";
import {
  makeProbeResultHandler,
  makeRunnerAuth,
  MAX_PROBES_PER_PR,
  probeArtifactsHandler,
  PROBE_UPLOAD_LIMITS,
  resolveHandler,
} from "./v1.js";
import { BOOT_CHECK_COOLDOWN_MS, MAX_RECHECKS_PER_DAY, RECHECK_PICKUP_MS, makeBootCheckHandler, makeVerifySetupHandler } from "./api.js";
import { DISPATCH_EVENT } from "../verify/feedback.js";
import { RECHECK_RUNNER_OUTDATED } from "./v1.js";
import { inferSetupFromTree } from "../verify/detect.js";
import { generateWorkflow, stackHints } from "../verify/onboarding/generate.js";
import type { BootProbe, Repository } from "../types.js";

const SHA = "b".repeat(40);
const PR = 31;

const storage = (signPut: (key: string) => Promise<{ url: string; headers: Record<string, string> }>) =>
  ({ signPut, signGet: async (key: string) => `https://get.example/${key}`, head: async () => null, remove: async () => {} }) as any;
const instant = async (key: string) => ({ url: `https://put.example/${key}`, headers: { "Content-Type": "text/plain" } });

setArtifactStorageForTests(storage(instant));
const tmpDirs: string[] = [];
after(() => {
  setArtifactStorageForTests(undefined);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

function seedRepo(onboarding: Record<string, unknown> = {}): Repository {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: uuid(), accountId: 1, accountLogin: "acme", installationId: 77, repoIds: [] } as any);
  return db.insert("repositories", {
    id: uuid(), installationId: installId, owner: "acme", name: "widgets", defaultBranch: "main",
    private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
    verify: { onboarding: { state: "pr_open", prNumber: PR, setupPrOpen: true, ...onboarding } },
  } as any);
}

const claimsFor = (over: Record<string, unknown> = {}) =>
  ({ ref: `refs/pull/${PR}/merge`, event_name: "pull_request", run_id: "900", run_attempt: "1", sha: SHA, ...over });

const resolveReq = (repo: Repository, body: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) =>
  ({
    body: { sha: SHA, pr: PR, cliVersion: "1.7.0", capabilities: ["boot_probe"], ...body },
    runner: { repo, claims: claimsFor(claims), plan: "pro" },
  }) as any;

async function resolve(repo: Repository, body?: Record<string, unknown>, claims?: Record<string, unknown>) {
  const res = fakeRes();
  await resolveHandler(resolveReq(repo, body, claims), res);
  assert.equal(res.body.status, "empty");
  assert.equal(res.body.reason, "onboarding_pr");
  return res;
}

const repoVerify = (repo: Repository) => db.find("repositories", (r) => r.id === repo.id)!.verify!;

test("the setup PR's own run is offered a probe, and the same run polling twice reuses it", async () => {
  const repo = seedRepo();
  const first = await resolve(repo);
  assert.equal(typeof first.body.probe.probeId, "string");
  assert.deepEqual(first.body.probe.uploadLimits, { ...PROBE_UPLOAD_LIMITS });
  const probe = db.find("bootProbes", (p) => p.id === first.body.probe.probeId)!;
  assert.deepEqual(
    { repoId: probe.repoId, prNumber: probe.prNumber, sha: probe.sha, attempt: probe.attempt, status: probe.status, uploadedBytes: probe.uploadedBytes },
    { repoId: repo.id, prNumber: PR, sha: SHA, attempt: 1, status: "offered", uploadedBytes: 0 }
  );

  const again = await resolve(repo);
  assert.equal(again.body.probe.probeId, first.body.probe.probeId);
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1, "polling must not open a second probe");

  // A re-run of the same job is a fresh boot, so it gets its own row.
  const rerun = await resolve(repo, {}, { run_attempt: "2" });
  assert.notEqual(rerun.body.probe.probeId, first.body.probe.probeId);
  assert.equal(db.find("bootProbes", (p) => p.id === rerun.body.probe.probeId)!.attempt, 2);
});

test("the probe key is signed end to end: one CI attempt cannot mint a probe per sha it makes up", async () => {
  const repo = seedRepo();
  const first = await resolve(repo);
  for (let i = 0; i < 5; i++) {
    const made_up = i.toString(16).padStart(40, "0");
    const again = await resolve(repo, { sha: made_up });
    assert.equal(again.body.probe.probeId, first.body.probe.probeId, made_up);
  }
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1, "one signed run attempt, one probe, one upload quota");
  assert.equal(db.find("bootProbes", (p) => p.id === first.body.probe.probeId)!.sha, SHA, "and the first checkout's sha stands");
});

test("probes per setup PR are capped even across signed runs", async () => {
  const repo = seedRepo();
  for (let i = 0; i < MAX_PROBES_PER_PR + 3; i++) await resolve(repo, {}, { run_id: String(1000 + i) });
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, MAX_PROBES_PER_PR);
});

test("a probe is offered only when the capability, the signed event, the signed ref and setupPrOpen all agree", async () => {
  // Each case flips exactly one of the four conditions; nothing else changes.
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
    ["no boot_probe capability", {}, { capabilities: ["managed_boot"] }, {}],
    ["a workflow_dispatch run", {}, {}, { event_name: "workflow_dispatch" }],
    ["a signed ref that does not name the setup PR", {}, {}, { ref: "refs/heads/main" }],
    ["a setup PR that is closed", { setupPrOpen: false }, {}, {}],
  ];
  for (const [label, onboarding, body, claims] of cases) {
    const repo = seedRepo(onboarding);
    const res = await resolve(repo, body, claims);
    assert.equal(res.body.probe, undefined, `${label} must not be offered a probe`);
    assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 0, label);
  }
});

test("a runner too old to probe gets today's empty response, and the repo remembers why", async () => {
  const repo = seedRepo();
  const res = fakeRes();
  await resolveHandler(resolveReq(repo, { capabilities: undefined, cliVersion: "1.6.2" }), res);
  assert.deepEqual(res.body, { ok: true, status: "empty", runId: null, reason: "onboarding_pr" });
  const unavailable = repoVerify(repo).onboarding.probeUnavailable!;
  assert.equal(unavailable.cliVersion, "1.6.2");
  assert.ok(unavailable.at > 0);

  // A capable runner on the next attempt clears the mark.
  await resolve(repo, {}, { run_attempt: "3" });
  assert.equal(repoVerify(repo).onboarding.probeUnavailable, null);
});

test("a run that could not have probed anyway is not recorded as an outdated runner", async () => {
  const repo = seedRepo({ setupPrOpen: false });
  await resolve(repo, { capabilities: [] });
  assert.equal(repoVerify(repo).onboarding.probeUnavailable, undefined);
});

// ---- the two probe endpoints ------------------------------------------------

function seedProbe(repo: Repository, over: Partial<BootProbe> = {}): BootProbe {
  return db.insert("bootProbes", {
    id: uuid(), schemaVersion: 1, repoId: repo.id, prNumber: PR, sha: SHA, attempt: 1,
    status: "offered", offeredAt: Date.now(), uploadedBytes: 0, uploadedCount: 0, ...over,
  });
}

const probeReq = (repo: Repository, probeId: string, body: unknown, claims: Record<string, unknown> = {}) =>
  ({ params: { probeId }, body, runner: { repo, claims: claimsFor(claims), plan: "pro" } }) as any;

const signBody = (bytes: number, ref = "log") => ({
  sha: SHA,
  files: [{ clientRef: ref, kind: "log", path: `.devasign/${ref}.txt`, bytes, contentType: "text/plain" }],
});

const report = (over: Record<string, unknown> = {}) => ({
  sha: SHA, ok: true, stage: "done", durationMs: 41_000, cliVersion: "1.7.0",
  servers: [{ name: "backend", ok: true, readyMs: 3_100 }],
  page: { status: 200 },
  ...over,
});

test("signing probe artifacts stores them against the probe, not a run", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  const res = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, signBody(2_048)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rejected.length, 0);
  const artifactId = res.body.uploads[0].artifactId;
  const row = db.find("verifyArtifacts", (a) => a.id === artifactId)!;
  assert.equal(row.owner, "probe");
  assert.equal(row.runId, probe.id);
  assert.equal(row.state, "pending_upload");
  const after = db.find("bootProbes", (p) => p.id === probe.id)!;
  assert.equal(after.uploadedBytes, 2_048);
  assert.equal(after.uploadedCount, 1);
});

test("the probe guard rejects another repo's probe, a wrong sha, a reported probe and an expired one", async () => {
  const repo = seedRepo();
  const other = seedRepo();
  const cases: Array<[string, () => any, number, string]> = [
    ["another repo's runner", () => probeReq(other, seedProbe(repo).id, signBody(1)), 404, "probe_not_found"],
    ["a ref for another PR", () => probeReq(repo, seedProbe(repo).id, signBody(1), { ref: `refs/pull/${PR + 1}/merge` }), 403, "pr_mismatch"],
    ["a sha that is not the probe's", () => probeReq(repo, seedProbe(repo).id, { ...signBody(1), sha: "c".repeat(40) }), 409, "sha_mismatch"],
    ["a probe already reported", () => probeReq(repo, seedProbe(repo, { status: "reported" }).id, signBody(1)), 409, "probe_not_offered"],
    ["a probe older than the window", () => probeReq(repo, seedProbe(repo, { offeredAt: Date.now() - PROBE_EXPIRE_MS - 1_000 }).id, signBody(1)), 409, "probe_expired"],
    ["a probe id that does not exist", () => probeReq(repo, uuid(), signBody(1)), 404, "probe_not_found"],
  ];
  for (const [label, build, status, error] of cases) {
    const res = fakeRes();
    await probeArtifactsHandler(build(), res);
    assert.equal(res.statusCode, status, label);
    assert.equal(res.body.error, error, label);
  }
  assert.equal(db.filter("verifyArtifacts", (a) => a.owner === "probe" && a.repoId === repo.id).length, 0, "nothing was signed");
});

test("the upload cap accumulates on the probe row, so splitting the request cannot beat it", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  const half = PROBE_UPLOAD_LIMITS.maxTotalBytes / 2;

  const first = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, { sha: SHA, files: [
    { clientRef: "a", kind: "log", path: "a.txt", bytes: half, contentType: "text/plain" },
    { clientRef: "b", kind: "log", path: "b.txt", bytes: half, contentType: "text/plain" },
  ] }), first);
  assert.equal(first.body.uploads.length, 2);
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.uploadedBytes, PROBE_UPLOAD_LIMITS.maxTotalBytes);

  const second = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, signBody(1, "c")), second);
  assert.deepEqual(second.body.uploads, []);
  assert.deepEqual(second.body.rejected, [{ clientRef: "c", reason: "quota" }]);
  assert.equal(db.filter("verifyArtifacts", (a) => a.runId === probe.id).length, 2, "the third file was never signed");
});

test("requests in flight together share one cap; they do not get one each", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  // Signing takes a moment, as it does against real object storage.
  setArtifactStorageForTests(storage(async (key) => {
    await new Promise((r) => setTimeout(r, 5));
    return { url: `https://put.example/${key}`, headers: { "Content-Type": "text/plain" } };
  }));
  try {
    const full = () => ({
      sha: SHA,
      files: Array.from({ length: PROBE_UPLOAD_LIMITS.maxFiles }, (_, i) => ({
        clientRef: `f${i}`, kind: "log", path: `${i}.txt`, bytes: PROBE_UPLOAD_LIMITS.maxTotalBytes / PROBE_UPLOAD_LIMITS.maxFiles, contentType: "text/plain",
      })),
    });
    const results = [fakeRes(), fakeRes(), fakeRes()];
    await Promise.all(results.map((res) => probeArtifactsHandler(probeReq(repo, probe.id, full()), res)));
    const signed = results.reduce((n, r) => n + r.body.uploads.length, 0);
    assert.equal(signed, PROBE_UPLOAD_LIMITS.maxFiles, "the cap is the cap, whatever the attacker's concurrency");
    assert.equal(db.filter("verifyArtifacts", (a) => a.runId === probe.id).length, PROBE_UPLOAD_LIMITS.maxFiles);
    const row = db.find("bootProbes", (p) => p.id === probe.id)!;
    assert.equal(row.uploadedCount, PROBE_UPLOAD_LIMITS.maxFiles);
    assert.equal(row.uploadedBytes, PROBE_UPLOAD_LIMITS.maxTotalBytes, "and the ledger counts every file that was signed");
  } finally {
    setArtifactStorageForTests(storage(instant));
  }
});

test("a signing failure gives the quota back instead of burning it", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  setArtifactStorageForTests(storage(async () => { throw new Error("object storage is down"); }));
  const res = fakeRes();
  try {
    await assert.rejects(() => probeArtifactsHandler(probeReq(repo, probe.id, signBody(1_024)), res));
    assert.equal(db.filter("verifyArtifacts", (a) => a.runId === probe.id).length, 0);
    const row = db.find("bootProbes", (p) => p.id === probe.id)!;
    assert.deepEqual([row.uploadedBytes, row.uploadedCount], [0, 0]);
  } finally {
    setArtifactStorageForTests(storage(instant));
  }
});

test("a report the normalizer cannot use is refused and leaves the probe open", async () => {
  const repo = seedRepo();
  for (const body of ["nope", null, 7, [1, 2, 3]]) {
    const probe = seedProbe(repo);
    const res = fakeRes();
    await makeProbeResultHandler({ settle: async () => {} })(probeReq(repo, probe.id, body), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.error, "invalid_body");
    assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "offered");
  }
});

test("a reported probe stores its report, confirms the artifacts it names, and never reports twice", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  const signed = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, { sha: SHA, files: [
    { clientRef: "log", kind: "log", path: "boot.txt", bytes: 10, contentType: "text/plain" },
    { clientRef: "shot", kind: "screenshot", path: "boot.png", bytes: 20, contentType: "image/png" },
  ] }), signed);
  const [logId, shotId] = signed.body.uploads.map((u: any) => u.artifactId);

  const settled: string[] = [];
  const handler = makeProbeResultHandler({ settle: async (id) => void settled.push(id) });
  const res = fakeRes();
  await handler(probeReq(repo, probe.id, report({ logArtifactId: logId })), res);
  assert.deepEqual(res.body, { ok: true });
  const row = db.find("bootProbes", (p) => p.id === probe.id)!;
  assert.equal(row.status, "reported");
  assert.equal(row.report?.stage, "done");
  assert.equal(row.report?.page?.status, 200);
  assert.ok(row.reportedAt! > 0);
  assert.deepEqual(settled, [probe.id]);
  assert.equal(db.find("verifyArtifacts", (a) => a.id === logId)!.state, "uploaded");
  assert.equal(db.find("verifyArtifacts", (a) => a.id === shotId)!.state, "pending_upload", "an artifact the report never names stays unconfirmed");

  const replay = fakeRes();
  await handler(probeReq(repo, probe.id, report({ ok: false, stage: "servers" })), replay);
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.error, "probe_not_offered");
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.report?.ok, true, "the first report stands");
  assert.deepEqual(settled, [probe.id], "a refused replay settles nothing");
});

test("a settle that rejects is caught: the runner still gets its ok", async () => {
  const repo = seedRepo();
  const probe = seedProbe(repo);
  const res = fakeRes();
  const handler = makeProbeResultHandler({ settle: async () => { throw new Error("comment upsert exploded"); } });
  await handler(probeReq(repo, probe.id, report()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  // Let the rejected settle promise reach the microtask queue: an unhandled one fails this test.
  await new Promise((r) => setImmediate(r));
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "reported");
});

// ---- the on-demand re-check: the only boot probe an onboarded repo can ever get -----

const HEAD = "e".repeat(40);
const NONCE = "nonce-from-the-apps-own-dispatch";
const DISPATCHED = { ref: "refs/heads/main", event_name: "repository_dispatch" };

/** An onboarded repo: the setup PR is long merged, so no PR run will ever ask for a probe again. */
const seedOnboarded = () => seedRepo({ state: "verified", setupPrOpen: false });

const seedRecheck = (repo: Repository, over: Partial<BootProbe> = {}): BootProbe =>
  db.insert("bootProbes", {
    id: uuid(), schemaVersion: 1, repoId: repo.id, kind: "recheck", nonce: NONCE, prNumber: PR, sha: SHA, attempt: 1,
    status: "offered", offeredAt: Date.now(), uploadedBytes: 0, uploadedCount: 0, ...over,
  });

/** What a dispatched run echoes back from its client_payload — the only thing that names it. */
const token = (probe: BootProbe, over: Record<string, unknown> = {}) => ({ probe: { id: probe.id, nonce: probe.nonce, ...over } });

function seedTenant() {
  const userId = uuid();
  const githubId = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId, githubLogin: `probe-${githubId}`, email: `p${githubId}@x.z`, plan: "pro", createdAt: Date.now() } as any);
  const repo = seedOnboarded();
  db.update("installations", (i) => i.id === repo.installationId, { userId });
  return { userId, repo };
}

const ownerReq = (userId: string | undefined, repoId: string) =>
  ({ cookies: userId ? { devasign_session: signSession(userId) } : {}, params: { id: repoId }, body: {} }) as any;

/** Move the repo's recorded click back in time, so the per-repo cooldown is not what answers. */
function forgetCooldown(repo: Repository): void {
  const v = db.find("repositories", (r) => r.id === repo.id)!.verify!;
  if (!v.onboarding.bootCheck) return;
  db.update("repositories", (r) => r.id === repo.id, {
    verify: { ...v, onboarding: { ...v.onboarding, bootCheck: { ...v.onboarding.bootCheck, at: Date.now() - BOOT_CHECK_COOLDOWN_MS - 1_000 } } },
  });
}

test("an onboarded repo with no open setup PR is still probed: the dispatched run claims the re-check the App minted", async () => {
  const repo = seedOnboarded();
  const probe = seedRecheck(repo);
  const res = await resolve(repo, token(probe), DISPATCHED);
  assert.equal(res.body.probe.probeId, probe.id, "the row the App minted, not a second one");
  assert.deepEqual(res.body.probe.uploadLimits, { ...PROBE_UPLOAD_LIMITS });
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1);
  const claimed = db.find("bootProbes", (p) => p.id === probe.id)!;
  assert.deepEqual([claimed.actionsRunId, claimed.attempt, claimed.status], ["900", 1, "offered"], "and the row remembers whose run claimed it");

  // The guard on both probe endpoints once demanded a PR ref, so this run could not report at all.
  const signed = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, signBody(1_024), DISPATCHED), signed);
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.body.uploads.length, 1);
  const settled: string[] = [];
  const reported = fakeRes();
  await makeProbeResultHandler({ settle: async (id) => void settled.push(id) })(probeReq(repo, probe.id, report(), DISPATCHED), reported);
  assert.deepEqual(reported.body, { ok: true });
  assert.deepEqual(settled, [probe.id]);
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "reported");
});

test("a re-check is the App's dispatch to give: no other dispatch run in the repo can claim it", async () => {
  // DevAsign dispatches an ordinary contributor PR the same way, at the same ref, and that
  // job runs the PR's install scripts first — `pr` and `sha` are public, the nonce is not.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a dispatch run that echoes no token at all", {}],
    ["a dispatch run guessing the probe id", { probe: { id: "", nonce: "" } }],
    ["a dispatch run with the right id and a wrong nonce", { probe: { id: "", nonce: "nonce-from-the-apps-own-dispatchX" } }],
    ["a dispatch run with a nonce of the right length but wrong bytes", { probe: { id: "", nonce: "X".repeat(NONCE.length) } }],
    ["a dispatch run naming another probe id", { probe: { id: uuid(), nonce: NONCE } }],
  ];
  for (const [label, body] of cases) {
    const repo = seedOnboarded();
    const probe = seedRecheck(repo);
    const sent: Record<string, unknown> = { sha: SHA, ...body };
    if ((sent.probe as any)?.id === "") (sent.probe as any).id = probe.id;
    const res = await resolve(repo, sent, { ...DISPATCHED, run_id: "555555" });
    assert.equal(res.body.probe, undefined, `${label} must not be offered the re-check`);
    assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.actionsRunId, undefined, `${label} leaves the row unclaimed`);

    // It cannot spend the row's upload quota or file its verdict either.
    const signed = fakeRes();
    await probeArtifactsHandler(probeReq(repo, probe.id, signBody(1_024), { ...DISPATCHED, run_id: "555555" }), signed);
    assert.equal(signed.statusCode, 403, label);
    assert.equal(db.filter("verifyArtifacts", (a) => a.runId === probe.id).length, 0, label);
    const told = fakeRes();
    await makeProbeResultHandler({ settle: async () => {} })(probeReq(repo, probe.id, report(), { ...DISPATCHED, run_id: "555555" }), told);
    assert.equal(told.statusCode, 403, label);
    assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "offered", label);

    // The control: the run GitHub really started for this dispatch does get it.
    assert.equal((await resolve(repo, token(probe), DISPATCHED)).body.probe?.probeId, probe.id, `${label}, with the App's own token, is offered`);
  }
});

test("once a run has claimed a re-check, a second dispatch run cannot take it over", async () => {
  const repo = seedOnboarded();
  const probe = seedRecheck(repo);
  const mine = { ...DISPATCHED, run_id: "900" };
  assert.equal((await resolve(repo, token(probe), mine)).body.probe.probeId, probe.id);

  // A second dispatched run — a different PR's re-run, carrying different untrusted code —
  // holds the same client_payload only if it stole it; the stamped run id refuses it anyway.
  const other = { ...DISPATCHED, run_id: "901" };
  assert.equal((await resolve(repo, token(probe), other)).body.probe, undefined, "the row is spoken for");
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.actionsRunId, "900", "and is not re-stamped");
  const signed = fakeRes();
  await probeArtifactsHandler(probeReq(repo, probe.id, signBody(1_024), other), signed);
  assert.equal(signed.statusCode, 403, "nor can it spend the quota");
  const told = fakeRes();
  await makeProbeResultHandler({ settle: async () => {} })(probeReq(repo, probe.id, report(), other), told);
  assert.equal(told.statusCode, 403, "nor report on it");

  // A re-run of that same job is a different attempt, so it is a different run too.
  assert.equal((await resolve(repo, token(probe), { ...mine, run_attempt: "2" })).body.probe, undefined);
  // The run that claimed it keeps it, poll after poll.
  assert.equal((await resolve(repo, token(probe), mine)).body.probe.probeId, probe.id);
  const ok = fakeRes();
  await makeProbeResultHandler({ settle: async () => {} })(probeReq(repo, probe.id, report(), mine), ok);
  assert.deepEqual(ok.body, { ok: true });
});

test("each gate on a re-check refuses on its own, and the probe stays unclaimed", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Partial<BootProbe>]> = [
    ["a pull_request run", {}, { ref: `refs/pull/${PR}/merge`, event_name: "pull_request" }, {}],
    // The App never sends one, and anyone with push access can add a hand-startable workflow.
    ["a workflow_dispatch run", {}, { ...DISPATCHED, event_name: "workflow_dispatch" }, {}],
    ["a dispatched run on a branch that is not the default", {}, { ...DISPATCHED, ref: "refs/heads/release-2" }, {}],
    ["a body sha that is not the one the App resolved", { sha: "c".repeat(40) }, DISPATCHED, {}],
    ["a row older than the probe window", {}, DISPATCHED, { offeredAt: Date.now() - PROBE_EXPIRE_MS - 1_000 }],
    ["a row already reported", {}, DISPATCHED, { status: "reported" }],
  ];
  for (const [label, body, claims, over] of cases) {
    const repo = seedOnboarded();
    const probe = seedRecheck(repo, over);
    const res = await resolve(repo, { ...token(probe), ...body }, claims);
    assert.equal(res.body.probe, undefined, `${label} must not be offered the re-check`);
    assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.actionsRunId, undefined, label);
    assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1, `${label} mints nothing either`);
    // The control: only the flipped condition is what refused it.
    if (over.status || over.offeredAt) continue;
    assert.equal((await resolve(repo, token(probe), DISPATCHED)).body.probe?.probeId, probe.id, `${label}, corrected, is offered`);
  }
});

test("a re-check belongs to one repo: another repo's runner neither claims nor reports it", async () => {
  const repo = seedOnboarded();
  const other = seedOnboarded();
  const probe = seedRecheck(repo);
  const stranger = await resolve(other, token(probe), DISPATCHED);
  assert.equal(stranger.body.probe, undefined, "a dispatched run with no re-check of its own gets nothing");
  assert.equal((await resolve(repo, token(probe), DISPATCHED)).body.probe.probeId, probe.id, "while the repo it was minted for claims it");

  const res = fakeRes();
  await probeArtifactsHandler(probeReq(other, probe.id, signBody(1), DISPATCHED), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "probe_not_found");
});

test("a PR run that knows a re-check's id still cannot report on it", async () => {
  const repo = seedOnboarded();
  const probe = seedRecheck(repo);
  const res = fakeRes();
  await makeProbeResultHandler({ settle: async () => {} })(probeReq(repo, probe.id, report(), { ref: `refs/pull/${PR}/merge`, event_name: "pull_request" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "pr_mismatch");
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "offered");
});

test("a re-check's place in the boot order is where its run really booted, not where the click was", async () => {
  // The App mints the row when the maintainer clicks; CI can take minutes to pick it up.
  // `offeredAt` is what orders boot verdicts, so the claim — not the click — has to set it.
  const repo = seedOnboarded();
  const clickedAt = Date.now() - 10 * 60_000;
  const probe = seedRecheck(repo, { offeredAt: clickedAt });
  assert.equal((await resolve(repo, token(probe), DISPATCHED)).body.probe.probeId, probe.id);
  const claimed = db.find("bootProbes", (p) => p.id === probe.id)!;
  assert.ok(claimed.offeredAt > clickedAt + 9 * 60_000, "the row is offered when a run is really told to boot");
  assert.ok(Math.abs(claimed.offeredAt - Date.now()) < 5_000);
});

test("asking for a boot check pins a re-check to the default branch head and dispatches the runner at it", async () => {
  const { userId, repo } = seedTenant();
  const sent: Array<Record<string, unknown>> = [];
  const handler = makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, payload) => void sent.push(payload) });

  const res = fakeRes();
  await handler(ownerReq(userId, repo.id), res);
  assert.deepEqual(res.body, { ok: true, dispatched: true });
  const probe = db.find("bootProbes", (p) => p.repoId === repo.id)!;
  assert.deepEqual(
    { kind: probe.kind, sha: probe.sha, prNumber: probe.prNumber, status: probe.status },
    { kind: "recheck", sha: HEAD, prNumber: PR, status: "offered" }
  );
  assert.ok((probe.nonce ?? "").length >= 24, "a guessable row is claimable by any dispatch run in the repo");
  assert.deepEqual(sent, [{ pr: PR, sha: HEAD, probe: { id: probe.id, nonce: probe.nonce } }]);
  const bootCheck = repoVerify(repo).onboarding.bootCheck!;
  assert.deepEqual([bootCheck.probeId, bootCheck.dispatched, bootCheck.error], [probe.id, true, undefined]);
  assert.ok(bootCheck.at > 0);

  // The runner that workflow starts checks out that very commit, and is handed the row.
  const offered = await resolve(repo, { sha: HEAD, probe: sent[0].probe }, DISPATCHED);
  assert.equal(offered.body.probe.probeId, probe.id);

  const second = fakeRes();
  await handler(ownerReq(userId, repo.id), second);
  assert.deepEqual(second.body, { ok: true, dispatched: false, reason: "pending" }, "one pending re-check at a time");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1);
});

test("two clicks in flight together mint one re-check, not one each", async () => {
  const { userId, repo } = seedTenant();
  const sent: Array<Record<string, unknown>> = [];
  // Resolving the head takes a moment, as it does against real GitHub.
  const slow = makeBootCheckHandler({
    branchTip: async () => { await new Promise((r) => setTimeout(r, 5)); return HEAD; },
    dispatch: async (_i, _r, payload) => void sent.push(payload),
  });
  const both = [fakeRes(), fakeRes()];
  await Promise.all(both.map((res) => slow(ownerReq(userId, repo.id), res)));
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(both.map((r) => r.body.dispatched).sort(), [false, true]);
});

test("a dispatch GitHub refuses is reported as a failure, never as a queued check", async () => {
  const { userId, repo } = seedTenant();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const refused = makeBootCheckHandler({
      branchTip: async () => HEAD,
      dispatch: async () => { throw new Error("GitHub repository_dispatch 403 on acme/widgets: Resource not accessible by integration"); },
    });
    const res = fakeRes();
    await refused(ownerReq(userId, repo.id), res);
    assert.deepEqual(res.body, { ok: true, dispatched: false, reason: "dispatch_failed" });
    const bootCheck = repoVerify(repo).onboarding.bootCheck!;
    assert.equal(bootCheck.dispatched, false);
    assert.match(bootCheck.error!, /403.*Resource not accessible/);
    assert.match(bootCheck.error!, /repository_dispatch trigger and the App needs contents:write/);
    assert.equal(db.find("bootProbes", (p) => p.id === bootCheck.probeId)!.status, "expired", "nothing will ever report it");

    // The expired row re-arms the button, so the recorded click is the only thing throttling
    // a loop of failed dispatches against the customer's own GitHub budget.
    const sent: Array<Record<string, unknown>> = [];
    const retry = makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, p) => void sent.push(p) });
    for (let i = 0; i < 20; i++) {
      const blocked = fakeRes();
      await retry(ownerReq(userId, repo.id), blocked);
      assert.deepEqual(blocked.body, { ok: true, dispatched: false, reason: "cooldown" });
    }
    assert.deepEqual(sent, [], "not one of them reached GitHub");
    assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1, "and no junk rows were left behind");

    // Once the cooldown is past, the maintainer can try again.
    forgetCooldown(repo);
    const allowed = fakeRes();
    await retry(ownerReq(userId, repo.id), allowed);
    assert.deepEqual(allowed.body, { ok: true, dispatched: true });
    assert.equal(sent.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("a repo gets a bounded number of boot checks a day, whatever the button is clicked", async () => {
  const { userId, repo } = seedTenant();
  const sent: unknown[] = [];
  const handler = makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, p) => void sent.push(p) });
  for (let i = 0; i < MAX_RECHECKS_PER_DAY; i++) {
    const res = fakeRes();
    await handler(ownerReq(userId, repo.id), res);
    assert.deepEqual(res.body, { ok: true, dispatched: true }, `click ${i}`);
    // The click's row is reported, so neither the pending guard nor the cooldown is what answers next.
    db.update("bootProbes", (p) => p.repoId === repo.id && p.status === "offered", { status: "reported" });
    forgetCooldown(repo);
  }
  for (let i = 0; i < 5; i++) {
    const over = fakeRes();
    await handler(ownerReq(userId, repo.id), over);
    assert.deepEqual(over.body, { ok: true, dispatched: false, reason: "rate_limited" });
    forgetCooldown(repo);
  }
  assert.equal(sent.length, MAX_RECHECKS_PER_DAY, "each one of those reached the customer's GitHub");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, MAX_RECHECKS_PER_DAY, "and minted a permanent row with its own upload quota");
});

test("a boot check needs an owner, a recorded setup PR and a readable head", async () => {
  const { userId, repo } = seedTenant();
  const stranger = seedTenant();
  const bare = seedTenant();
  db.update("repositories", (r) => r.id === bare.repo.id, { verify: { onboarding: { state: "none" } } });
  const dispatched: unknown[] = [];
  const handler = makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, p) => void dispatched.push(p) });

  const out = fakeRes();
  await handler(ownerReq(undefined, repo.id), out);
  assert.equal(out.statusCode, 401);
  const foreign = fakeRes();
  await handler(ownerReq(stranger.userId, repo.id), foreign);
  assert.equal(foreign.statusCode, 403);
  const none = fakeRes();
  await handler(ownerReq(bare.userId, bare.repo.id), none);
  assert.deepEqual(none.body, { ok: true, dispatched: false, reason: "no_setup_pr" });

  const warn = console.warn;
  console.warn = () => {};
  try {
    const unreadable = fakeRes();
    await makeBootCheckHandler({ branchTip: async () => { throw new Error("gh 502"); }, dispatch: async (_i, _r, p) => void dispatched.push(p) })(ownerReq(userId, repo.id), unreadable);
    assert.deepEqual(unreadable.body, { ok: true, dispatched: false, reason: "head_unreadable" });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(dispatched, [], "nothing was dispatched");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id || p.repoId === bare.repo.id).length, 0, "and no row was minted");
});

test("a boot check is refused while the setup PR is open, and when no dispatch can reach the workflow", async () => {
  const dispatched: unknown[] = [];
  const handler = makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, p) => void dispatched.push(p) });
  const setOnboarding = (repo: Repository, patch: Record<string, unknown>) => {
    const v = db.find("repositories", (r) => r.id === repo.id)!.verify!;
    db.update("repositories", (r) => r.id === repo.id, { verify: { ...v, onboarding: { ...v.onboarding, ...patch } } });
  };

  // The setup PR's own CI boots the config that PR proposes; a boot of the default branch,
  // which does not carry it, would overwrite that verdict with an answer to another question.
  const open = seedTenant();
  setOnboarding(open.repo, { state: "pr_open", setupPrOpen: true });
  const whileOpen = fakeRes();
  await handler(ownerReq(open.userId, open.repo.id), whileOpen);
  assert.deepEqual(whileOpen.body, { ok: true, dispatched: false, reason: "setup_pr_open" });

  // extendWorkflow withholds the repository_dispatch trigger from a multi-job workflow, so
  // GitHub would accept the dispatch and nothing whatever would run.
  const deaf = seedTenant();
  setOnboarding(deaf.repo, { dispatchable: false });
  const unreachable = fakeRes();
  await handler(ownerReq(deaf.userId, deaf.repo.id), unreachable);
  assert.deepEqual(unreachable.body, { ok: true, dispatched: false, reason: "not_dispatchable" });

  assert.deepEqual(dispatched, [], "neither one reached GitHub");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === open.repo.id || p.repoId === deaf.repo.id).length, 0);
});

test("the setup panel is told whether a boot check can be asked for", async () => {
  const { userId, repo } = seedTenant();
  const setup = makeVerifySetupHandler({ branchSha: async () => HEAD, read: async () => null, now: () => Date.now() });
  const ask = async () => {
    const res = fakeRes();
    await setup(ownerReq(userId, repo.id), res);
    return res.body.bootCheck;
  };
  assert.deepEqual(await ask(), { available: true });
  // A row nothing has claimed is a request, not a check that is running: the panel must not
  // tell the maintainer CI is booting when no run has ever picked the dispatch up.
  const probe = seedRecheck(repo);
  assert.deepEqual(await ask(), { available: false, reason: "requested" });

  // GitHub accepts a dispatch no workflow listens for, so a request nothing answers must
  // not hold the button for the whole two-hour probe window.
  db.update("bootProbes", (p) => p.id === probe.id, { offeredAt: Date.now() - RECHECK_PICKUP_MS - 1_000 });
  assert.deepEqual(await ask(), { available: true }, "an unclaimed request lets go once nothing has come for it");

  // A run that really did claim it holds the button for as long as a boot can take.
  db.update("bootProbes", (p) => p.id === probe.id, { actionsRunId: "900", offeredAt: Date.now() - RECHECK_PICKUP_MS - 1_000 });
  assert.deepEqual(await ask(), { available: false, reason: "pending" });
  db.update("bootProbes", (p) => p.id === probe.id, { offeredAt: Date.now() - PROBE_EXPIRE_MS - 1_000 });
  assert.deepEqual(await ask(), { available: true }, "and lets go when even that has run out");
});

// ---- the whole re-check as one story: the App, GitHub's event file, the published CLI ----
// Every hop above is tested from one side only. A payload key, a trigger name or a response
// shape could drift and each side's suite would still pass while the feature did nothing.

test("the re-check survives every hop: the workflow's trigger, the App's dispatch, the real CLI's reading of it, and the run it sends back", async () => {
  // 0. The dispatch only wakes CI if the generated workflow listens for the App's own event type.
  const paths = ["package.json", "package-lock.json", "src/app.tsx"];
  const setup = inferSetupFromTree(paths);
  const workflow = parse(generateWorkflow(setup, stackHints(setup, paths, null, {}), [], paths)) as any;
  assert.deepEqual(workflow.on.repository_dispatch.types, [DISPATCH_EVENT], "the trigger must name the event the App sends");
  assert.match(workflow.jobs.verify.steps[0].with.ref, /client_payload\.sha/, "and check out the commit the App pinned");

  const { userId, repo } = seedTenant();
  // repoForClaims resolves by githubRepoId first; every seeded repo here is acme/widgets.
  const githubRepoId = 700_000 + Math.floor(Math.random() * 1e6);
  db.update("repositories", (r) => r.id === repo.id, { githubRepoId });

  // 1. The maintainer clicks "check boot now". The App pins the head and asks GitHub to dispatch.
  const sent: Array<Record<string, unknown>> = [];
  const asked = fakeRes();
  await makeBootCheckHandler({ branchTip: async () => HEAD, dispatch: async (_i, _r, payload) => void sent.push(payload) })(ownerReq(userId, repo.id), asked);
  assert.deepEqual(asked.body, { ok: true, dispatched: true });
  const row = db.find("bootProbes", (p) => p.repoId === repo.id && p.kind === "recheck")!;

  // 2. GitHub writes that client_payload into the event file the runner reads.
  const dir = mkdtempSync(path.join(tmpdir(), "devasign-dispatch-"));
  tmpDirs.push(dir);
  const eventPath = path.join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ action: DISPATCH_EVENT, client_payload: sent[0], repository: { full_name: "acme/widgets" } }));

  // 3. The published CLI reads it — verify/src/context.ts itself, not a restatement of its rules.
  const cli: any = await import(new URL("../../../verify/src/context.ts", import.meta.url).href);
  const ctx = cli.readContext({
    cwd: dir,
    env: {
      GITHUB_EVENT_NAME: "repository_dispatch", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTIONS: "true",
    },
  });
  assert.deepEqual([ctx.pr, ctx.sha, ctx.event], [PR, HEAD, "repository_dispatch"], "the CLI reads back exactly what the App dispatched");
  assert.deepEqual(ctx.probe, { id: row.id, nonce: row.nonce }, "including the token that proves this run is the dispatched one");

  // 4. The runner authenticates. The signed claims, never the body, decide whose repo this is.
  const claims = {
    repository: "acme/widgets", repository_id: String(githubRepoId), sha: ctx.sha, ref: "refs/heads/main",
    event_name: ctx.event, run_id: ctx.runId, run_attempt: String(ctx.runAttempt),
  };
  // The body resolvePlan() sends, built from the context above.
  const req: any = {
    headers: { authorization: "Bearer signed" },
    body: { sha: ctx.sha, pr: ctx.pr, event: ctx.event, attempt: ctx.runAttempt, cliVersion: "1.7.0", capabilities: ["managed_boot", "boot_probe"], probe: ctx.probe },
  };
  const gate = fakeRes();
  let admitted = false;
  await makeRunnerAuth({ verify: async () => ({ ok: true, claims }) as any })(req, gate, () => void (admitted = true));
  assert.ok(admitted, `a dispatched run must pass the runner gate, not ${gate.body?.error}`);
  assert.equal(req.runner.repo.id, repo.id);

  // 5. resolveHandler routes that pr into the onboarding branch and hands back the App's own row.
  const resolved = fakeRes();
  await resolveHandler(req, resolved);
  assert.equal(resolved.body.probe?.probeId, row.id, "the row the App minted, never a second one");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === repo.id).length, 1);
  // Exactly the branch run.ts takes, and exactly the BootProbeOffer runBootProbe destructures.
  assert.ok(resolved.body.status === "empty" && resolved.body.probe);
  assert.deepEqual(Object.keys(resolved.body.probe).sort(), ["probeId", "uploadLimits"]);
  assert.deepEqual(resolved.body.probe.uploadLimits, { ...PROBE_UPLOAD_LIMITS });

  // 6. That run signs its boot log and reports, through the guard both probe endpoints share.
  const asRun = { ...DISPATCHED, sha: ctx.sha };
  const signed = fakeRes();
  await probeArtifactsHandler(probeReq(repo, row.id, { ...signBody(1_024), sha: ctx.sha }, asRun), signed);
  assert.equal(signed.statusCode, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.uploads.length, 1);
  const settled: string[] = [];
  const done = fakeRes();
  await makeProbeResultHandler({ settle: async (id) => void settled.push(id) })(probeReq(repo, row.id, report({ sha: ctx.sha }), asRun), done);
  assert.deepEqual(done.body, { ok: true });
  assert.deepEqual(settled, [row.id], "and the App settles the re-check it asked for");
  assert.equal(db.find("bootProbes", (p) => p.id === row.id)!.status, "reported");
});

test("a runner too old to echo the App's token says so, instead of leaving the panel waiting out the expiry", async () => {
  const repo = seedOnboarded();
  const probe = seedRecheck(repo);
  db.update("repositories", (r) => r.id === repo.id, {
    verify: { ...repoVerify(repo), onboarding: { ...repoVerify(repo).onboarding, bootCheck: { at: Date.now(), probeId: probe.id, dispatched: true } } },
  });

  // 1.7.0: announces boot_probe, but its resolve carries no probe token at all.
  const out = await resolve(repo, { capabilities: ["managed_boot", "boot_probe"], sha: SHA }, { event_name: "repository_dispatch", ref: "refs/heads/main" });
  assert.equal(out.body.probe, undefined, "there is nothing it could have claimed");
  assert.equal(repoVerify(repo).onboarding.bootCheck!.error, RECHECK_RUNNER_OUTDATED, "and the reason is recorded for the panel");
  assert.equal(db.find("bootProbes", (p) => p.id === probe.id)!.status, "offered", "the row is untouched — a newer runner could still claim it");

  // A run for some other commit is not this re-check's, so it says nothing about the runner.
  const other = seedOnboarded();
  const otherProbe = seedRecheck(other);
  db.update("repositories", (r) => r.id === other.id, {
    verify: { ...repoVerify(other), onboarding: { ...repoVerify(other).onboarding, bootCheck: { at: Date.now(), probeId: otherProbe.id, dispatched: true } } },
  });
  await resolve(other, { capabilities: ["boot_probe"], sha: "f".repeat(40) }, { event_name: "repository_dispatch", ref: "refs/heads/main" });
  assert.equal(repoVerify(other).onboarding.bootCheck!.error, undefined, "a different commit's run is not evidence about the runner");
});

test("two clicks at once spend one branch-tip read between them, not one each", async () => {
  const t = seedTenant();
  let tips = 0;
  const handler = makeBootCheckHandler({
    branchTip: async () => { tips += 1; await new Promise((r) => setTimeout(r, 10)); return SHA; },
    dispatch: async () => {},
  });
  const call = () => { const res = fakeRes(); return handler(ownerReq(t.userId, t.repo.id), res).then(() => res); };
  const [a, b] = await Promise.all([call(), call()]);

  assert.equal(tips, 1, "the GitHub read is behind the throttle, not in front of it");
  const outcomes = [a.body, b.body].sort((x: any, y: any) => Number(y.dispatched) - Number(x.dispatched));
  assert.deepEqual(outcomes[0], { ok: true, dispatched: true });
  assert.equal(outcomes[1].dispatched, false, "the second click is refused");
  assert.equal(outcomes[1].reason, "cooldown");
  assert.equal(db.filter("bootProbes", (p) => p.repoId === t.repo.id && p.kind === "recheck").length, 1, "and only one probe exists");
});

test("a re-check whose repo was reset mid-dispatch does not leave a bootCheck naming its probe", async () => {
  const t = seedTenant();
  const handler = makeBootCheckHandler({
    branchTip: async () => SHA,
    // The reset lands while GitHub is being asked, i.e. before the result is recorded.
    dispatch: async () => {
      const v = db.find("repositories", (r) => r.id === t.repo.id)!.verify!;
      db.update("repositories", (r) => r.id === t.repo.id, { verify: { ...v, onboarding: { state: "none" } } });
    },
  });
  const res = fakeRes();
  await handler(ownerReq(t.userId, t.repo.id), res);
  assert.equal(res.body.dispatched, true, "GitHub did take the dispatch");
  const ob = db.find("repositories", (r) => r.id === t.repo.id)!.verify!.onboarding;
  assert.equal(ob.prNumber, undefined, "the reset stands");
  assert.equal(ob.bootCheck, undefined, "and no bootCheck was written onto it");
});
