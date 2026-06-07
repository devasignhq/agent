// Offline test for the workflow_run → finalize-job routing. Exercises the real
// handleWebhook dispatch against the in-memory db + queue (no network, no gh).
// Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/github/webhooks-ci.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { handleWebhook } from "./webhooks.js";
import { queueSnapshot } from "../queue.js";
import type { TestRun } from "../types.js";

// Skip HMAC verification so unsigned synthetic payloads dispatch (verifySignature
// returns true when no webhookSecret is set). Otherwise a .env-provided secret
// would 401 every payload — making the negative cases pass for the wrong reason.
config.github.webhookSecret = "";

function fakeRes(): any {
  const res: any = {};
  res.status = () => res;
  res.json = () => res;
  res.send = () => res;
  return res;
}

// Drive a workflow_run webhook through the real receiver (signature check is
// skipped when no webhookSecret is configured, which is the case in tests).
function postWorkflowRun(event: any) {
  const raw = Buffer.from(JSON.stringify(event));
  const req: any = {
    header: (h: string) => (h === "X-GitHub-Event" ? "workflow_run" : undefined),
    body: raw,
  };
  handleWebhook(req, fakeRes());
}

function wfEvent(over: {
  action?: string;
  repoFullName: string;
  headSha: string;
  runId: number;
  name?: string;
}) {
  const name = over.name ?? "CI";
  return {
    action: over.action ?? "completed",
    repository: { full_name: over.repoFullName },
    workflow_run: {
      id: over.runId,
      name,
      path: `.github/workflows/${name.toLowerCase()}.yml`,
      head_sha: over.headSha,
      status: "completed",
      conclusion: "failure",
    },
  };
}

function seedReview(opts: { owner: string; name: string; headSha: string; testWorkflow?: string | null; state?: TestRun["state"] }) {
  const repoId = uuid();
  db.insert("repositories", {
    id: repoId,
    installationId: uuid(),
    owner: opts.owner,
    name: opts.name,
    defaultBranch: "main",
    private: false,
    defaultModel: "m",
    modelOverrides: {},
    reviewsEnabled: true,
    testsEnabled: true,
    testWorkflow: opts.testWorkflow ?? null,
  } as any);
  const reviewId = uuid();
  db.insert("prReviews", {
    id: reviewId,
    repoId,
    prNumber: 7,
    prTitle: "x",
    headSha: opts.headSha,
    baseSha: "base",
    status: "testing",
    verdict: "ok",
    criteria: [{ id: "c1", text: "t", met: true, evidence: "e" }],
    taskId: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    testRun: { state: opts.state ?? "pending", startedAt: Date.now() },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
  return { repoId, reviewId };
}

const reviewsPending = () => queueSnapshot().reviews;

test("a completed workflow_run for a held review enqueues exactly one finalize job", () => {
  const sha = "sha-" + uuid();
  seedReview({ owner: "o", name: "match", headSha: sha });
  const before = reviewsPending();
  postWorkflowRun(wfEvent({ repoFullName: "o/match", headSha: sha, runId: 111 }));
  assert.equal(reviewsPending(), before + 1);
});

test("a non-completed action is ignored", () => {
  const sha = "sha-" + uuid();
  seedReview({ owner: "o", name: "req", headSha: sha });
  const before = reviewsPending();
  postWorkflowRun(wfEvent({ action: "requested", repoFullName: "o/req", headSha: sha, runId: 1 }));
  assert.equal(reviewsPending(), before);
});

test("a different head SHA does not match", () => {
  seedReview({ owner: "o", name: "sha", headSha: "the-real-sha" });
  const before = reviewsPending();
  postWorkflowRun(wfEvent({ repoFullName: "o/sha", headSha: "some-other-sha", runId: 2 }));
  assert.equal(reviewsPending(), before);
});

test("a review not in the pending state is not re-finalized", () => {
  const sha = "sha-" + uuid();
  seedReview({ owner: "o", name: "done", headSha: sha, state: "passed" });
  const before = reviewsPending();
  postWorkflowRun(wfEvent({ repoFullName: "o/done", headSha: sha, runId: 3 }));
  assert.equal(reviewsPending(), before);
});

test("when a test workflow is designated, only that workflow finalizes", () => {
  const sha = "sha-" + uuid();
  seedReview({ owner: "o", name: "named", headSha: sha, testWorkflow: "CI" });
  let before = reviewsPending();
  // Wrong workflow → ignored
  postWorkflowRun(wfEvent({ repoFullName: "o/named", headSha: sha, runId: 4, name: "Lint" }));
  assert.equal(reviewsPending(), before, "Lint must not finalize the CI-gated review");
  // Right workflow → enqueues
  before = reviewsPending();
  postWorkflowRun(wfEvent({ repoFullName: "o/named", headSha: sha, runId: 5, name: "CI" }));
  assert.equal(reviewsPending(), before + 1);
});

test("an untracked repo is ignored", () => {
  const before = reviewsPending();
  postWorkflowRun(wfEvent({ repoFullName: "nobody/here", headSha: "x", runId: 6 }));
  assert.equal(reviewsPending(), before);
});
