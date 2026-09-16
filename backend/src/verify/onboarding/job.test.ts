// Offline: the onboarding job against injected GitHub deps — opens the PR with
// the right files, records state, skips when already set up, follows up on a
// doctor diagnosis, and opens adopt-test PRs.
//   DATABASE_URL= node --import tsx/esm --test src/verify/onboarding/job.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { parse } from "yaml";
import { db } from "../../db.js";
import { adoptedPath, adoptGeneratedTests, noteOnboardingPrClosed, noteRunSucceeded, postDoctorFollowup, runVerifyOnboard, scriptSelects, type OnboardDeps } from "./job.js";
import { createVerifyRun, snapshotCriteriaRevision } from "../runs.js";
import { ACTION_REF, DEVASIGN_YML_PATH, generateWorkflow, ONBOARDING_BRANCH, WORKFLOW_PATH, WORKFLOW_VERSION } from "./generate.js";

function seed(over: { userId?: string } = {}) {
  const installId = uuid();
  const userId = over.userId ?? uuid();
  db.insert("users", { id: userId, githubId: 1, githubLogin: "owner", email: "o@x", plan: "pro", createdAt: 0 } as any);
  db.insert("installations", { id: installId, userId, accountId: 1, accountLogin: "acme", installationId: 9, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "shop", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  const calls = {
    branches: [] as string[],
    files: {} as Record<string, string>,
    puts: [] as string[],
    reads: [] as string[],
    prs: [] as any[],
    bodies: [] as string[],
    updated: [] as number[],
    caughtUp: [] as number[],
    comments: [] as string[],
    openPr: null as { number: number; html_url: string; body?: string } | null,
    branchTip: null as string | null,
  };
  let clock = 0;
  const tree = ["package.json", "package-lock.json", "src/app.ts", "src/app.test.ts", ".env.example", ".github/workflows/ci.yml"];
  const contents: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest run" }, dependencies: { vite: "5" }, devDependencies: { vitest: "2" } }),
    ".env.example": "API_KEY=\nDATABASE_URL=\n",
    ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n",
  };
  const deps: OnboardDeps = {
    branchSha: async () => "headsha",
    tree: async () => tree.map((path) => ({ path, type: "blob", sha: "s", size: 1 })),
    read: async (_i, _r, path, ref) => { calls.reads.push(`${path}@${ref}`); return calls.files[path] ?? contents[path] ?? null; },
    branchTip: async () => calls.branchTip,
    ensureBranch: async (_i, _r, branch) => { calls.branches.push(branch); },
    putFile: async (_i, _r, _b, path, content) => { calls.puts.push(path); calls.files[path] = content; },
    createPr: async (_i, _r, args) => { calls.prs.push(args); return { number: 40 + calls.prs.length, html_url: `https://github.com/acme/shop/pull/${40 + calls.prs.length}` }; },
    findPr: async () => calls.openPr,
    updatePr: async (_i, _r, n, patch) => { calls.updated.push(n); calls.bodies.push(patch.body); },
    updateBranch: async (_i, _r, n) => { calls.caughtUp.push(n); return true; },
    behindBy: async () => 0,
    secretNames: async () => ["API_KEY"],
    postComment: async (_i, _r, _n, body) => { calls.comments.push(body); return 1; },
    prHeadRef: async () => "feature/refunds",
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  const cleanup = () => {
    db.remove("notifications", (n) => n.userId === userId);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
    db.remove("users", (u) => u.id === userId);
  };
  return { repo, installId, userId, deps, calls, contents, cleanup };
}

const settle = () => new Promise((r) => setImmediate(r));
const repoRow = (id: string) => db.find("repositories", (r) => r.id === id)!;
const diagnosis = { stage: "start" as const, code: "app_not_ready" as const, message: "the app did not become reachable" };

test("install → onboarding PR with the workflow + .devasign.yml, expected/missing secrets recorded, notification sent", async () => {
  const s = seed();
  try {
    const out = await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    assert.equal(out.status, "opened");
    assert.equal(out.prNumber, 41);
    assert.deepEqual(s.calls.branches, [ONBOARDING_BRANCH]);
    assert.deepEqual(Object.keys(s.calls.files).sort(), [DEVASIGN_YML_PATH, WORKFLOW_PATH]);
    const wf = parse(s.calls.files[WORKFLOW_PATH]);
    assert.equal(wf.jobs.verify.env.API_KEY, "${{ secrets.API_KEY }}");
    assert.equal(wf.jobs.verify.env.DATABASE_URL, "postgresql://postgres:postgres@localhost:5432/test");
    assert.equal(wf.jobs.verify.services.postgres.image, "postgres:16");
    const yml = parse(s.calls.files[DEVASIGN_YML_PATH]);
    assert.equal(yml.verify.url, "http://localhost:5173");
    assert.deepEqual(yml.verify.env, ["API_KEY"]);
    assert.equal(s.calls.prs[0].head, ONBOARDING_BRANCH);
    assert.equal(s.calls.prs[0].base, "main");
    assert.match(s.calls.prs[0].body, /`API_KEY` — present/);
    const repo = db.find("repositories", (r) => r.id === s.repo.id)!;
    assert.equal(repo.verify?.onboarding.state, "pr_open");
    assert.equal(repo.verify?.onboarding.prNumber, 41);
    assert.deepEqual(repo.verify?.onboarding.expectedSecrets, ["API_KEY"]);
    assert.deepEqual(repo.verify?.onboarding.missingSecrets, []);
    assert.equal(repo.verify?.onboarding.setupPrOpen, true);
    // Onboarding is still the only writer of `detected`, and the Stack row, the playwright
    // escape hatch in browserTestsStatus and hasRunnerEvidence all read it.
    assert.ok(repo.verify?.detected?.existingWorkflows, "the tree inference is still recorded");
    assert.equal(repo.verify?.onboarding.candidates?.sha, "headsha", "and what the tree said the app boots like is cached alongside it");
    const n = db.find("notifications", (x) => x.userId === s.userId);
    assert.match(n!.title, /Enable DevAsign verification on acme\/shop/);
    // A second install event does not open another PR; a manual regenerate does.
    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps)).status, "skipped");
    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps)).status, "opened");
    assert.equal(s.calls.prs.length, 2);
  } finally {
    s.cleanup();
  }
});

