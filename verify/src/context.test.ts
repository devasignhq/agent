// node --import tsx/esm --test src/context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prAndShaFromEvent, readContext } from "./context.js";

test("pull_request events use the PR head sha, never GITHUB_SHA", () => {
  const ctx = readContext({
    env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widgets", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2", GITHUB_SERVER_URL: "https://github.com", RUNNER_OS: "Linux", GITHUB_ACTIONS: "true", GITHUB_SHA: "mergecommit" },
    payload: { pull_request: { number: 12, head: { sha: "headsha1" } } },
    cwd: "/tmp",
  });
  assert.equal(ctx.pr, 12);
  assert.equal(ctx.sha, "headsha1");
  assert.equal(ctx.runAttempt, 2);
  assert.equal(ctx.jobUrl, "https://github.com/acme/widgets/actions/runs/77");
  assert.equal(ctx.onActions, true);
});

test("repository_dispatch and workflow_dispatch carry pr/sha in the payload; overrides win; otherwise throws", () => {
  assert.deepEqual(prAndShaFromEvent("repository_dispatch", { client_payload: { pr: "5", sha: "abc" } }), { pr: 5, sha: "abc" });
  assert.deepEqual(prAndShaFromEvent("workflow_dispatch", { inputs: { pr: "9", sha: "def" } }), { pr: 9, sha: "def" });
  const ctx = readContext({ env: {}, pr: 3, sha: "zzz", cwd: "/tmp" });
  assert.equal(ctx.event, "workflow_dispatch");
  assert.throws(() => readContext({ env: { GITHUB_EVENT_NAME: "push" }, payload: {}, cwd: "/tmp" }), /cannot determine the pull request/);
});
