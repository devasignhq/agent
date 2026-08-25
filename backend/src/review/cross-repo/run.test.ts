// Orchestration wiring for the cross-repo stage. In-memory db, mock LLM, no
// network (no topology → no code search, unindexed siblings → no blob fetch). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import { CROSS_REPO_NO_SIBLINGS, CROSS_REPO_NO_SURFACE, runCrossRepoStage } from "./run.js";
import { parityFeatureFor, recordParityFeatures } from "./parity.js";
import type { Installation, PRReview, Repository } from "../../types.js";

const SURFACE_DIFF =
  "diff --git a/src/payouts.ts b/src/payouts.ts\n" +
  "--- a/src/payouts.ts\n+++ b/src/payouts.ts\n@@ -1,2 +1,3 @@\n" +
  "+export function listPayouts() {}\n";

function seed(opts: { sibling?: boolean } = {}) {
  const userId = uuid();
  db.insert("users", { id: userId, githubId: 1, login: "u", kind: "maintainer" } as any);
  const install: Installation = {
    id: uuid(),
    userId,
    userIds: [userId],
    accountId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    installationId: 4242,
    repoIds: [],
  };
  db.insert("installations", install);
  const mk = (name: string): Repository =>
    db.insert("repositories", {
      id: uuid(),
      installationId: install.id,
      owner: "acme",
      name,
      defaultBranch: "main",
      private: false,
      defaultModel: "claude-opus-4-7",
      modelOverrides: {},
      reviewsEnabled: true,
      indexState: "none",
    } as any);
  const repo = mk(`sdk-ts-${uuid().slice(0, 6)}`);
  if (opts.sibling !== false) mk(`sdk-go-${uuid().slice(0, 6)}`);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Add listPayouts",
    headSha: "cafe123",
    baseSha: "def5678",
    status: "reviewing",
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: 1,
    updatedAt: 1,
  } as any) as unknown as PRReview;
  return { install, repo, review, userId };
}

function run(args: { install: Installation; repo: Repository; review: PRReview; diff: string }) {
  const logs: string[] = [];
  return runCrossRepoStage({
    ...args,
    log: (action) => void logs.push(action),
  }).then((result) => ({ result, logs }));
}

test("a diff with no external surface exits before any LLM call", async () => {
  const { install, repo, review } = seed();
  const { result, logs } = await run({
    install,
    repo,
    review,
    diff: "diff --git a/src/u.ts b/src/u.ts\n@@ -1 +1 @@\n+  const x = 1;\n",
  });
  assert.deepEqual(result.impacts, []);
  assert.ok(logs.includes(CROSS_REPO_NO_SURFACE));
});

test("a repo with no siblings exits cleanly", async () => {
  const { install, repo, review } = seed({ sibling: false });
  const { logs } = await run({ install, repo, review, diff: SURFACE_DIFF });
  assert.ok(logs.includes(CROSS_REPO_NO_SIBLINGS));
});

test("the stage CLOSES an open parity gap this PR resolves", async (t) => {
  // Regression guard: closeParityGapsFor was written and unit-tested but never
  // invoked, so a gap stayed "absent" forever even after the repo implemented it.
  const prior = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = prior;
  });

  const { install, repo, review } = seed();
  const selfFullName = `${repo.owner}/${repo.name}`;
  // A sibling previously flagged that THIS repo was missing listPayouts.
  const otherRepo = db.filter(
    "repositories",
    (r) => r.installationId === install.id && r.id !== repo.id
  )[0];
  recordParityFeatures({
    install,
    repo: otherRepo,
    review,
    features: [
      {
        slug: "list-payouts",
        title: "listPayouts missing here",
        missingIn: [selfFullName],
        searched: "listPayouts, list_payouts",
      },
    ],
    family: "acme-sdk",
  });
  const before = parityFeatureFor(install.id, "acme-sdk/list-payouts")!;
  assert.equal(before.statusByRepo[selfFullName], "absent");
  assert.equal(before.closedAt, null);

  const { logs } = await run({ install, repo, review, diff: SURFACE_DIFF });

  const after = parityFeatureFor(install.id, "acme-sdk/list-payouts")!;
  assert.equal(after.statusByRepo[selfFullName], "present");
  assert.ok(after.closedAt, "the gap should be closed once nothing is still missing");
  assert.equal(after.closedBy?.repoFullName, selfFullName);
  assert.equal(after.closedBy?.sha, "cafe123");
  assert.ok(logs.some((l) => l.includes("closed 1 parity gap")));
});

test("an unrelated open gap is left alone", async (t) => {
  const prior = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = prior;
  });

  const { install, repo, review } = seed();
  const selfFullName = `${repo.owner}/${repo.name}`;
  const otherRepo = db.filter(
    "repositories",
    (r) => r.installationId === install.id && r.id !== repo.id
  )[0];
  recordParityFeatures({
    install,
    repo: otherRepo,
    review,
    features: [
      {
        slug: "refund-escrow",
        title: "refundEscrow missing here",
        missingIn: [selfFullName],
        searched: "refundEscrow",
      },
    ],
    family: "acme-sdk",
  });

  await run({ install, repo, review, diff: SURFACE_DIFF });

  const after = parityFeatureFor(install.id, "acme-sdk/refund-escrow")!;
  assert.equal(after.statusByRepo[selfFullName], "absent");
  assert.equal(after.closedAt, null);
});
