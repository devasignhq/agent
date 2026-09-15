// The owner-scoped setup routes; the GET reports browser-test setup from a throttled default-yml snapshot.
// Run: ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= node --import tsx/esm --test src/routes/verify-setup-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { onJob, type Job } from "../queue.js";
import type { RepoVerifyState } from "../types.js";
import { makeVerifySetupHandler, setupPrHandler } from "./api.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

function tenant(login: string, verify?: RepoVerifyState) {
  const userId = uuid(), installId = uuid(), repoId = uuid();
  const gh = Math.floor(Math.random() * 1e9);
  db.insert("users", { id: userId, githubId: gh, githubLogin: login, email: `${login}@x.z`, plan: "pro", createdAt: Date.now() } as any);
  db.insert("installations", { id: installId, userId, accountId: gh, accountLogin: login, installationId: gh, repoIds: [] } as any);
  db.insert("repositories", { id: repoId, installationId: installId, owner: login, name: "r", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true, ...(verify ? { verify } : {}) } as any);
  const cleanup = () => {
    db.remove("repositories", (r) => r.id === repoId);
    db.remove("installations", (i) => i.id === installId);
    db.remove("users", (u) => u.id === userId);
  };
  return { userId, repoId, cleanup };
}

function fakeGitHub(yml: string | null) {
  const gh = { sha: "sha-1", yml, clock: 1_000_000, shaCalls: 0, readCalls: 0 };
  const deps = {
    branchSha: async () => { gh.shaCalls++; return gh.sha; },
    read: async () => { gh.readCalls++; return gh.yml; },
    now: () => gh.clock,
  };
  return { gh, handler: makeVerifySetupHandler(deps) };
}

const cookies = (userId?: string) => (userId ? { devasign_session: signSession(userId) } : {});

async function getSetup(handler: ReturnType<typeof makeVerifySetupHandler>, userId: string | undefined, repoId: string) {
  const res = fakeRes();
  await handler({ cookies: cookies(userId), params: { id: repoId } } as any, res);
  return res;
}

test("setup status refuses signed-out, unknown and foreign callers before touching GitHub", async () => {
  const mine = tenant("setup-owner");
  const stranger = tenant("setup-stranger");
  const { gh, handler } = fakeGitHub("verify:\n  start: npm start\n  url: http://localhost:3000\n");
  try {
    assert.equal((await getSetup(handler, undefined, mine.repoId)).statusCode, 401);
    assert.equal((await getSetup(handler, mine.userId, uuid())).statusCode, 404);
    const foreign = await getSetup(handler, stranger.userId, mine.repoId);
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.body.browserTests, undefined);
    assert.equal(gh.shaCalls + gh.readCalls, 0);
    assert.equal(db.find("repositories", (r) => r.id === mine.repoId)?.verify?.defaultYml, undefined);
  } finally {
    mine.cleanup();
    stranger.cleanup();
  }
});

test("a default yml without start and url is not_configured, and the old fields are unchanged", async () => {
  const mine = tenant("setup-bare");
  const { handler } = fakeGitHub("verify:\n  e2e: auto\n  install: npm ci\n");
  try {
    const res = await getSetup(handler, mine.userId, mine.repoId);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.onboarding, { state: "none" });
    assert.equal(res.body.detected, null);
    assert.equal(res.body.devasignYml, null);
    assert.equal(res.body.runnerSeen, false);
    const bt = res.body.browserTests;
    assert.equal(bt.status, "not_configured");
    assert.deepEqual(bt.missing, ["start", "url"]);
    assert.equal(bt.lastBrowserless, null);
    assert.deepEqual(bt.defaultYml, { e2e: "auto", install: "npm ci" });
    assert.ok(bt.fixUrl.endsWith(`/workflow?repo=${mine.repoId}&setup=browser`), bt.fixUrl);
  } finally {
    mine.cleanup();
  }
});

test("only the missing boot key is reported", async () => {
  const mine = tenant("setup-half");
  const { handler } = fakeGitHub("verify:\n  start: npm start\n");
  try {
    const bt = (await getSetup(handler, mine.userId, mine.repoId)).body.browserTests;
    assert.equal(bt.status, "not_configured");
    assert.deepEqual(bt.missing, ["url"]);
  } finally {
    mine.cleanup();
  }
});

