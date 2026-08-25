// Parity store lifecycle and the notification dedupe. In-memory db only. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/cross-repo/parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import {
  closeParityGapsFor,
  openParityGaps,
  parityFeatureFor,
  recordParityFeatures,
} from "./parity.js";
import type { Installation, PRReview, Repository } from "../../types.js";

function seed() {
  const userId = uuid();
  db.insert("users", { id: userId, githubId: 1, login: "u", kind: "maintainer" } as any);
  const install: Installation = {
    id: uuid(),
    userId,
    userIds: [userId],
    accountId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    installationId: 99,
    repoIds: [],
  };
  db.insert("installations", install);
  const repo: Repository = {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: "sdk-ts",
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
  } as any;
  db.insert("repositories", repo);
  const review = {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Add listPayouts",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "passed",
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as PRReview;
  db.insert("prReviews", review);
  return { userId, install, repo, review };
}

const FEATURE = {
  slug: "list-payouts",
  title: "listPayouts has no equivalent in acme/sdk-go",
  missingIn: ["acme/sdk-go"],
  searched: "ListPayouts, list_payouts in payouts.go",
};

test("recordParityFeatures opens a gap and notifies once", () => {
  const { userId, install, repo, review } = seed();
  const out = recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  assert.equal(out.opened, 1);
  assert.equal(out.notified, 1);

  const row = parityFeatureFor(install.id, "acme-sdk/list-payouts");
  assert.ok(row);
  assert.equal(row!.statusByRepo["acme/sdk-go"], "absent");
  assert.equal(row!.evidence["acme/sdk-go"], FEATURE.searched);
  assert.deepEqual(row!.notifiedRepos, ["acme/sdk-go"]);
  assert.equal(db.filter("notifications", (n) => n.userId === userId).length, 1);
});

test("a re-review of the same PR opens nothing and notifies nobody", () => {
  const { userId, install, repo, review } = seed();
  recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  const second = recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  assert.equal(second.opened, 0);
  assert.equal(second.notified, 0);
  assert.equal(db.filter("parityFeatures", (f) => f.installationId === install.id).length, 1);
  assert.equal(db.filter("notifications", (n) => n.userId === userId).length, 1);
});

test("a second sibling on an existing feature is recorded without a new row", () => {
  const { install, repo, review } = seed();
  recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  recordParityFeatures({
    install,
    repo,
    review,
    features: [{ ...FEATURE, missingIn: ["acme/sdk-py"] }],
    family: "acme-sdk",
  });
  const row = parityFeatureFor(install.id, "acme-sdk/list-payouts")!;
  assert.equal(row.statusByRepo["acme/sdk-go"], "absent");
  assert.equal(row.statusByRepo["acme/sdk-py"], "absent");
  assert.equal(db.filter("parityFeatures", (f) => f.installationId === install.id).length, 1);
});

test("recordParityFeatures caps how many gaps one review can open", () => {
  const { install, repo, review } = seed();
  const many = Array.from({ length: 10 }, (_, i) => ({ ...FEATURE, slug: `feature-${i}` }));
  const out = recordParityFeatures({ install, repo, review, features: many, family: "acme-sdk" });
  assert.equal(out.opened, 3);
});

test("openParityGaps finds what a sibling owes", () => {
  const { install, repo, review } = seed();
  recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  assert.equal(openParityGaps(install.id, "acme/sdk-go").length, 1);
  assert.equal(openParityGaps(install.id, "acme/sdk-ts").length, 0);
});

test("a later PR on the sibling closes the gap", () => {
  const { install, repo, review } = seed();
  recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  const closed = closeParityGapsFor({
    installationId: install.id,
    repoFullName: "acme/sdk-go",
    addedNames: ["ListPayouts"], // Go spelling of the same feature
    sha: "cafe123",
    prNumber: 12,
  });
  assert.equal(closed.length, 1);
  const row = parityFeatureFor(install.id, "acme-sdk/list-payouts")!;
  assert.equal(row.statusByRepo["acme/sdk-go"], "present");
  assert.ok(row.closedAt);
  assert.equal(row.closedBy?.repoFullName, "acme/sdk-go");
  assert.equal(openParityGaps(install.id, "acme/sdk-go").length, 0);
});

test("a gap stays open while another sibling is still missing it", () => {
  const { install, repo, review } = seed();
  recordParityFeatures({
    install,
    repo,
    review,
    features: [{ ...FEATURE, missingIn: ["acme/sdk-go", "acme/sdk-py"] }],
    family: "acme-sdk",
  });
  closeParityGapsFor({
    installationId: install.id,
    repoFullName: "acme/sdk-go",
    addedNames: ["ListPayouts"],
    sha: "cafe123",
    prNumber: 12,
  });
  const row = parityFeatureFor(install.id, "acme-sdk/list-payouts")!;
  assert.equal(row.statusByRepo["acme/sdk-go"], "present");
  assert.equal(row.statusByRepo["acme/sdk-py"], "absent");
  assert.equal(row.closedAt, null);
});

test("an unrelated addition closes nothing", () => {
  const { install, repo, review } = seed();
  recordParityFeatures({ install, repo, review, features: [FEATURE], family: "acme-sdk" });
  const closed = closeParityGapsFor({
    installationId: install.id,
    repoFullName: "acme/sdk-go",
    addedNames: ["SomethingElse"],
    sha: "cafe123",
    prNumber: 12,
  });
  assert.deepEqual(closed, []);
  assert.equal(openParityGaps(install.id, "acme/sdk-go").length, 1);
});
