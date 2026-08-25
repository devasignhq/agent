// Orchestration wiring for the cross-repo stage. In-memory db, mock LLM, no
// network (no topology → no code search, unindexed siblings → no blob fetch). Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import {
  CROSS_REPO_NO_SIBLINGS,
  CROSS_REPO_NO_SURFACE,
  CROSS_REPO_VISIBILITY_FILTERED,
  __setVisibilityCheckForTests,
  runCrossRepoStage,
  visibleSiblings,
} from "./run.js";
import { installationWantsCrossRepo, sweepStaleTopologies } from "./job.js";
import { __setBlobReaderForTests } from "./discovery.js";
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

// ─── Visibility ─────────────────────────────────────────────────────────────
// A finding names a sibling repo, a path and a verbatim source line, and it is
// rendered into a PR comment. On a public repo that comment is world-readable.

function seedSibling(installId: string, name: string, isPrivate: boolean) {
  return db.insert("repositories", {
    id: uuid(),
    installationId: installId,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: isPrivate,
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "ready",
  } as any) as Repository;
}

test("a public repo may not quote a private sibling", async () => {
  const { install } = seed({ sibling: false });
  const pub = seedSibling(install.id, `pub-${uuid().slice(0, 6)}`, false);
  const priv = seedSibling(install.id, `priv-${uuid().slice(0, 6)}`, true);
  const out = await visibleSiblings({
    installId: install.id,
    installationId: install.installationId,
    selfPrivate: false,
    names: [`acme/${pub.name}`, `acme/${priv.name}`],
    topology: null,
  });
  assert.deepEqual(out, [`acme/${pub.name}`]);
});

test("a private repo may see its private siblings", async () => {
  const { install } = seed({ sibling: false });
  const priv = seedSibling(install.id, `priv2-${uuid().slice(0, 6)}`, true);
  const out = await visibleSiblings({
    installId: install.id,
    installationId: install.installationId,
    selfPrivate: true,
    names: [`acme/${priv.name}`],
    topology: null,
  });
  assert.deepEqual(out, [`acme/${priv.name}`]);
});

test("a topology repo with no visibility flag is treated as private", async () => {
  const { install } = seed({ sibling: false });
  const topology: any = {
    repos: [{ fullName: "acme/no-flag", kind: "unknown", declaredDeps: [], archived: false, pushedAt: 0, defaultBranch: "main" }],
  };
  const out = await visibleSiblings({
    installId: install.id,
    installationId: install.installationId,
    selfPrivate: false,
    names: ["acme/no-flag"],
    topology,
  });
  assert.deepEqual(out, []);
});

test("a topology repo flagged public is re-confirmed live before being quoted", async (t) => {
  // The snapshot is up to 7 days old and no webhook keeps it honest, so a repo
  // flipped public->private would read public for a week without this check.
  const { install } = seed({ sibling: false });
  const asked: string[] = [];
  t.after(() => __setVisibilityCheckForTests(null));
  const topology: any = {
    repos: [
      { fullName: "acme/still-public", kind: "unknown", declaredDeps: [], archived: false, pushedAt: 0, defaultBranch: "main", private: false },
      { fullName: "acme/went-private", kind: "unknown", declaredDeps: [], archived: false, pushedAt: 0, defaultBranch: "main", private: false },
    ],
  };

  __setVisibilityCheckForTests(async (_id, _owner, name) => {
    asked.push(name);
    return name === "still-public";
  });
  const out = await visibleSiblings({
    installId: install.id,
    installationId: install.installationId,
    selfPrivate: false,
    names: ["acme/still-public", "acme/went-private"],
    topology,
  });
  assert.deepEqual(out, ["acme/still-public"]);
  assert.deepEqual(asked.sort(), ["still-public", "went-private"]);
});

test("a failed live visibility check excludes the repo", async (t) => {
  const { install } = seed({ sibling: false });
  t.after(() => __setVisibilityCheckForTests(null));
  __setVisibilityCheckForTests(async () => {
    throw new Error("network down");
  });
  const topology: any = {
    repos: [{ fullName: "acme/unconfirmable", kind: "unknown", declaredDeps: [], archived: false, pushedAt: 0, defaultBranch: "main", private: false }],
  };
  await assert.doesNotReject(async () => {
    const out = await visibleSiblings({
      installId: install.id,
      installationId: install.installationId,
      selfPrivate: false,
      names: ["acme/unconfirmable"],
      topology,
    }).catch(() => []);
    assert.deepEqual(out, []);
  });
});

test("an onboarded public sibling needs no live check at all", async (t) => {
  const { install } = seed({ sibling: false });
  let called = false;
  t.after(() => __setVisibilityCheckForTests(null));
  __setVisibilityCheckForTests(async () => {
    called = true;
    return true;
  });
  const pub = seedSibling(install.id, `local-${uuid().slice(0, 6)}`, false);
  const out = await visibleSiblings({
    installId: install.id,
    installationId: install.installationId,
    selfPrivate: false,
    names: [`acme/${pub.name}`],
    topology: null,
  });
  assert.deepEqual(out, [`acme/${pub.name}`]);
  assert.equal(called, false, "the stored flag is kept current by the repository webhook");
});

