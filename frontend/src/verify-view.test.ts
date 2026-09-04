// Unit tests for the verification view logic (verify-view.ts).
//   node --test src/verify-view.test.ts
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatFlakeRate,
  isSignedUrlStale,
  parseDeepLink,
  revisionRows,
  traceViewerUrl,
  verdictTone,
  verificationCounts,
  verificationForCriterion,
} from "./verify-view.ts";
import type { RunView, RunViewArtifact } from "./api.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const art = (over: Partial<RunViewArtifact>): RunViewArtifact =>
  ({ id: "a", kind: "video", testId: "t1", criterionIds: ["1"], bytes: 10, state: "uploaded", expiresAt: NOW + DAY, posterArtifactId: null, path: "v.webm", attempt: 1, getUrl: "https://x/v", posterUrl: "https://x/p", urlExpiresAt: NOW + 300_000, ...over });

function view(over: Partial<RunView> = {}): RunView {
  return {
    run: { id: "run1", status: "completed", createdAt: NOW - 2 * DAY, verdicts: [{ criterionId: "1", verdict: "fail", reason: "refunds line missing", evidenceRefs: [] }, { criterionId: "2", verdict: "unverifiable", reason: "flaky test — quarantined", evidenceRefs: [], flaky: true }] } as RunView["run"],
    criteria: [],
    revision: 1,
    plan: { tests: [{ id: "t1", path: ".devasign/tests/e2e/refunds.spec.ts", criterionIds: ["1"], level: "e2e", origin: "generated" }, { id: "t2", path: "src/x.test.ts", criterionIds: ["2"], level: "unit", origin: "existing" }] } as RunView["plan"],
    results: [{ id: "r1", testId: "t1", criterionIds: ["1"], attempts: [{ n: 1 }, { n: 2 }, { n: 3 }], durationMs: 4200 }, { id: "r2", testId: "t2", criterionIds: ["2"], attempts: [{ n: 1 }, { n: 2 }], durationMs: 300 }] as RunView["results"],
    artifacts: [
      art({ id: "v1", attempt: 1, getUrl: "https://x/v1" }),
      art({ id: "tr1", kind: "trace", attempt: 1, getUrl: "https://x/tr1" }),
      art({ id: "v3", attempt: 3, getUrl: "https://x/v3", posterUrl: "https://x/p3" }),
      art({ id: "log1", kind: "log", attempt: 1, getUrl: "https://x/l1" }),
      art({ id: "v2a", testId: "t2", criterionIds: ["2"], attempt: 1, getUrl: "https://x/v2a" }),
    ],
    report: {},
    ...over,
  };
}

test("verificationForCriterion: verdict, test, attempts, the latest attempt's recording with its trace, and every attempt's recording", () => {
  const v = verificationForCriterion(view(), "1", NOW)!;
  assert.equal(v.verdict, "fail");
  assert.equal(v.reason, "refunds line missing");
  assert.deepEqual(v.test, { id: "t1", name: ".devasign/tests/e2e/refunds.spec.ts", level: "e2e", origin: "generated" });
  assert.equal(v.attempts, 3);
  assert.equal(formatDuration(v.durationMs), "4.2s");
  assert.equal(v.recording?.artifactId, "v3", "the latest attempt's recording is the primary one");
  assert.equal(v.recording?.posterUrl, "https://x/p3");
  assert.equal(v.recording?.expired, false);
  assert.equal(v.recording?.expiredAfterDays, 3);
  assert.deepEqual(v.attemptRecordings.map((r) => r.artifactId), ["v1", "v3"]);
  assert.equal(v.attemptRecordings[0].trace?.getUrl, "https://x/tr1", "the trace pairs by test + attempt");
  assert.equal(v.attemptRecordings[1].trace, null);
  assert.equal(v.logs.length, 1);
  const flaky = verificationForCriterion(view(), "2", NOW)!;
  assert.equal(flaky.flaky, true);
  assert.equal(flaky.verdict, "unverifiable");
  assert.equal(flaky.recording?.artifactId, "v2a");
});

