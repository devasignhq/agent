// Offline: the onboarding job against injected GitHub deps — opens the PR with
// the right files, records state, skips when already set up, follows up on a
// doctor diagnosis, and opens adopt-test PRs.
//   DATABASE_URL= node --import tsx/esm --test src/verify/onboarding/job.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { parse } from "yaml";
import { db } from "../../db.js";
import { adoptedPath, adoptGeneratedTests, noteOnboardingPrClosed, noteRunSucceeded, postDoctorFollowup, runVerifyOnboard, type OnboardDeps } from "./job.js";
import { createVerifyRun, snapshotCriteriaRevision } from "../runs.js";
import { ACTION_REF, DEVASIGN_YML_PATH, ONBOARDING_BRANCH, WORKFLOW_PATH } from "./generate.js";

function seed(over: { userId?: string } = {}) {
  const installId = uuid();
  const userId = over.userId ?? uuid();
  db.insert("users", { id: userId, githubId: 1, githubLogin: "owner", email: "o@x", plan: "pro", createdAt: 0 } as any);
  db.insert("installations", { id: installId, userId, accountId: 1, accountLogin: "acme", installationId: 9, repoIds: [] } as any);
  const repo = db.insert("repositories", { id: uuid(), installationId: installId, owner: "acme", name: "shop", defaultBranch: "main", private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true } as any);
  const calls = { branches: [] as string[], files: {} as Record<string, string>, prs: [] as any[], comments: [] as string[] };
  const tree = ["package.json", "package-lock.json", "src/app.ts", "src/app.test.ts", ".env.example", ".github/workflows/ci.yml"];
  const contents: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest run" }, dependencies: { vite: "5" }, devDependencies: { vitest: "2" } }),
    ".env.example": "API_KEY=\nDATABASE_URL=\n",
    ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n",
  };
  const deps: OnboardDeps = {
    branchSha: async () => "headsha",
    tree: async () => tree.map((path) => ({ path, type: "blob", sha: "s", size: 1 })),
    read: async (_i, _r, path) => calls.files[path] ?? contents[path] ?? null,
    ensureBranch: async (_i, _r, branch) => { calls.branches.push(branch); },
    putFile: async (_i, _r, _b, path, content) => { calls.files[path] = content; },
    createPr: async (_i, _r, args) => { calls.prs.push(args); return { number: 40 + calls.prs.length, html_url: `https://github.com/acme/shop/pull/${40 + calls.prs.length}` }; },
    secretNames: async () => ["API_KEY"],
    postComment: async (_i, _r, _n, body) => { calls.comments.push(body); return 1; },
    prHeadRef: async () => "feature/refunds",
  };
  const cleanup = () => {
    db.remove("notifications", (n) => n.userId === userId);
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
    db.remove("users", (u) => u.id === userId);
  };
  return { repo, installId, userId, deps, calls, cleanup };
}

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
    assert.ok(repo.verify?.detected?.frameworks.some((f) => f.name === "vitest"));
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
    noteOnboardingPrClosed(s.repo.id, 41, false);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_closed");
    noteOnboardingPrClosed(s.repo.id, 41, true);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_merged");
    noteOnboardingPrClosed(s.repo.id, 999, true);
    assert.equal(db.find("repositories", (r) => r.id === s.repo.id)?.verify?.onboarding.state, "pr_merged", "another PR closing is ignored");

    // Already set up on main: skip and mark merged.
    const already = { ...s.deps, tree: async () => [{ path: WORKFLOW_PATH, type: "blob", sha: "s", size: 1 }, { path: "package.json", type: "blob", sha: "s", size: 1 }] };
    db.update("repositories", (r) => r.id === s.repo.id, { verify: { onboarding: { state: "none" } } });
    const skip = await runVerifyOnboard(s.repo.id, { trigger: "manual" }, already);
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