test("whether a dispatch can ever wake this repo's workflow is persisted, because only the file knows", async () => {
  // extendWorkflow withholds the trigger from a multi-job file, and nothing can tell
  // afterwards — so the panel would offer a check GitHub accepts and nothing ever runs.
  const one = seed();
  try {
    await runVerifyOnboard(one.repo.id, { trigger: "manual", mode: "extend", workflow: ".github/workflows/ci.yml" }, one.deps);
    assert.equal(db.find("repositories", (r) => r.id === one.repo.id)!.verify!.onboarding.dispatchable, true);
    assert.ok(parse(one.calls.files[".github/workflows/ci.yml"]).on.repository_dispatch, "and the file really did get the trigger");
  } finally {
    one.cleanup();
  }

  const many = seed();
  try {
    many.calls.files[".github/workflows/ci.yml"] =
      "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n";
    await runVerifyOnboard(many.repo.id, { trigger: "manual", mode: "extend", workflow: ".github/workflows/ci.yml" }, many.deps);
    assert.equal(db.find("repositories", (r) => r.id === many.repo.id)!.verify!.onboarding.dispatchable, false);
    assert.equal(parse(many.calls.files[".github/workflows/ci.yml"]).on.repository_dispatch, undefined, "a dispatch would run their lint job too");
  } finally {
    many.cleanup();
  }

  const own = seed();
  try {
    await runVerifyOnboard(own.repo.id, { trigger: "manual" }, own.deps);
    assert.equal(db.find("repositories", (r) => r.id === own.repo.id)!.verify!.onboarding.dispatchable, true, "our own workflow always carries the trigger");
  } finally {
    own.cleanup();
  }
});

test("extend mode appends to the existing CI job; a repo that already runs the action is marked merged; closed/merged PRs move the state", async () => {
  const s = seed();
  try {
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual", mode: "extend", workflow: ".github/workflows/ci.yml" }, s.deps);
    assert.equal(out.status, "opened");
    assert.deepEqual(Object.keys(s.calls.files).sort(), [DEVASIGN_YML_PATH, ".github/workflows/ci.yml"]);
    const ci = parse(s.calls.files[".github/workflows/ci.yml"]);
    assert.equal(ci.jobs.test.steps[2].uses, ACTION_REF);
    assert.equal(ci.jobs.test.permissions["id-token"], "write");
    assert.match(s.calls.prs[0].body, /appended to the `test` job/);
    noteOnboardingPrClosed(s.repo.id, 41, false, s.deps);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_closed");
    noteOnboardingPrClosed(s.repo.id, 41, true, s.deps);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_merged");
    noteOnboardingPrClosed(s.repo.id, 999, true, s.deps);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_merged", "another PR closing is ignored");

    // Already set up on main: an automatic trigger leaves it alone and marks it merged.
    const already = { ...s.deps, tree: async () => [{ path: WORKFLOW_PATH, type: "blob", sha: "s", size: 1 }, { path: "package.json", type: "blob", sha: "s", size: 1 }] };
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "none" } } });
    const skip = await runVerifyOnboard(s.repo.id, { trigger: "install" }, already);
    assert.equal(skip.status, "skipped");
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_merged");
  } finally {
    s.cleanup();
  }
});

test("a failed GitHub write records the error and notifies without throwing", async () => {
  const s = seed();
  try {
    const out = await runVerifyOnboard(s.repo.id, { trigger: "install" }, { ...s.deps, createPr: async () => { throw new Error("GitHub 403: Resource not accessible by integration"); } });
    assert.equal(out.status, "failed");
    const repo = db.find("repositories", (r) => r.id === s.repo.id)!;
    assert.match(repo.verify!.onboarding.lastError!, /403/);
    assert.equal(repo.verify!.onboarding.state, "none");
    const n = db.filter("notifications", (x) => x.userId === s.userId)[0];
    assert.match(n.meta, /contents: write/);
  } finally {
    s.cleanup();
  }
});

test("doctor follow-up comments on the open onboarding PR and pushes the mechanical fix; a clean run marks the repo verified", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    const review = db.insert("prReviews", { id: uuid(), repoId: s.repo.id, prNumber: 7, prTitle: "t", headSha: "abc", baseSha: "d", status: "reviewing", verdict: null, criteria: [], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
    snapshotCriteriaRevision(review.id, [], null);
    const run = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
    const before = s.calls.files[WORKFLOW_PATH];
    const out = await postDoctorFollowup(run, { stage: "install", code: "wrong_runtime_version", message: "the repository wants Node >=22 but the runner has v20.1.0", suggestedFix: { kind: "workflow_patch", instructions: "Use Node 22." } }, s.deps);
    assert.deepEqual(out, { commented: true, patched: true });
    assert.match(s.calls.comments[0], /Setup needs attention/);
    assert.match(s.calls.comments[0], /pushed a commit to this PR/);
    assert.notEqual(s.calls.files[WORKFLOW_PATH], before);
    assert.equal(parse(s.calls.files[WORKFLOW_PATH]).jobs.verify.steps.find((x: any) => x.uses?.startsWith("actions/setup-node")).with["node-version"], "22");
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.lastDiagnosis?.code, "wrong_runtime_version");
    const human = await postDoctorFollowup(run, { stage: "start", code: "no_start_command", message: "no start", missingSecrets: undefined, suggestedFix: { kind: "yml_patch", patch: "verify:\n  start: npm run dev\n", instructions: "Set start/url." } }, s.deps);
    assert.deepEqual(human, { commented: true, patched: false });
    assert.match(s.calls.comments[1], /```yaml\nverify:\n  start: npm run dev\n```/);
    assert.doesNotMatch(s.calls.comments[1], /unverifiable, not failed/, "the comment no longer promises what auto mode does not do");
    assert.match(s.calls.comments[1], /checked below browser level with a note on each PR, and reported as unverifiable only under `e2e: always`/);
    noteRunSucceeded(run);
    const repo = db.find("repositories", (r) => r.id === s.repo.id)!;
    assert.equal(repo.verify?.onboarding.state, "verified");
    assert.equal(repo.verify?.onboarding.firstSuccessfulRunId, run.id);
    assert.equal(repo.verify?.onboarding.lastDiagnosis, null);
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  } finally {
    s.cleanup();
  }
});