test("boot config present is unproven, or failing once a run could not start the app", async () => {
  const lastBrowserless = { count: 2, reason: "did_not_start" as const, runId: "run-1", prNumber: 9, at: 5 };
  const fresh = tenant("setup-boot");
  const failed = tenant("setup-failed", { onboarding: { state: "pr_merged" }, lastBrowserless });
  const yml = "verify:\n  start: npm start\n  url: http://localhost:3000\n";
  try {
    const ok = (await getSetup(fakeGitHub(yml).handler, fresh.userId, fresh.repoId)).body.browserTests;
    assert.equal(ok.status, "unproven");
    assert.deepEqual(ok.missing, []);
    assert.deepEqual(ok.defaultYml, { start: "npm start", url: "http://localhost:3000" });

    const res = await getSetup(fakeGitHub(yml).handler, failed.userId, failed.repoId);
    assert.equal(res.body.browserTests.status, "failing");
    assert.deepEqual(res.body.browserTests.lastBrowserless, lastBrowserless);
    assert.deepEqual(res.body.onboarding, { state: "pr_merged" });
  } finally {
    fresh.cleanup();
    failed.cleanup();
  }
});

test("e2e: never is disabled even without boot config", async () => {
  const mine = tenant("setup-never");
  const { handler } = fakeGitHub("verify:\n  e2e: never\n");
  try {
    const bt = (await getSetup(handler, mine.userId, mine.repoId)).body.browserTests;
    assert.equal(bt.status, "disabled");
    assert.deepEqual(bt.missing, []);
  } finally {
    mine.cleanup();
  }
});

test("the default-branch refresh is throttled to once a minute per repo", async () => {
  const mine = tenant("setup-throttle");
  const { gh, handler } = fakeGitHub("verify:\n  e2e: auto\n");
  try {
    assert.equal((await getSetup(handler, mine.userId, mine.repoId)).body.browserTests.status, "not_configured");
    assert.equal(gh.readCalls, 1);

    gh.sha = "sha-2";
    gh.yml = "verify:\n  start: npm start\n  url: http://localhost:3000\n";
    gh.clock += 30_000;
    const throttled = (await getSetup(handler, mine.userId, mine.repoId)).body.browserTests;
    assert.equal(gh.shaCalls, 1);
    assert.equal(gh.readCalls, 1);
    assert.equal(throttled.status, "not_configured", "still the cached snapshot");

    gh.clock += 31_000;
    const refreshed = (await getSetup(handler, mine.userId, mine.repoId)).body.browserTests;
    assert.equal(gh.readCalls, 2);
    assert.equal(refreshed.status, "unproven");
    assert.equal(db.find("repositories", (r) => r.id === mine.repoId)?.verify?.defaultYml?.sha, "sha-2");

    gh.clock += 61_000;
    await getSetup(handler, mine.userId, mine.repoId);
    assert.deepEqual([gh.shaCalls, gh.readCalls], [3, 2], "an unmoved head is not read again");
    assert.equal(db.find("repositories", (r) => r.id === mine.repoId)?.verify?.defaultYml?.at, gh.clock, "but the check still restarts the window");
    gh.clock += 30_000;
    await getSetup(handler, mine.userId, mine.repoId);
    assert.equal(gh.shaCalls, 3);
  } finally {
    mine.cleanup();
  }
});

test("a GitHub error answers with the stored snapshot, and failed attempts are throttled too", async () => {
  const snapshot = { sha: "sha-0", parsed: { start: "npm start", url: "http://localhost:3000" }, bootHash: "h", at: 0 };
  const stored = tenant("setup-gh-down", { onboarding: { state: "none" }, defaultYml: snapshot });
  const empty = tenant("setup-gh-down-empty");
  const { gh, handler } = fakeGitHub("verify:\n  e2e: auto\n");
  const errors = console.warn;
  console.warn = () => {};
  try {
    gh.clock = 500_000;
    const shaFails = makeVerifySetupHandler({ branchSha: async () => { gh.shaCalls++; throw new Error("GitHub 404: Branch not found"); }, read: async () => { gh.readCalls++; return null; }, now: () => gh.clock });
    const res = await getSetup(shaFails, stored.userId, stored.repoId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.browserTests.status, "unproven");
    assert.deepEqual(db.find("repositories", (r) => r.id === stored.repoId)?.verify?.defaultYml, snapshot);

    const none = await getSetup(shaFails, empty.userId, empty.repoId);
    assert.equal(none.statusCode, 200);
    assert.equal(none.body.browserTests.status, "unknown");
    assert.equal(none.body.browserTests.defaultYml, null);
    await getSetup(shaFails, empty.userId, empty.repoId);
    assert.equal(gh.shaCalls, 2, "the second open inside the window does not retry GitHub");

    gh.clock += 61_000;
    const readFails = makeVerifySetupHandler({ branchSha: async () => "sha-1", read: async () => { throw new Error("gh text 502 on /contents"); }, now: () => gh.clock });
    await getSetup(readFails, empty.userId, empty.repoId);
    assert.equal(db.find("repositories", (r) => r.id === empty.repoId)?.verify?.defaultYml, undefined, "a failed read is not cached as a missing file");
    gh.clock += 61_000;
    assert.equal((await getSetup(handler, empty.userId, empty.repoId)).body.browserTests.status, "not_configured");
    assert.equal(gh.readCalls, 1, "the same head is read again once the read works");
  } finally {
    console.warn = errors;
    stored.cleanup();
    empty.cleanup();
  }
});

