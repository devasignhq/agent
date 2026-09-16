// Offline: the boot probe the setup PR's own CI run is offered, and the two endpoints
// it reports back through. Everything the runner sends is untrusted — the signed OIDC
// claims decide whose repo and which PR this is, never the body.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/routes/v1-probe.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { setArtifactStorageForTests } from "../verify/storage.js";
import { PROBE_EXPIRE_MS } from "../verify/reaper.js";
import {
  makeProbeResultHandler,
  MAX_PROBES_PER_PR,
  probeArtifactsHandler,
  PROBE_UPLOAD_LIMITS,
  resolveHandler,
} from "./v1.js";
import type { BootProbe, Repository } from "../types.js";

const SHA = "b".repeat(40);
const PR = 31;

const storage = (signPut: (key: string) => Promise<{ url: string; headers: Record<string, string> }>) =>
  ({ signPut, signGet: async (key: string) => `https://get.example/${key}`, head: async () => null, remove: async () => {} }) as any;
const instant = async (key: string) => ({ url: `https://put.example/${key}`, headers: { "Content-Type": "text/plain" } });

setArtifactStorageForTests(storage(instant));
after(() => setArtifactStorageForTests(undefined));

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