test("a regenerated setup PR that merges parks the repo on pr_merged, and the next clean run verifies it again", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    const review = db.insert("prReviews", { id: uuid(), repoId: s.repo.id, prNumber: 8, prTitle: "t", headSha: "abc", baseSha: "d", status: "reviewing", verdict: null, criteria: [], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
    snapshotCriteriaRevision(review.id, [], null);
    const onboarding = () => db.find("repositories", (r) => r.id === s.repo.id)!.verify!.onboarding;
    const first = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
    noteRunSucceeded(first);
    assert.equal(onboarding().state, "verified");

    const again = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps);
    assert.equal(again.status, "opened");
    assert.equal(onboarding().state, "pr_open");
    noteOnboardingPrClosed(s.repo.id, again.prNumber!, true, s.deps);
    assert.equal(onboarding().state, "pr_merged");

    const second = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
    noteRunSucceeded(second);
    assert.equal(onboarding().state, "verified");
    assert.equal(onboarding().firstSuccessfulRunId, first.id, "the first success stays on record");
    assert.equal(onboarding().lastDiagnosis, null);
    noteRunSucceeded(second);
    assert.equal(onboarding().firstSuccessfulRunId, first.id);
    db.remove("verifyRuns", (r) => r.reviewId === review.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  } finally {
    s.cleanup();
  }
});

test("a green run on the setup PR itself does not mark the repo verified — nothing has landed yet", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    const ob = () => repoRow(s.repo.id).verify!.onboarding;
    assert.equal(ob().prNumber, 41);
    // The workflow only exists on the setup branch, so the first run IS the setup PR's.
    const review = db.insert("prReviews", { id: uuid(), repoId: s.repo.id, prNumber: 41, prTitle: "Enable DevAsign verification", headSha: "abc", baseSha: "d", status: "reviewing", verdict: null, criteria: [], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
    snapshotCriteriaRevision(review.id, [], null);
    const run = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { ...repoRow(s.repo.id).verify!, onboarding: { ...ob(), lastDiagnosis: diagnosis } } });

    noteRunSucceeded(run);
    assert.equal(ob().state, "pr_open", "it proves the workflow runs, not that it reached the default branch");
    assert.equal(ob().firstSuccessfulRunId, undefined);
    assert.equal(ob().lastDiagnosis, null, "the setup problem it was diagnosed with is gone, though");

    // The bug this guards: "verified" then froze, because closing unmerged keeps that state.
    noteOnboardingPrClosed(s.repo.id, 41, false, s.deps);
    assert.equal(ob().state, "pr_closed");
    assert.notEqual((await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps)).reason, "already verified");
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("criteriaRevisions", (c) => c.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  } finally {
    s.cleanup();
  }
});

test("more workflow files than we can read is not proof the action is absent", async () => {
  const s = seed();
  try {
    const many = Array.from({ length: 11 }, (_, i) => `.github/workflows/a${String(i).padStart(2, "0")}.yml`);
    const last = many[many.length - 1];
    const tree = [...many, "package.json"].map((path) => ({ path, type: "blob" as const, sha: "s", size: 1 }));
    s.calls.files[last] = `name: nightly\non:\n  pull_request:\njobs:\n  x:\n    steps:\n      - uses: ${ACTION_REF}\n`;
    const deps = { ...s.deps, tree: async () => tree };
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "verified", firstSuccessfulRunId: "run-1" } } });

    await runVerifyOnboard(s.repo.id, { trigger: "manual" }, deps);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.state, "verified", "a file we never read cannot demote a repo that is verified");

    // Once we know where our step lives, that file is read before any other.
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "verified", firstSuccessfulRunId: "run-1", workflowPath: last } } });
    s.calls.puts.length = 0;
    await runVerifyOnboard(s.repo.id, { trigger: "manual" }, deps);
    assert.ok(s.calls.reads.some((r) => r.startsWith(`${last}@`)), "the workflow that already runs us is never the one left unread");
    assert.ok(!s.calls.puts.includes(WORKFLOW_PATH), "a second workflow beside it would verify every pull request twice");
  } finally {
    s.cleanup();
  }
});