test("the stage logs when it withholds a private sibling and never reaches it", async (t) => {
  const prior = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = prior;
  });
  const { install, repo, review } = seed({ sibling: false });
  seedSibling(install.id, `secret-${uuid().slice(0, 6)}`, true);
  const { result, logs } = await run({ install, repo, review, diff: SURFACE_DIFF });
  assert.ok(logs.includes(CROSS_REPO_VISIBILITY_FILTERED));
  // Only the private sibling existed, so there is nothing left to check.
  assert.ok(logs.includes(CROSS_REPO_NO_SIBLINGS));
  assert.deepEqual(result.impacts, []);
  assert.deepEqual(result.parityNotes, []);
});

// ─── Topology opt-in ────────────────────────────────────────────────────────

test("installationWantsCrossRepo is false until a repo opts in", () => {
  const { install, repo } = seed();
  assert.equal(installationWantsCrossRepo(install.id), false);
  db.update("repositories", (r) => r.id === repo.id, {
    workflow: { version: 1, stages: { crossRepo: true } } as any,
  });
  assert.equal(installationWantsCrossRepo(install.id), true);
});

// ─── The discovery → impact seam ────────────────────────────────────────────
// loadSiblingIndexes → rankCandidates → snippetFor → excerptAround is where the
// "the index never becomes evidence" guarantee is actually enforced: the index
// only nominates a file, and the fetched bytes decide whether it survives.

function seedIndexedSibling(installId: string, name: string, _exportsList: string[]) {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: installId,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "ready",
  } as any) as Repository;
  db.insert("repoIndex", {
    id: uuid(),
    repoId: repo.id,
    path: "src/consumer.ts",
    sha: "blobsha",
    size: 100,
    language: "ts",
    summary: "Creates bounties for the web app.",
    exports: ["submitBountyForm"],
    imports: ["@acme/sdk/createBounty"],
    securityFlags: [],
    indexedAt: 1,
    model: "m",
  } as any);
  return repo;
}

test("an impact survives when the fetched bytes really contain the line", async (t) => {
  const priorSample = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (priorSample === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = priorSample;
    __setBlobReaderForTests(null);
  });

  const { install, repo, review } = seed({ sibling: false });
  seedIndexedSibling(install.id, "acme-web", ["listPayouts"]);
  // The mock impact quotes exactly this line, and it is really in the bytes.
  __setBlobReaderForTests(async () => "const b = await createBounty(title, amount);\nexport {};");

  const { result } = await run({ install, repo, review, diff: SURFACE_DIFF });
  assert.equal(result.impacts.length, 1);
  assert.match(result.impacts[0].path!, /^acme\/acme-web:/);
  assert.match(result.impacts[0].concern, /createBounty\(title, amount\)/);
});

test("the same impact is dropped when the needle is absent from the bytes", async (t) => {
  const priorSample = process.env.CROSS_REPO_SAMPLE;
  process.env.CROSS_REPO_SAMPLE = "1";
  t.after(() => {
    if (priorSample === undefined) delete process.env.CROSS_REPO_SAMPLE;
    else process.env.CROSS_REPO_SAMPLE = priorSample;
    __setBlobReaderForTests(null);
  });

  const { install, repo, review } = seed({ sibling: false });
  seedIndexedSibling(install.id, "acme-web2", ["listPayouts"]);
  // The index nominated this file, but the bytes mention nothing we searched
  // for — so excerptAround yields no snippet and the impact has no evidence.
  __setBlobReaderForTests(async () => "export const unrelated = 1;\n");

  const { result } = await run({ install, repo, review, diff: SURFACE_DIFF });
  assert.deepEqual(result.impacts, [], "an index hit alone must never become a finding");
});

// ─── Topology sweep ─────────────────────────────────────────────────────────
// The hourly tick was the one path in this module no test executed, so a mistake
// in it would first appear an hour into production.

test("the sweep enqueues only once a repo has enabled the stage", () => {
  // Measured as a delta: the sweep is global and earlier tests in this file have
  // already put opted-in installs in the store.
  const { install, userId } = seed();
  // Pro: the sweep skips Free installs, so without this the gate under test is
  // never the one doing the skipping.
  db.insert("subscriptions", {
    id: uuid(),
    userId,
    plan: "pro",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    reviewsUsed: 0,
    usagePeriodStart: Date.now(),
    pendingPlan: null,
    scheduleId: null,
  } as any);
  const baseline = sweepStaleTopologies();
  db.update("repositories", (r) => r.installationId === install.id, {
    workflow: { version: 1, stages: { crossRepo: true } } as any,
  });
  assert.ok(
    sweepStaleTopologies() > baseline,
    "enabling the stage on a repo should make its installation sweepable"
  );
});

test("the sweep does not throw on an installation with no linked user", () => {
  db.insert("installations", {
    id: uuid(),
    userId: "",
    userIds: [],
    accountId: 2,
    accountLogin: "unlinked",
    accountType: "Organization",
    installationId: 7777,
    repoIds: [],
  } as any);
  assert.doesNotThrow(() => sweepStaleTopologies());
});