test("expired recordings keep the block but lose the play URL; unit-only criteria have no recording; pending before verdicts", () => {
  const expired = view({ artifacts: [art({ id: "v1", state: "expired", getUrl: null, posterUrl: null })] });
  const v = verificationForCriterion(expired, "1", NOW)!;
  assert.equal(v.recording?.expired, true);
  assert.equal(v.recording?.getUrl, null);
  const clockExpired = verificationForCriterion(view({ artifacts: [art({ id: "v1", expiresAt: NOW - 1 })] }), "1", NOW)!;
  assert.equal(clockExpired.recording?.expired, true, "past expiresAt counts even before the job flips the row");
  const unit = verificationForCriterion(view(), "2", NOW)!;
  assert.ok(unit.recording, "criterion 2 has a video here");
  const noVideo = verificationForCriterion(view({ artifacts: [] }), "2", NOW)!;
  assert.equal(noVideo.recording, null);
  assert.equal(noVideo.attemptRecordings.length, 0);
  const pending = verificationForCriterion(view({ run: { id: "run1", status: "running", createdAt: NOW, verdicts: [] } as RunView["run"] }), "1", NOW)!;
  assert.equal(pending.verdict, "pending");
  const noVerdictButDone = verificationForCriterion(view({ run: { id: "run1", status: "completed", createdAt: NOW, verdicts: [] } as RunView["run"] }), "9", NOW)!;
  assert.equal(noVerdictButDone.verdict, "unverifiable");
  assert.equal(verificationForCriterion(null, "1"), null);
});

test("counts skip unverifiable-kind, superseded, and not-applicable criteria", () => {
  const counts = verificationCounts(view(), [
    { id: "1", text: "", met: null, evidence: null },
    { id: "2", text: "", met: null, evidence: null, kind: "ui" },
    { id: "3", text: "", met: null, evidence: null, kind: "unverifiable" },
    { id: "4", text: "", met: null, evidence: null, supersededBy: "5" },
    { id: "5", text: "", met: null, evidence: null },
  ]);
  assert.deepEqual(counts, { pass: 0, fail: 1, unverifiable: 2, pending: 0 });
});

test("helpers: tones, deep links, durations, flake rate, stale URLs, trace viewer, revisions", () => {
  assert.equal(verdictTone("pass"), "ok");
  assert.equal(verdictTone("fail"), "danger");
  assert.equal(verdictTone("unverifiable"), "nit");
  assert.equal(verdictTone("pending"), "mute");
  assert.deepEqual(parseDeepLink("?run=r1&criterion=3"), { runId: "r1", criterionId: "3" });
  assert.deepEqual(parseDeepLink(new URLSearchParams("")), { runId: null, criterionId: null });
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatFlakeRate({ rate: 0.04, flaky: 2, total: 50 }), "flake 4% (2/50)");
  assert.equal(formatFlakeRate({ rate: 0, flaky: 0, total: 0 }), null);
  assert.equal(isSignedUrlStale(NOW + 10_000, NOW), true);
  assert.equal(isSignedUrlStale(NOW + 100_000, NOW), false);
  assert.equal(isSignedUrlStale(null, NOW), true);
  assert.equal(traceViewerUrl("https://x/t.zip?sig=a&b"), "https://trace.playwright.dev/?trace=https%3A%2F%2Fx%2Ft.zip%3Fsig%3Da%26b");
  const rows = revisionRows([
    { id: "b", schemaVersion: 1, reviewId: "r", revision: 2, causedByCommentId: 77, criteria: [], createdAt: 2, diff: [{ op: "reword", criterionId: "1", before: "old", after: "new" }, { op: "add", criterionId: "5", after: "total formatted as currency" }] },
    { id: "a", schemaVersion: 1, reviewId: "r", revision: 1, causedByCommentId: null, criteria: [{ id: "1", text: "x", met: null, evidence: null }], createdAt: 1, diff: [] },
  ]);
  assert.deepEqual(rows.map((r) => [r.revision, r.cause, r.commentId]), [[1, "synthesis", null], [2, "comment", 77]]);
  assert.deepEqual(rows[0].changes, ["1 criteria synthesized"]);
  assert.deepEqual(rows[1].changes, ['reworded 1: "old" → "new"', "added 5: total formatted as currency"]);
});