test("adopt: generated tests land under tests/devasign/ on a branch off the PR head, PR targets the PR's branch", async () => {
  const s = seed();
  try {
    const review = db.insert("prReviews", { id: uuid(), repoId: s.repo.id, prNumber: 7, prTitle: "t", headSha: "abc1234", baseSha: "d", status: "reviewing", verdict: null, criteria: [], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
    const run = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
    const plan = db.insert("verifyPlans", { id: uuid(), schemaVersion: 1, runId: run.id, repoId: s.repo.id, criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: [
      { id: "t1", path: ".devasign/tests/e2e/criterion-1.spec.ts", content: "// e2e", criterionIds: ["1"], level: "e2e", levelReason: "", origin: "generated", runner: "playwright", testSignature: "s", strategyVersion: 1, targetFiles: [] },
      { id: "t2", path: ".devasign/tests/criterion-2.test.ts", content: "// unit", criterionIds: ["2"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "s", strategyVersion: 1, targetFiles: [] },
      { id: "t3", path: "src/app.test.ts", content: null, criterionIds: ["3"], level: "unit", levelReason: "", origin: "existing", runner: "vitest", testSignature: "s", strategyVersion: 1, targetFiles: [] },
    ] });
    db.update("verifyRuns", (r) => r.id === run.id, { planId: plan.id });
    assert.equal(adoptedPath(".devasign/tests/e2e/criterion-1.spec.ts"), "tests/devasign/e2e/criterion-1.spec.ts");
    const out = await adoptGeneratedTests(run.id, ["t1"], s.deps);
    assert.equal(out.status, "opened");
    assert.deepEqual(s.calls.branches, [`devasign/adopt-${run.id.slice(0, 8)}`]);
    assert.deepEqual(Object.keys(s.calls.files), ["tests/devasign/e2e/criterion-1.spec.ts"]);
    assert.equal(s.calls.prs[0].base, "feature/refunds");
    assert.match(s.calls.prs[0].title, /Adopt DevAsign generated tests \(PR #7\)/);
    assert.equal(db.find("verifyRuns", (r) => r.id === run.id)?.report?.adoptPrUrl, "https://github.com/acme/shop/pull/41");
    const stamped = db.find("verifyPlans", (p) => p.id === plan.id)!.tests;
    assert.equal(stamped[0].adopted?.prNumber, 41, "the adopted test remembers its PR");
    assert.equal(stamped[1].adopted, undefined);
    assert.equal((await adoptGeneratedTests(run.id, ["t1"], s.deps)).status, "skipped", "an adopted test is never re-committed");
    const all = await adoptGeneratedTests(run.id, null, s.deps);
    assert.equal(all.status, "opened");
    assert.equal(Object.keys(s.calls.files).length, 2, "existing tests are never re-committed");
    assert.equal((await adoptGeneratedTests(run.id, ["t3"], s.deps)).status, "skipped");
    db.remove("verifyPlans", (p) => p.id === plan.id);
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  } finally {
    s.cleanup();
  }
});

function seedAdoptRun(s: ReturnType<typeof seed>, prNumber = 7) {
  const review = db.insert("prReviews", { id: uuid(), repoId: s.repo.id, prNumber, prTitle: "t", headSha: "abc1234", baseSha: "d", status: "reviewing", verdict: null, criteria: [], taskId: null, additions: 0, deletions: 0, changedFiles: 0, createdAt: 0, updatedAt: 0 } as any);
  const run = createVerifyRun({ review, repo: s.repo, status: "completed", triggeredBy: { kind: "pr_event" } });
  const plan = db.insert("verifyPlans", { id: uuid(), schemaVersion: 1, runId: run.id, repoId: s.repo.id, criteriaRevision: 1, commands: [], unverifiable: [], createdAt: 0, tests: [
    { id: "t1", path: ".devasign/tests/criterion-1.test.ts", content: "import { total } from '../../src/cart.js';\n", criterionIds: ["1"], level: "unit", levelReason: "", origin: "generated", runner: "node-test", testSignature: "s", strategyVersion: 1, targetFiles: [] },
  ] });
  db.update("verifyRuns", (r) => r.id === run.id, { planId: plan.id });
  const drop = () => {
    db.remove("verifyPlans", (p) => p.id === plan.id);
    db.remove("verifyRuns", (r) => r.id === run.id);
    db.remove("reviewLogs", (l) => l.reviewId === review.id);
    db.remove("prReviews", (r) => r.id === review.id);
  };
  return { review, run, plan, drop };
}

test("adopt: a repo whose test script globs its own src is told the adopted files will not run, and what to change", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    s.contents["package.json"] = JSON.stringify({ scripts: { test: "node --experimental-strip-types --test 'src/**/*.test.ts'" } });
    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    assert.match(body, /Merging this into `feature\/refunds` commits them, but no test command in this repository selects `tests\/devasign\/`, so they will not run with the rest of the suite:/);
    assert.ok(body.includes("- `package.json` — `node --experimental-strip-types --test 'src/**/*.test.ts'`"), `the offending command is named verbatim:\n${body}`);
    assert.match(body, /Add `tests\/devasign\/\*\*` to one of those commands' paths\. Their relative imports are anchored 2 directories deep, so a different destination would have to sit at the same depth\./);
    assert.ok(!/move these files/.test(body), "moving them off tests/devasign/ would break the ../ counts they were committed with");
    assert.ok(!body.includes("keeps them as part of the repository's own suite"), "and the false claim is gone");
    assert.ok(s.calls.reads.some((r) => r === `package.json@${a.run.sha}`), "the claim is read off the repo at the reviewed sha, not assumed");
    assert.deepEqual(Object.keys(s.calls.files), ["tests/devasign/criterion-1.test.ts"], "the file is still committed");
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: a repo whose own test command already reaches tests/devasign still gets the plain suite claim", async () => {
  for (const script of ["vitest run", "jest --ci", "node --import tsx/esm --test 'src/**/*.test.ts' 'tests/**/*.test.ts'"]) {
    const s = seed();
    const a = seedAdoptRun(s);
    try {
      s.contents["package.json"] = JSON.stringify({ scripts: { test: script } });
      assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
      const body: string = s.calls.prs[0].body;
      assert.match(body, /Merging this into `feature\/refunds` keeps them as part of the repository's own suite\./, `${script} covers the destination`);
      assert.ok(!body.includes("will not run with the rest of the suite"), `${script} must not be warned about`);
    } finally {
      a.drop();
      s.cleanup();
    }
  }
});

test("adopt: in a repo with no root manifest, every package's own suite is named — none of them can see a root-level file", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    delete s.contents["package.json"];
    s.contents["frontend/package.json"] = JSON.stringify({ scripts: { test: "node --experimental-strip-types --test 'src/**/*.test.ts'" } });
    s.contents["backend/package.json"] = JSON.stringify({ scripts: { test: "vitest run" } });
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { detected: { languages: ["ts"], frameworks: [], packages: ["backend", "frontend"], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } } as any });

    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    assert.match(body, /no test command in this repository selects `tests\/devasign\/`/);
    assert.ok(body.includes("- `backend/package.json` — `vitest run`"), `a package that would cover its own tree still cannot reach the repo root:\n${body}`);
    assert.ok(body.includes("- `frontend/package.json` — `node --experimental-strip-types --test 'src/**/*.test.ts'`"), body);
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: a root command that does run the adopted files is not called out for a package command that cannot see them", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    s.contents["package.json"] = JSON.stringify({ workspaces: ["packages/*"], scripts: { test: "jest" } });
    s.contents["packages/ui/package.json"] = JSON.stringify({ scripts: { test: "jest" } });
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { detected: { languages: ["ts"], frameworks: [], packages: ["packages/ui"], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } } as any });

    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    // Bare `jest` at the root selects tests/devasign/ with its default testMatch; whether
    // packages/ui's own run does is not a second opinion about a file it never sees.
    assert.match(body, /keeps them as part of the repository's own suite\./);
    assert.ok(!body.includes("no test command in this repository selects"), `one command running them is enough:\n${body}`);
    assert.ok(!body.includes("- `package.json` — `jest`"), "and the command that does run them is not named as one that does not");
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: a single package with no root manifest still cannot reach a root-level file", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    delete s.contents["package.json"];
    s.contents["backend/package.json"] = JSON.stringify({ scripts: { test: "vitest run" } });
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { detected: { languages: ["ts"], frameworks: [], packages: ["backend"], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } } as any });

    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    // The only verdict in play: `vitest run` would cover its own tree, so this says nothing
    // unless a command that runs from backend/ is read as blind to a file outside it.
    assert.match(body, /no test command in this repository selects `tests\/devasign\/`/);
    assert.ok(body.includes("- `backend/package.json` — `vitest run`"), body);
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: a config the command names by path is read as a config, not as an absent one", async () => {
  for (const [script, config] of [
    ["jest --config config/jest.json", "config/jest.json"],
    ["vitest run --config vitest.ci.mts", "vitest.ci.mts"],
    ["jest --config=config/jest.json", "config/jest.json"],
  ] as const) {
    const s = seed();
    const a = seedAdoptRun(s);
    try {
      s.contents["package.json"] = JSON.stringify({ scripts: { test: script } });
      s.contents[config] = "export default { roots: ['<rootDir>/src'] };\n";
      assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
      const body: string = s.calls.prs[0].body;
      assert.ok(!body.includes("keeps them as part of the repository's own suite"), `${script} runs a config this cannot read:\n${body}`);
      assert.match(body, /If this repository's test command selects files by path, add that directory/, script);
    } finally {
      a.drop();
      s.cleanup();
    }
  }
});

test("adopt: a framework config under any of its names stops the suite claim, however it scopes the run", async () => {
  for (const [file, text] of [
    ["jest.config.mts", "export default { roots: ['<rootDir>/src'] };\n"],
    ["jest.config.json", '{ "roots": ["<rootDir>/src"] }'],
    ["vitest.config.mjs", "export default { test: { dir: 'src' } };\n"],
    ["vitest.workspace.ts", "export default ['packages/*'];\n"],
  ] as const) {
    const s = seed();
    const a = seedAdoptRun(s);
    try {
      s.contents["package.json"] = JSON.stringify({ scripts: { test: file.startsWith("jest") ? "jest" : "vitest run" } });
      s.contents[file] = text;
      assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
      assert.ok(!s.calls.prs[0].body.includes("keeps them as part of the repository's own suite"), `${file}:\n${s.calls.prs[0].body}`);
    } finally {
      a.drop();
      s.cleanup();
    }
  }
});

test("adopt: a package.json `jest` key is a config too, whatever shape it has", async () => {
  for (const jest of ["./config/jest.js", { preset: "ts-jest" }] as const) {
    const s = seed();
    const a = seedAdoptRun(s);
    try {
      s.contents["package.json"] = JSON.stringify({ scripts: { test: "jest" }, jest });
      assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
      assert.ok(!s.calls.prs[0].body.includes("keeps them as part of the repository's own suite"), s.calls.prs[0].body);
    } finally {
      a.drop();
      s.cleanup();
    }
  }
});

test("adopt: a vitest config that narrows include is hedged rather than counted as a default that covers everything", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    s.contents["package.json"] = JSON.stringify({ scripts: { test: "vitest run" } });
    s.contents["vitest.config.ts"] = "export default { test: { include: ['src/**/*.test.ts'] } };\n";
    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    assert.ok(!body.includes("keeps them as part of the repository's own suite"), `a narrowed include is not vitest's default:\n${body}`);
    assert.match(body, /If this repository's test command selects files by path, add that directory/);
    assert.ok(s.calls.reads.some((r) => r === `vitest.config.ts@${a.run.sha}`), "and the config really was read");
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: a repo whose test command cannot be read is hedged, never claimed either way", async () => {
  const s = seed();
  const a = seedAdoptRun(s);
  try {
    s.contents["package.json"] = JSON.stringify({ scripts: { test: "make check" } });
    assert.equal((await adoptGeneratedTests(a.run.id, null, s.deps)).status, "opened");
    const body: string = s.calls.prs[0].body;
    assert.match(body, /commits them under `tests\/devasign\/`\. If this repository's test command selects files by path, add that directory so they run with the rest of the suite\./);
    assert.ok(!body.includes("keeps them as part of the repository's own suite"), "an unreadable command is not evidence for the claim");
  } finally {
    a.drop();
    s.cleanup();
  }
});

test("adopt: the traversal gate still refuses a generated path that would escape the adopt directory", () => {
  assert.equal(adoptedPath(".devasign/tests/../../.github/workflows/ci.yml"), null);
  assert.equal(adoptedPath("/etc/passwd"), null);
  assert.equal(adoptedPath(".devasign/tests/./e2e/x.spec.ts"), null);
  assert.equal(adoptedPath(".devasign/tests/e2e/x.spec.ts"), "tests/devasign/e2e/x.spec.ts");
});

test("scriptSelects reads a test script's own paths: a src-only glob excludes the adopt directory, a tests glob includes it", () => {
  const dest = "tests/devasign/criterion-1.test.ts";
  assert.equal(scriptSelects("node --experimental-strip-types --test 'src/**/*.test.ts'", dest), false);
  assert.equal(scriptSelects("DATABASE_URL= node --import tsx/esm --test 'src/**/*.test.ts'", dest), false, "a leading env assignment is not a path");
  assert.equal(scriptSelects("node --import tsx/esm --test 'tests/**/*.test.ts'", dest), true);
  assert.equal(scriptSelects("node --import tsx/esm --test '**/*.test.ts'", dest), true);
  assert.equal(scriptSelects("vitest run", dest), true, "vitest's default include covers any *.test.ts");
  assert.equal(scriptSelects("vitest run src/", dest), false, "a vitest filter is a substring of the path");
  assert.equal(scriptSelects("npm run test:unit", dest, { "test:unit": "vitest run" }), true, "a script that delegates is followed one hop");
  assert.equal(scriptSelects("make check", dest), null);
  // ADOPT_DIR's own depth is what the committed imports were re-anchored for.
  assert.equal(scriptSelects("node --test 'tests/devasign/**/*.test.ts'", dest), true);
  // A named project or shard is part of the suite, not its default include.
  assert.equal(scriptSelects("vitest run --project ui", dest), null);
  assert.equal(scriptSelects("jest --shard=1/3", dest), null);
  assert.equal(scriptSelects("vitest run --reporter=dot", dest), true, "a flag that is not about selection still leaves the default include");
});

// A jest positional is a regex, and it comes out of the PR head's package.json: compiling it
// here handed a contributor the backend's event loop.
test("scriptSelects never compiles a pattern the repository wrote", () => {
  const dest = "tests/devasign/criterion-1.test.ts";
  const started = Date.now();
  assert.equal(scriptSelects("jest '((.*)*)*Z'", dest), null, "unreadable, not a guess");
  assert.equal(scriptSelects("jest '(a+)+$'", dest), null);
  assert.ok(Date.now() - started < 1000, "and it answered without backtracking");
  assert.equal(scriptSelects("jest tests/devasign", dest), true, "a plain fragment is still a substring match");
  assert.equal(scriptSelects("jest src", dest), false);
  assert.equal(scriptSelects("jest src/foo.test.ts tests/devasign", dest), true, "one arg matching is enough");
  const globs = Date.now();
  assert.equal(scriptSelects(`node --test '${"**".repeat(30)}Z'`, dest), null, "and an unbounded glob is declined the same way");
  assert.ok(Date.now() - globs < 1000);
});

test("a manual regenerate reaches a repo that already merged its setup PR — the only path that can update one", async () => {
  const s = seed();
  try {
    const onboarded = { ...s.deps, tree: async () => [WORKFLOW_PATH, "package.json"].map((path) => ({ path, type: "blob" as const, sha: "s", size: 1 })) };
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "pr_merged" } } });

    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, onboarded);
    assert.equal(out.status, "opened", "regenerate must not be a silent no-op");
    assert.ok(s.calls.files[WORKFLOW_PATH], "the workflow is rewritten at the current generator version");
    const ob = repoRow(s.repo.id).verify!.onboarding;
    assert.equal(ob.state, "pr_merged", "a follow-up PR does not un-merge the workflow that is already live");
    assert.equal(ob.setupPrOpen, true);
    assert.equal(ob.workflowPath, WORKFLOW_PATH, "where our step lives is now persisted");
    assert.equal(ob.workflowVersion, WORKFLOW_VERSION, "so a stale copy is detectable later");

    noteOnboardingPrClosed(s.repo.id, out.prNumber!, false, onboarded);
    const closed = repoRow(s.repo.id).verify!.onboarding;
    assert.equal(closed.state, "pr_merged", "closing that PR unmerged leaves the repo set up");
    assert.equal(closed.setupPrOpen, false);

    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "verified", firstSuccessfulRunId: "run-1" } } });
    await runVerifyOnboard(s.repo.id, { trigger: "manual" }, onboarded);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.state, "verified", "a verified repo is never demoted by opening a setup PR");
  } finally {
    s.cleanup();
  }
});

