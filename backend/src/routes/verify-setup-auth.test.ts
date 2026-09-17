// The owner-scoped setup routes; the GET reports browser-test setup from a throttled default-yml snapshot.
// Run: ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= node --import tsx/esm --test src/routes/verify-setup-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { signSession } from "../github/oauth.js";
import { onJob, type Job } from "../queue.js";
import type { RepoVerifyState } from "../types.js";
import { makeSetupRecheckHandler, makeVerifySetupHandler, RECHECK_COMMIT_MESSAGE, RECHECK_COOLDOWN_MS, setupPrHandler } from "./api.js";
import { setupSnapshot } from "../verify/setup-snapshot.js";
import { ONBOARDING_BRANCH } from "../verify/onboarding/generate.js";

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

// The panel's own GitHub reads are a separate dep: a test that says nothing about them must
// not reach for a real installation token.
const noSnapshot = async () => ({ proposed: null, tree: null });

function fakeGitHub(yml: string | null, snapshot: typeof setupSnapshot = noSnapshot) {
  const gh = { sha: "sha-1", yml, clock: 1_000_000, shaCalls: 0, readCalls: 0 };
  const deps = {
    branchSha: async () => { gh.shaCalls++; return gh.sha; },
    read: async () => { gh.readCalls++; return gh.yml; },
    now: () => gh.clock,
  };
  return { gh, handler: makeVerifySetupHandler(deps, { snapshot }) };
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
    const shaFails = makeVerifySetupHandler({ branchSha: async () => { gh.shaCalls++; throw new Error("GitHub 404: Branch not found"); }, read: async () => { gh.readCalls++; return null; }, now: () => gh.clock }, { snapshot: noSnapshot });
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
    const readFails = makeVerifySetupHandler({ branchSha: async () => "sha-1", read: async () => { throw new Error("gh text 502 on /contents"); }, now: () => gh.clock }, { snapshot: noSnapshot });
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
    const handler = makeVerifySetupHandler({ branchSha: async () => "sha-1", now: () => 9_000_000 }, { snapshot: noSnapshot });
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
    { waitMs: 5, snapshot: noSnapshot }
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

test("a refresh that fails, before or after the wait, is logged and never an unhandled rejection", async () => {
  const mine = tenant("setup-refresh-fails");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const warned: string[] = [];
  const warn = console.warn;
  process.on("unhandledRejection", onUnhandled);
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    const late = makeVerifySetupHandler(undefined, { waitMs: 5, snapshot: noSnapshot, refresh: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 25)) });
    const lateRes = await getSetup(late, mine.userId, mine.repoId);
    assert.equal(lateRes.statusCode, 200);
    assert.equal(lateRes.body.browserTests.status, "unknown", "answered from the stored snapshot while the refresh is still running");
    await new Promise((r) => setTimeout(r, 60));

    const early = makeVerifySetupHandler(undefined, { waitMs: 1_000, snapshot: noSnapshot, refresh: () => Promise.reject(new Error("early boom")) });
    const earlyRes = await getSetup(early, mine.userId, mine.repoId);
    assert.equal(earlyRes.statusCode, 200, "a rejection that beats the wait does not throw out of the handler");

    const sync = makeVerifySetupHandler(undefined, { waitMs: 1_000, snapshot: noSnapshot, refresh: () => { throw new Error("sync boom"); } });
    assert.equal((await getSetup(sync, mine.userId, mine.repoId)).statusCode, 200);

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    for (const boom of ["late boom", "early boom", "sync boom"]) {
      assert.ok(warned.some((w) => w.includes("default-yml refresh failed") && w.includes(boom)), `${boom} is logged`);
    }
  } finally {
    console.warn = warn;
    process.off("unhandledRejection", onUnhandled);
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

const viteConfig = (port: number) => `export default { server: { port: ${port}, proxy: { '/api': 'http://localhost:8787' } } };\n`;
const vitePkg = JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^8.2.1" } });

const TREE_PATHS = [
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "backend/package.json",
  "backend/.env.example",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "scripts/devasign-login.mjs",
];

const TREE_FILES: Record<string, string> = {
  ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm ci\n",
  "package.json": JSON.stringify({ workspaces: ["backend", "frontend"], scripts: { test: "node --test" } }),
  "backend/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/server.ts" }, dependencies: { express: "^4.19.2" } }),
  "backend/.env.example": "DATABASE_URL=\nPORT=8787\n",
  "frontend/package.json": vitePkg,
  "frontend/vite.config.ts": viteConfig(3001),
};

