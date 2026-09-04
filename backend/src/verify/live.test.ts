// Offline: which verify row writes produce a live signal.
//   DATABASE_URL= node --import tsx/esm --test src/verify/live.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRowMatters } from "./live.js";

const run = (over: Record<string, unknown> = {}) => ({ id: "r", repoId: "repo-1", status: "planning", updatedAt: 1, ...over });
const art = (over: Record<string, unknown> = {}) => ({ id: "a", repoId: "repo-1", state: "pending_upload", ...over });

test("runs: status/verdict changes signal; updatedAt-only touches do not; inserts do", () => {
  assert.equal(verifyRowMatters("verifyRuns", run(), null), "repo-1");
  assert.equal(verifyRowMatters("verifyRuns", run({ status: "completed", updatedAt: 2 }), run()), "repo-1");
  assert.equal(verifyRowMatters("verifyRuns", run({ updatedAt: 2 }), run()), null);
  assert.equal(verifyRowMatters("verifyRuns", run({ updatedAt: 2, version: 9 }), run()), null);
});

test("artifacts: only state transitions signal; a signing insert is silent; other collections are ignored", () => {
  assert.equal(verifyRowMatters("verifyArtifacts", art(), null), null);
  assert.equal(verifyRowMatters("verifyArtifacts", art({ state: "uploaded" }), art()), "repo-1");
  assert.equal(verifyRowMatters("verifyArtifacts", art({ state: "expired" }), art({ state: "uploaded" })), "repo-1");
  assert.equal(verifyRowMatters("verifyArtifacts", art({ state: "uploaded", bytes: 5 }), art({ state: "uploaded" })), null);
  assert.equal(verifyRowMatters("prReviews", { repoId: "x" }, null), null);
});