test("an open setup PR is updated in place: caught up with the base, read at the branch, and never reset", async () => {
  const s = seed();
  try {
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "the body of the first version" };
    // What the maintainer fixed on the setup branch after we opened the PR.
    s.calls.files[DEVASIGN_YML_PATH] = "family: shop\nverify:\n  e2e: auto\n  start: npm run dev -- --port 4000\n  url: http://localhost:4000\n  ready: /\n";
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps);
    assert.equal(out.status, "opened");
    assert.equal(out.prNumber, 41, "the existing PR is reused");
    assert.equal(s.calls.prs.length, 0, "no second PR is attempted for the same branch");
    assert.deepEqual(s.calls.branches, [], "the branch is never reset out from under the maintainer");
    assert.deepEqual(s.calls.caughtUp, [41], "it is brought up to date with the base before anything is read");
    assert.ok(s.calls.reads.includes(`${DEVASIGN_YML_PATH}@${ONBOARDING_BRANCH}`), "the yml is read at the branch, not at the default head");
    assert.ok(s.calls.reads.includes(`${WORKFLOW_PATH}@${ONBOARDING_BRANCH}`));
    const yml = parse(s.calls.files[DEVASIGN_YML_PATH]);
    assert.equal(yml.verify.url, "http://localhost:4000", "the port they fixed survives the regenerate");
    assert.equal(yml.family, "shop", "and so does the rest of their file");
    assert.deepEqual(s.calls.updated, [41], "the body stops describing the first version forever");
    assert.match(s.calls.bodies[0], /What this PR adds/);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.setupPrOpen, true);
  } finally {
    s.cleanup();
  }
});