const BRANCH_YML = "verify:\n  e2e: auto\n  start: npm --prefix frontend run dev -- --port 3001 --strictPort\n  url: http://localhost:3001\n";

test("the panel is told what the setup PR proposes and which packages it could pick from", async () => {
  const mine = tenant("setup-candidates", { onboarding: { state: "pr_open", prNumber: 7, setupPrOpen: true, mode: "extend", expectedSecrets: ["API_KEY", "STRIPE_KEY"], missingSecrets: ["STRIPE_KEY"] } });
  const calls = { trees: 0, reads: [] as string[] };
  const snapshot: typeof setupSnapshot = (repoId, sha) =>
    setupSnapshot(repoId, sha, {
      tree: async () => { calls.trees++; return TREE_PATHS.map((path) => ({ path, type: "blob", sha: "s", size: 1 })) as any; },
      read: async (_i, _r, path, ref) => { calls.reads.push(`${path}@${ref}`); return ref === ONBOARDING_BRANCH ? BRANCH_YML : TREE_FILES[path] ?? null; },
    });
  const { handler } = fakeGitHub("verify:\n  e2e: auto\n", snapshot);
  try {
    const res = await getSetup(handler, mine.userId, mine.repoId);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.proposed, { e2e: "auto", start: "npm --prefix frontend run dev -- --port 3001 --strictPort", url: "http://localhost:3001" });

    const c = res.body.candidates;
    assert.deepEqual(c.packages.map((p: any) => p.dir), ["frontend", "backend", "."]);
    assert.deepEqual(c.packages[0], { dir: "frontend", pm: "npm", framework: "vite", scripts: ["dev", "build"], port: 3001, proxyPort: 8787 });
    assert.deepEqual(c.loginScripts, ["scripts/devasign-login.mjs"]);
    assert.deepEqual([c.secretNames, c.missingSecrets], [["API_KEY"], ["STRIPE_KEY"]]);
    assert.equal(c.secretsUrl, "https://github.com/setup-candidates/r/settings/secrets/actions");
    assert.equal(calls.reads.filter((r) => r.endsWith(`@${ONBOARDING_BRANCH}`)).length, 1, "the branch yml is read once");

    // The tree is the expensive half, so a second open at the same default head reuses it.
    await getSetup(handler, mine.userId, mine.repoId);
    assert.equal(calls.trees, 1);
  } finally {
    mine.cleanup();
  }
});

test("a closed setup PR proposes nothing, and no tree means empty pickers rather than a guess", async () => {
  const mine = tenant("setup-no-pr", { onboarding: { state: "pr_closed", prNumber: 7, setupPrOpen: false } });
  const reads: string[] = [];
  const snapshot: typeof setupSnapshot = (repoId, sha) =>
    setupSnapshot(repoId, sha, { tree: async () => [], read: async (_i, _r, path, ref) => { reads.push(`${path}@${ref}`); return null; } });
  const { handler } = fakeGitHub("verify:\n  e2e: auto\n", snapshot);
  try {
    const res = await getSetup(handler, mine.userId, mine.repoId);
    assert.equal(res.body.proposed, null);
    assert.deepEqual(res.body.candidates.packages, []);
    assert.deepEqual([res.body.candidates.secretNames, res.body.candidates.missingSecrets], [null, null]);
    assert.deepEqual(reads, [], "nothing is read off a branch whose PR is closed");
  } finally {
    mine.cleanup();
  }
});