test("the default reader never turns a failed GitHub read into a cached missing file", async () => {
  const mine = tenant("setup-default-reader");
  const originalFetch = globalThis.fetch;
  const errors = console.warn;
  globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => "bad gateway" })) as any;
  console.warn = () => {};
  try {
    const handler = makeVerifySetupHandler({ branchSha: async () => "sha-1", now: () => 9_000_000 });
    assert.equal((await getSetup(handler, mine.userId, mine.repoId)).statusCode, 200);
    assert.equal(db.find("repositories", (r) => r.id === mine.repoId)?.verify?.defaultYml, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = errors;
    mine.cleanup();
  }
});

test("concurrent opens share one refresh, and a slow GitHub still gets an answer", async () => {
  const mine = tenant("setup-concurrent");
  let release!: (sha: string) => void;
  let shaCalls = 0;
  const handler = makeVerifySetupHandler(
    { branchSha: () => { shaCalls++; return new Promise<string>((r) => { release = r; }); }, read: async () => "verify:\n  start: npm start\n  url: http://localhost:3000\n", now: () => 7_000_000 },
    { waitMs: 5 }
  );
  try {
    const [a, b] = await Promise.all([getSetup(handler, mine.userId, mine.repoId), getSetup(handler, mine.userId, mine.repoId)]);
    assert.equal(shaCalls, 1);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
    assert.equal(a.body.browserTests.status, "unknown", "answered from what is stored while GitHub is slow");
    release("sha-1");
    await new Promise((r) => setImmediate(r));
    assert.equal(db.find("repositories", (r) => r.id === mine.repoId)?.verify?.defaultYml?.sha, "sha-1", "the refresh still lands");
  } finally {
    mine.cleanup();
  }
});

test("a detected Playwright config counts as boot config, as it does for the planner", async () => {
  const detected = { languages: ["ts"], frameworks: [{ name: "playwright", configPath: "playwright.config.ts" }], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } as any;
  const configured = tenant("setup-playwright", { onboarding: { state: "verified" }, detected });
  const failing = tenant("setup-playwright-failing", { onboarding: { state: "verified" }, detected, lastBrowserless: { count: 1, reason: "did_not_start", runId: "r", prNumber: 2, at: 3 } });
  const bare = tenant("setup-playwright-none", { onboarding: { state: "verified" }, detected: { ...detected, frameworks: [{ name: "playwright" }] } });
  const yml = "verify:\n  e2e: auto\n";
  try {
    assert.deepEqual((await getSetup(fakeGitHub(yml).handler, configured.userId, configured.repoId)).body.browserTests.missing, []);
    assert.equal((await getSetup(fakeGitHub(yml).handler, configured.userId, configured.repoId)).body.browserTests.status, "unproven");
    assert.equal((await getSetup(fakeGitHub(yml).handler, failing.userId, failing.repoId)).body.browserTests.status, "failing");
    const noConfig = (await getSetup(fakeGitHub(yml).handler, bare.userId, bare.repoId)).body.browserTests;
    assert.deepEqual([noConfig.status, noConfig.missing], ["not_configured", ["start", "url"]], "Playwright without a config file does not boot anything");
  } finally {
    configured.cleanup();
    failing.cleanup();
    bare.cleanup();
  }
});

test("setup-pr still enqueues an onboarding job with mode and workflow, owner only", async () => {
  const mine = tenant("setup-pr-owner");
  const stranger = tenant("setup-pr-stranger");
  const seen: Job[] = [];
  onJob((job) => { seen.push(job); });
  const post = (userId: string | undefined, body: unknown) => {
    const res = fakeRes();
    setupPrHandler({ cookies: cookies(userId), params: { id: mine.repoId }, body } as any, res);
    return res;
  };
  const drain = () => new Promise((r) => setImmediate(r));
  try {
    assert.equal(post(undefined, { mode: "extend" }).statusCode, 401);
    assert.equal(post(stranger.userId, { mode: "extend" }).statusCode, 403);
    await drain();
    assert.equal(seen.length, 0);

    const res = post(mine.userId, { mode: "extend", workflow: ".github/workflows/ci.yml" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, queued: true });
    await drain();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].payload, { repoId: mine.repoId, trigger: "manual", mode: "extend", workflow: ".github/workflows/ci.yml" });

    post(mine.userId, { mode: "bogus", workflow: 42 });
    await drain();
    assert.deepEqual(seen[1].payload, { repoId: mine.repoId, trigger: "manual", mode: "separate", workflow: undefined });
  } finally {
    mine.cleanup();
    stranger.cleanup();
  }
});