test("a setup branch GitHub has not finished catching up is left untouched", async () => {
  const s = seed();
  try {
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "" };
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, { ...s.deps, behindBy: async () => 3 });
    assert.equal(out.status, "failed");
    assert.deepEqual(s.calls.puts, [], "writing against a stale branch would revert the base it is behind");
    assert.deepEqual(s.calls.updated, []);
    assert.match(repoRow(s.repo.id).verify!.onboarding.lastError!, /still behind main/);
  } finally {
    s.cleanup();
  }
});

test("a branch read that fails is not an empty file: nothing is written and the error is recorded", async () => {
  const s = seed();
  try {
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "" };
    const theirs = "family: shop\nverify:\n  e2e: auto\n  start: npm run dev -- --port 4000\n  url: http://localhost:4000\n";
    s.calls.files[DEVASIGN_YML_PATH] = theirs;
    // A 403 secondary-rate-limit or a 500 reads exactly like "the file is not there" to a
    // reader that swallows — and then the generated defaults overwrite what they fixed.
    const flaky: OnboardDeps = {
      ...s.deps,
      read: async (i, r, path, ref) => {
        if (ref === ONBOARDING_BRANCH) throw new Error("GitHub 403: You have exceeded a secondary rate limit");
        return s.deps.read!(i, r, path, ref);
      },
    };
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, flaky);
    assert.equal(out.status, "failed");
    assert.deepEqual(s.calls.puts, [], "a read we could not make is never a reason to rewrite the branch");
    assert.equal(s.calls.files[DEVASIGN_YML_PATH], theirs, "their port fix and their family key survive");
    assert.match(repoRow(s.repo.id).verify!.onboarding.lastError!, /secondary rate limit/);
  } finally {
    s.cleanup();
  }
});

test("a compare that does not say how far behind the branch is counts as not caught up", async () => {
  const s = seed();
  try {
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "" };
    // 0 is the value that means "safe to write"; an unrecognised payload must not become one.
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, { ...s.deps, behindBy: async () => null });
    assert.equal(out.status, "failed");
    assert.deepEqual(s.calls.puts, []);
    assert.match(repoRow(s.repo.id).verify!.onboarding.lastError!, /still behind main/);
  } finally {
    s.cleanup();
  }
});