test("setup-pr carries validated answers to the job, and refuses the ones that are not", async () => {
  const mine = tenant("setup-pr-answers");
  const seen: Job[] = [];
  onJob((job) => { seen.push(job); });
  const post = (body: unknown) => {
    const res = fakeRes();
    setupPrHandler({ cookies: cookies(mine.userId), params: { id: mine.repoId }, body } as any, res);
    return res;
  };
  const drain = () => new Promise((r) => setImmediate(r));
  try {
    const before = seen.length;
    for (const answers of [
      { start: { dir: "frontend", script: "dev", port: 80 } },
      { start: { dir: "../etc", script: "dev", port: 3001 } },
      { login: { script: "scripts/../../etc/passwd.sh" } },
      { env: ["GITHUB_TOKEN"] },
      { timeout: 5 },
      { e2e: "never", start: { dir: "frontend", script: "dev", port: 3001 } },
      { nope: 1 },
      "not an object",
    ]) {
      const res = post({ answers });
      assert.equal(res.statusCode, 400, JSON.stringify(answers));
      assert.equal(res.body.error, "invalid_answers");
      assert.equal(typeof res.body.message, "string");
    }
    await drain();
    assert.equal(seen.length, before, "nothing invalid reached the queue");

    const ok = post({
      mode: "extend",
      answers: {
        start: { dir: "frontend", script: "dev", port: 3001 },
        servers: [{ dir: "backend", script: "dev", port: 8787, ready: "/health" }],
        login: { script: "scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
        env: ["API_KEY"],
        timeout: 240,
      },
    });
    assert.equal(ok.statusCode, 200);
    await drain();
    assert.deepEqual(seen[seen.length - 1].payload, {
      repoId: mine.repoId,
      trigger: "manual",
      mode: "extend",
      workflow: undefined,
      answers: {
        start: "npm --prefix frontend run dev -- --port 3001 --strictPort",
        url: "http://localhost:3001",
        ready: "/",
        servers: [{ name: "backend", start: "npm --prefix backend run dev", url: "http://localhost:8787", ready: "/health" }],
        login: { script: "node ./scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
        env: ["API_KEY"],
        timeout: 240,
      },
    });
  } finally {
    mine.cleanup();
  }
});

function recheck(deps: Parameters<typeof makeSetupRecheckHandler>[0], userId: string | undefined, repoId: string) {
  const res = fakeRes();
  return makeSetupRecheckHandler(deps)({ cookies: cookies(userId), params: { id: repoId } } as any, res).then(() => res);
}

const openSetupPr = (): RepoVerifyState => ({ onboarding: { state: "pr_open", prNumber: 12, setupPrOpen: true } });

test("re-check updates the setup PR's branch, and falls back to an empty commit when GitHub has nothing to merge", async () => {
  const mine = tenant("recheck-owner", openSetupPr());
  const stranger = tenant("recheck-stranger");
  const calls = { updated: [] as number[], commits: [] as Array<{ branch: string; message: string }> };
  const deps = {
    updateBranch: async (_i: any, _r: any, n: number) => { calls.updated.push(n); return true; },
    emptyCommit: async (_i: any, _r: any, branch: string, message: string) => { calls.commits.push({ branch, message }); return "newsha"; },
  };
  const past = () => db.update("repositories", (r) => r.id === mine.repoId, { verify: { onboarding: { ...openSetupPr().onboarding, recheckedAt: Date.now() - RECHECK_COOLDOWN_MS - 1 } } });
  try {
    assert.equal((await recheck(deps, undefined, mine.repoId)).statusCode, 401);
    assert.equal((await recheck(deps, stranger.userId, mine.repoId)).statusCode, 403);
    assert.deepEqual([calls.updated, calls.commits], [[], []]);

    const first = await recheck(deps, mine.userId, mine.repoId);
    assert.deepEqual(first.body, { ok: true, pushed: true, how: "update_branch" });
    assert.deepEqual(calls.updated, [12]);
    assert.deepEqual(calls.commits, [], "a branch GitHub actually moved already fired synchronize");

    const throttled = await recheck(deps, mine.userId, mine.repoId);
    assert.equal(throttled.statusCode, 429);
    assert.equal(throttled.body.reason, "cooldown");
    assert.ok(throttled.body.retryAfterMs > 0 && throttled.body.retryAfterMs <= RECHECK_COOLDOWN_MS);
    assert.deepEqual(calls.updated, [12], "a click inside the cooldown never reaches GitHub");

    past();
    const upToDate = await recheck({ ...deps, updateBranch: async () => false }, mine.userId, mine.repoId);
    assert.deepEqual(upToDate.body, { ok: true, pushed: true, how: "empty_commit" });
    assert.deepEqual(calls.commits, [{ branch: ONBOARDING_BRANCH, message: RECHECK_COMMIT_MESSAGE }]);

    past();
    const failed = await recheck({ updateBranch: async () => false, emptyCommit: async () => null }, mine.userId, mine.repoId);
    assert.deepEqual(failed.body, { ok: true, pushed: false, reason: "push_failed" });
    assert.equal((await recheck(deps, mine.userId, mine.repoId)).statusCode, 429, "a push GitHub refused still holds the cooldown");
  } finally {
    mine.cleanup();
    stranger.cleanup();
  }
});

test("re-check says which case it refused for when there is no open setup PR", async () => {
  const none = tenant("recheck-none");
  const merged = tenant("recheck-merged", { onboarding: { state: "pr_merged", prNumber: 12, setupPrOpen: false } });
  const deps = { updateBranch: async () => { throw new Error("must not be called"); }, emptyCommit: async () => { throw new Error("must not be called"); } };
  try {
    for (const repoId of [none.repoId, merged.repoId]) {
      const res = await recheck(deps, repoId === none.repoId ? none.userId : merged.userId, repoId);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { ok: true, pushed: false, reason: "no_setup_pr" });
    }
  } finally {
    none.cleanup();
    merged.cleanup();
  }
});

test("answers posted just after the panel opened are judged against the tree it read", async () => {
  const mine = tenant("setup-answers-tree", { onboarding: { state: "pr_open", prNumber: 7, setupPrOpen: true, mode: "extend" } });
  const seen: Job[] = [];
  onJob((job) => { seen.push(job); });
  const snapshot: typeof setupSnapshot = (repoId, sha) =>
    setupSnapshot(repoId, sha, {
      tree: async () => TREE_PATHS.map((path) => ({ path, type: "blob", sha: "s", size: 1 })) as any,
      read: async (_i, _r, path, ref) => (ref === ONBOARDING_BRANCH ? BRANCH_YML : TREE_FILES[path] ?? null),
    });
  const post = (answers: unknown) => {
    const res = fakeRes();
    setupPrHandler({ cookies: cookies(mine.userId), params: { id: mine.repoId }, body: { answers } } as any, res);
    return res;
  };
  try {
    // Shape alone cannot tell these apart: both name a real directory and a plausible script.
    assert.equal(post({ start: { dir: "frontend", script: "preview", port: 3001 } }).statusCode, 200);
    assert.equal(post({ login: { script: "scripts/nope.mjs" } }).statusCode, 200);

    await getSetup(makeVerifySetupHandler({ branchSha: async () => "sha-1", read: async () => "verify:\n  e2e: auto\n", now: () => 1_000_000 }, { snapshot }), mine.userId, mine.repoId);

    const noScript = post({ start: { dir: "frontend", script: "preview", port: 3001 } });
    assert.equal(noScript.statusCode, 400);
    assert.match(noScript.body.message, /preview/);
    const noFile = post({ login: { script: "scripts/nope.mjs" } });
    assert.equal(noFile.statusCode, 400);
    assert.match(noFile.body.message, /scripts\/nope\.mjs/);

    const before = seen.length;
    assert.equal(post({ start: { dir: "frontend", script: "dev", port: 3001 }, login: { script: "scripts/devasign-login.mjs" } }).statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, before + 1);
  } finally {
    mine.cleanup();
  }
});