test("a setup branch whose PR was closed unmerged is never force-pushed over", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    noteOnboardingPrClosed(s.repo.id, 41, false, s.deps);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.state, "pr_closed");

    // They closed the PR meaning to fix it up, and kept working on the branch.
    const theirs = "verify:\n  e2e: auto\n  start: npm run dev -- --port 4000\n  url: http://localhost:4000\n  ready: /\n";
    const onBranch: Record<string, string> = { ...s.calls.files, [DEVASIGN_YML_PATH]: theirs };
    const withBranch: OnboardDeps = {
      ...s.deps,
      branchTip: async () => "their-commit",
      read: async (_i, _r, path, ref) => {
        s.calls.reads.push(`${path}@${ref}`);
        return ref === ONBOARDING_BRANCH ? onBranch[path] ?? null : s.contents[path] ?? null;
      },
    };
    s.calls.branches.length = 0;
    s.calls.puts.length = 0;
    const out = await runVerifyOnboard(s.repo.id, { trigger: "install" }, withBranch);
    assert.deepEqual(s.calls.branches, [], "their commits are on that branch — resetting it destroys them");
    assert.ok(!s.calls.puts.includes(DEVASIGN_YML_PATH), "and their boot config is read at the branch, not replaced with ours");
    assert.equal(out.status, "skipped");

    // Behind the base with no PR, there is no update-branch to run: writing would
    // propose reverting whatever moved on since.
    const behind = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, { ...withBranch, behindBy: async () => 4 });
    assert.equal(behind.status, "failed");
    assert.match(behind.reason!, /has unmerged commits and is behind main/);
    assert.deepEqual(s.calls.branches, []);
  } finally {
    s.cleanup();
  }
});

test("a workflow path that is not in the tree is refused, not silently redirected at another file", async () => {
  const s = seed();
  try {
    const out = await runVerifyOnboard(s.repo.id, { trigger: "manual", mode: "extend", workflow: ".github/workflows/typo.yml" }, s.deps);
    assert.equal(out.status, "failed");
    assert.match(out.reason!, /typo\.yml is not a workflow in main/);
    assert.deepEqual(s.calls.puts, [], "editing whatever sorts first could be deploy.yml");
    assert.match(repoRow(s.repo.id).verify!.onboarding.lastError!, /not a workflow/);
  } finally {
    s.cleanup();
  }
});

test("regenerating an open setup PR commits only what actually differs", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    assert.deepEqual(s.calls.branches, [ONBOARDING_BRANCH], "with no PR open yet, resetting the branch is safe");
    assert.deepEqual(s.calls.puts.sort(), [DEVASIGN_YML_PATH, WORKFLOW_PATH]);
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: s.calls.prs[0].body };
    s.calls.puts.length = 0;

    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps)).status, "opened");
    assert.deepEqual(s.calls.puts, [], "the branch already says exactly this");
    assert.deepEqual(s.calls.updated, [], "and so does the body");
  } finally {
    s.cleanup();
  }
});

test("extend mode: an open setup PR whose branch already runs the action gets no second workflow", async () => {
  const s = seed();
  try {
    const extend = { trigger: "manual" as const, mode: "extend" as const, workflow: ".github/workflows/ci.yml" };
    await runVerifyOnboard(s.repo.id, extend, s.deps);
    assert.ok(s.calls.files[".github/workflows/ci.yml"].includes(ACTION_REF));
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "" };
    s.calls.puts.length = 0;

    assert.equal((await runVerifyOnboard(s.repo.id, extend, s.deps)).status, "opened");
    assert.ok(!s.calls.puts.includes(WORKFLOW_PATH), "a separate workflow beside their job would verify every PR twice");
    assert.ok(!s.calls.puts.includes(".github/workflows/ci.yml"), "and their job is not given a second verify step");
    assert.equal(repoRow(s.repo.id).verify!.onboarding.workflowPath, ".github/workflows/ci.yml");
  } finally {
    s.cleanup();
  }
});

test("a separate-mode regenerate adds no workflow when the repo's own CI already runs the action", async () => {
  const s = seed();
  try {
    s.calls.files[".github/workflows/ci.yml"] = `name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${ACTION_REF}\n`;
    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps)).status, "opened");
    assert.ok(!s.calls.puts.includes(WORKFLOW_PATH), "their CI already runs us");
    const ob = repoRow(s.repo.id).verify!.onboarding;
    assert.equal(ob.mode, "extend");
    assert.equal(ob.workflowPath, ".github/workflows/ci.yml", "which is where the doctor follow-up must patch");
  } finally {
    s.cleanup();
  }
});

test("a .devasign.yml that does not parse is left alone and recorded as the setup's last error", async () => {
  const s = seed();
  try {
    s.calls.openPr = { number: 41, html_url: "https://github.com/acme/shop/pull/41", body: "" };
    const broken = "verify:\n  start: 'unterminated\n";
    s.calls.files[DEVASIGN_YML_PATH] = broken;
    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "manual" }, s.deps)).status, "opened");
    assert.equal(s.calls.files[DEVASIGN_YML_PATH], broken, "overwriting it would throw away whatever they were editing");
    assert.ok(!s.calls.puts.includes(DEVASIGN_YML_PATH));
    assert.match(repoRow(s.repo.id).verify!.onboarding.lastError!, /left unchanged/);
  } finally {
    s.cleanup();
  }
});

test("the generated workflow carries a version marker so a stale copy can be spotted", () => {
  const wf = generateWorkflow({ languages: ["ts"], frameworks: [], testCommands: [], services: [], envExampleVars: [], packageManager: "npm" } as any, { node: true, nodeVersion: "20" } as any, [], ["package.json"]);
  assert.match(wf, new RegExp(`# devasign-workflow: v${WORKFLOW_VERSION}`));
});

test("a clean run clears a stale diagnosis on an already-verified repo without re-stamping it", () => {
  const s = seed();
  try {
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "verified", firstSuccessfulRunId: "first-run", lastDiagnosis: diagnosis } } });
    noteRunSucceeded({ id: "later-run", repoId: s.repo.id } as any);
    const ob = repoRow(s.repo.id).verify!.onboarding;
    assert.equal(ob.lastDiagnosis, null, "a later clean run means the diagnosis no longer applies");
    assert.equal(ob.state, "verified");
    assert.equal(ob.firstSuccessfulRunId, "first-run");

    const before = repoRow(s.repo.id);
    noteRunSucceeded({ id: "another-run", repoId: s.repo.id } as any);
    assert.equal(repoRow(s.repo.id), before, "nothing to clear: the row is not rewritten");
  } finally {
    s.cleanup();
  }
});

test("setOnboarding patches the live row: a devasignYml, lastBrowserless or detected written mid-job survives", async () => {
  const s = seed();
  try {
    const devasignYml = { raw: "verify:\n  e2e: auto\n", parsed: { e2e: "auto" as const }, sha: "planned" };
    const lastBrowserless = { count: 2, reason: "not_configured" as const, runId: "r", prNumber: 5, at: 1 };
    const detected = { languages: ["go"], frameworks: [], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] };
    const deps: OnboardDeps = {
      ...s.deps,
      createPr: async (i, r, args) => {
        const cur = repoRow(s.repo.id).verify!;
        db.update("repositories", (x) => x.id === s.repo.id, { verify: { ...cur, devasignYml, lastBrowserless, detected } });
        return s.deps.createPr!(i, r, args);
      },
    };
    assert.equal((await runVerifyOnboard(s.repo.id, { trigger: "install" }, deps)).status, "opened");
    const v = repoRow(s.repo.id).verify!;
    assert.equal(v.onboarding.state, "pr_open");
    assert.deepEqual(v.devasignYml, devasignYml);
    assert.deepEqual(v.lastBrowserless, lastBrowserless);
    assert.deepEqual(v.detected, detected, "the runner's own report beats the tree inference");
  } finally {
    s.cleanup();
  }
});

test("extend mode: the doctor follow-up reads and patches the customer's workflow, not devasign-verify.yml", async () => {
  const s = seed();
  try {
    const reads: string[] = [];
    const deps: OnboardDeps = { ...s.deps, read: async (i, r, path, ref) => { reads.push(`${path}@${ref}`); return s.deps.read!(i, r, path, ref); } };
    await runVerifyOnboard(s.repo.id, { trigger: "manual", mode: "extend", workflow: ".github/workflows/ci.yml" }, deps);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.workflowPath, ".github/workflows/ci.yml");
    const run = { id: "run-x", repoId: s.repo.id, prNumber: 9 } as any;
    const out = await postDoctorFollowup(run, { stage: "install", code: "missing_dependencies", message: "m", packages: [{ dir: "backend", install: "npm ci --prefix backend" }] }, deps);
    assert.deepEqual(out, { commented: true, patched: true });
    assert.ok(reads.includes(`.github/workflows/ci.yml@${ONBOARDING_BRANCH}`));
    assert.ok(!reads.includes(`${WORKFLOW_PATH}@${ONBOARDING_BRANCH}`), "the separate-mode path is never consulted");
    assert.equal(s.calls.files[WORKFLOW_PATH], undefined, "no stray devasign-verify.yml is committed");
    const steps = parse(s.calls.files[".github/workflows/ci.yml"]).jobs.test.steps.map((x: any) => x.uses || x.run);
    assert.deepEqual(steps.slice(-2), ["npm ci --prefix backend", ACTION_REF]);

    // Their CI file, as it stands on the setup branch, with a Node pin in an unrelated job first.
    s.calls.files[".github/workflows/ci.yml"] = "jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: actions/setup-node@v4\n      with:\n        node-version: 18\n  test:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: actions/setup-node@v4\n      with:\n        node-version: ${{ matrix.node }}\n    - name: DevAsign verify\n      uses: " + ACTION_REF + "\n";
    const before = s.calls.files[".github/workflows/ci.yml"];
    const runtime = await postDoctorFollowup(run, { stage: "install", code: "wrong_runtime_version", message: "the repository wants Node >=22 but the runner has v20.1.0" }, deps);
    assert.deepEqual(runtime, { commented: true, patched: false }, "neither the lint job's pin nor the verify job's matrix is ours to rewrite");
    assert.equal(s.calls.files[".github/workflows/ci.yml"], before);
    assert.deepEqual(await postDoctorFollowup(run, { stage: "browsers", code: "browser_install_failed", message: "no chromium" }, deps), { commented: true, patched: true }, "the file parses, so a fix scoped to the verify job still lands");
    assert.equal(parse(s.calls.files[".github/workflows/ci.yml"]).jobs.lint.steps.length, 1);
  } finally {
    s.cleanup();
  }
});

test("the doctor comment renders runner-reported text inert", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    const run = { id: "run-y", repoId: s.repo.id, prNumber: 9 } as any;
    const message = "boom**\n\n[click me](https://evil.example) @acme/admins <img src=x onerror=alert(1)> `code`";
    await postDoctorFollowup(run, { stage: "start", code: "unknown", message, suggestedFix: { kind: "manual", instructions: "![pixel](https://evil.example/p.png) ping @octocat" } }, s.deps);
    const body = s.calls.comments[0];
    assert.doesNotMatch(body, /\[click me\]\(https/, "no live link");
    assert.doesNotMatch(body, /!\[pixel\]\(/, "no image");
    assert.doesNotMatch(body, /<img/, "no raw HTML");
    assert.doesNotMatch(body, /@acme\/admins|@octocat/, "no mention pings anyone");
    assert.match(body, /\*\*boom\\\*\\\* \\\[click me\\\]/, "the message stays on one bold line with its markup escaped");
    assert.match(body, /&lt;img src=x/);

    // A stored diagnosis from before the normalizer can still carry a fence of its own.
    await postDoctorFollowup(run, { stage: "start", code: "unknown", message: "m", suggestedFix: { kind: "yml_patch", instructions: "i", patch: "verify:\n```\n[x](https://evil.example)\n````" } }, s.deps);
    assert.match(s.calls.comments[1], /\n`````yaml\nverify:\n```\n\[x\]\(https:\/\/evil\.example\)\n````\n`````\n/, "the fence outlasts every backtick run in the patch");
  } finally {
    s.cleanup();
  }
});

test("a merged setup PR force-refreshes the default-branch yml snapshot; a closed one does not", async () => {
  const s = seed();
  try {
    await runVerifyOnboard(s.repo.id, { trigger: "install" }, s.deps);
    const stale = { sha: "before-merge", parsed: null, bootHash: null, at: Date.now() };
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { ...repoRow(s.repo.id).verify!, defaultYml: stale } });
    const deps: OnboardDeps = { ...s.deps, branchSha: async () => "merge-sha" };

    noteOnboardingPrClosed(s.repo.id, 41, false, deps);
    await settle();
    assert.deepEqual(repoRow(s.repo.id).verify!.defaultYml, stale, "closing without merging changes nothing on the default branch");

    noteOnboardingPrClosed(s.repo.id, 41, true, deps);
    await settle();
    const snap = repoRow(s.repo.id).verify!.defaultYml!;
    assert.equal(snap.sha, "merge-sha", "refreshed even inside the throttle window");
    assert.equal(snap.parsed?.url, "http://localhost:5173", "read from the merged .devasign.yml");
    assert.ok(snap.bootHash);
    assert.equal(repoRow(s.repo.id).verify!.onboarding.state, "pr_merged");
  } finally {
    s.cleanup();
  }
});
