// Seeds one reviewed PR with a completed verification run — verdicts, plan,
// results, criteria revisions, flake history, and artifact rows whose bytes are
// copied from EPHEMERAL_VERIFY_ASSETS (a kept @devasign/verify fixture run) into
// the dev-only local artifact store. Used by ephemeral-dev.ts to look at the
// run page in a browser without GitHub, a runner, or a bucket.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { artifactKey } from "../src/verify/storage.js";
import type { VerifyArtifact } from "../src/types.js";

function findFile(dir: string, re: RegExp): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, re);
      if (hit) return hit;
    } else if (re.test(name)) return full;
  }
  return null;
}

export function seedVerifyRun(assetsDir: string, installId: string): { reviewId: string; runId: string } {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const repo = db.insert("repositories", {
    id: "ephemeral-repo-verify",
    installationId: installId,
    owner: "acme",
    name: "revenue",
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "ready",
    githubRepoId: 4242,
    verify: { onboarding: { state: "verified", firstSuccessfulRunId: "ephemeral-run-1" }, detected: { languages: ["typescript"], frameworks: [{ name: "playwright", configPath: "playwright.config.ts" }], testCommands: [], envExampleVars: [], existingWorkflows: [], services: [] } },
  } as never);
  const criteria = [
    { id: "1", text: "The revenue page shows a refunds line when refunds > 0", met: false, evidence: "The refunds line is never rendered: the component reads `refund` but the API returns `refunds`.", kind: "ui" as const, implied: false, source: { input: "linear", ref: "ENG-142", excerpt: "show a refunds line when refunds exist" } },
    { id: "2", text: "The total is formatted as US currency", met: true, evidence: "formatTotal renders $1,234.56.", kind: "ui" as const, implied: false },
    { id: "3", text: "Existing consumers of `GET /api/revenue` (`frontend/src/screen-revenue.tsx`) still work correctly after this change.", met: true, evidence: "The screen still renders totals.", kind: "ui" as const, implied: true, source: { input: "diff", ref: "backend/src/routes/revenue.ts" } },
    { id: "4", text: "sumRefunds returns 0 for an empty list", met: true, evidence: "Covered by the unit test.", kind: "code" as const, implied: false },
  ];
  const review = db.insert("prReviews", {
    id: "ephemeral-review-verify",
    repoId: repo.id,
    prNumber: 42,
    prTitle: "Add refunds to the revenue page",
    headSha: "9f3c1d2e7a4b5c6d8e9f0a1b2c3d4e5f60718293",
    baseSha: "0000000000000000000000000000000000000000",
    status: "changes_requested",
    verdict: "1 of 4 acceptance criteria not met.",
    criteria,
    taskId: "ephemeral-task-verify",
    additions: 48,
    deletions: 6,
    changedFiles: 3,
    progressCommentId: 5001,
    progressCommentSha: "9f3c1d2e7a4b5c6d8e9f0a1b2c3d4e5f60718293",
    createdAt: now - 2 * 60 * 60_000,
    updatedAt: now - 60 * 60_000,
  } as never);
  db.insert("tasks", { id: "ephemeral-task-verify", userId: "", source: "github", title: review.prTitle, endGoal: "The revenue page shows refunds alongside the currency-formatted total, and existing consumers of the revenue API keep working.", attachments: [], createdAt: now, updatedAt: now } as never);
  db.insert("criteriaRevisions", { id: "ephemeral-rev-1", schemaVersion: 1, reviewId: review.id, revision: 1, causedByCommentId: null, criteria: criteria.map((c) => ({ ...c, text: c.id === "1" ? "The revenue page shows a refunds line" : c.text })).filter((c) => c.id !== "2"), diff: [], createdAt: now - 2 * 60 * 60_000 });
  db.insert("criteriaRevisions", { id: "ephemeral-rev-2", schemaVersion: 1, reviewId: review.id, revision: 2, causedByCommentId: 5007, criteria, diff: [{ op: "reword", criterionId: "1", before: "The revenue page shows a refunds line", after: criteria[0].text }, { op: "add", criterionId: "2", after: criteria[1].text }], createdAt: now - 90 * 60_000 });
  for (const l of [
    { kind: "verify", action: "Verification branch forked", detail: "4 criteria to verify; planning tests in parallel with the review", at: now - 2 * 60 * 60_000 },
    { kind: "verify", action: "Test plan ready: 3 generated, 1 existing, 0 unverifiable", detail: "e2e generated .devasign/tests/e2e/criterion-1.spec.ts → [1]", at: now - 118 * 60_000 },
    { kind: "verify", action: "Verification complete: 2 passed, 1 failed, 1 unverifiable", detail: "[1] fail: the refunds line never became visible\n[2] pass\n[3] unverifiable: flaky test — quarantined\n[4] pass", at: now - 60 * 60_000 },
  ]) db.insert("reviewLogs", { id: `ephemeral-log-${l.at}`, reviewId: review.id, kind: l.kind, at: l.at, action: l.action, detail: l.detail } as never);

  const runId = "ephemeral-run-1";
  const tests = [
    { id: "t1", path: ".devasign/tests/e2e/criterion-1.spec.ts", content: null, criterionIds: ["1"], level: "e2e", levelReason: "observable only in the rendered UI", origin: "generated", runner: "playwright", testSignature: "sig-1", strategyVersion: 1, targetFiles: ["frontend/src/screen-revenue.tsx"] },
    { id: "t2", path: ".devasign/tests/e2e/criterion-2.spec.ts", content: null, criterionIds: ["2"], level: "e2e", levelReason: "visible copy", origin: "generated", runner: "playwright", testSignature: "sig-2", strategyVersion: 1, targetFiles: ["frontend/src/screen-revenue.tsx"] },
    { id: "t3", path: ".devasign/tests/e2e/criterion-3.spec.ts", content: null, criterionIds: ["3"], level: "e2e", levelReason: "blast radius: a frontend consumer", origin: "generated", runner: "playwright", testSignature: "sig-3", strategyVersion: 2, targetFiles: ["frontend/src/screen-revenue.tsx"] },
    { id: "t4", path: "backend/src/revenue.test.ts", content: null, criterionIds: ["4"], level: "unit", levelReason: "pure function", origin: "existing", runner: "node-test", testSignature: "sig-4", strategyVersion: 1, targetFiles: [] },
  ] as const;
  db.insert("verifyPlans", { id: "ephemeral-plan-1", schemaVersion: 1, runId, repoId: repo.id, criteriaRevision: 2, tests: tests as never, commands: [], unverifiable: [], createdAt: now - 118 * 60_000 });

  // Artifact rows + bytes. Videos/traces/screenshots come from the kept fixture run.
  const video = findFile(assetsDir, /^video\.webm$/);
  const trace = findFile(assetsDir, /^trace\.zip$/);
  const shot = findFile(assetsDir, /^test-(failed|finished)-1\.png$/);
  const dir = path.resolve(config.artifacts.localDir);
  const rows: VerifyArtifact[] = [];
  const add = (id: string, kind: VerifyArtifact["kind"], testId: string, criterionIds: string[], attempt: number, src: string | null, contentType: string, over: Partial<VerifyArtifact> = {}) => {
    const key = artifactKey(repo.id, runId, id, kind, contentType);
    if (src && existsSync(src)) {
      const dest = path.join(dir, key);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    const row: VerifyArtifact = { id, schemaVersion: 1, runId, repoId: repo.id, testId, criterionIds, kind, path: `.devasign/artifacts/${id}`, storageKey: key, bytes: src && existsSync(src) ? statSync(src).size : 1, contentType, state: "uploaded", expiresAt: now + 3 * DAY, uploadedAt: now - 61 * 60_000, createdAt: now - 62 * 60_000, posterArtifactId: null, ...over };
    rows.push(row);
    db.insert("verifyArtifacts", row);
    return row;
  };
  // Criterion 1: fail on all 3 attempts — one recording per attempt, the last is primary.
  for (const n of [1, 2, 3]) {
    add(`a1-video-${n}`, "video", "t1", ["1"], n, video, "video/webm", { posterArtifactId: `a1-poster-${n}` });
    add(`a1-poster-${n}`, "poster", "t1", ["1"], n, shot, "image/png");
    add(`a1-trace-${n}`, "trace", "t1", ["1"], n, trace, "application/zip");
    add(`a1-shot-${n}`, "screenshot", "t1", ["1"], n, shot, "image/png");
  }
  add("a1-log", "log", "t1", ["1"], 1, null, "text/plain");
  add("a1-file", "test_file", "t1", ["1"], 1, null, "text/plain");
  // Criterion 2: passed, but its recording has EXPIRED (free-tier retention).
  add("a2-video", "video", "t2", ["2"], 1, null, "video/webm", { state: "expired", expiresAt: now - DAY, expiredAt: now - 60_000, createdAt: now - 2 * DAY });
  // Criterion 3: flaky — attempt 1 failed, attempt 2 passed; both recorded.
  add("a3-video-1", "video", "t3", ["3"], 1, video, "video/webm", { posterArtifactId: "a3-poster-1" });
  add("a3-poster-1", "poster", "t3", ["3"], 1, shot, "image/png");
  add("a3-video-2", "video", "t3", ["3"], 2, video, "video/webm", { posterArtifactId: "a3-poster-2" });
  add("a3-poster-2", "poster", "t3", ["3"], 2, shot, "image/png");
  add("a3-trace-2", "trace", "t3", ["3"], 2, trace, "application/zip");
  // Criterion 4: unit test — no recording at all.
  add("a4-log", "log", "t4", ["4"], 1, null, "text/plain");

  const attempt = (n: number, status: "pass" | "fail", ids: string[], ms = 1800) => ({ n, status, durationMs: ms, artifactIds: ids, ...(status === "fail" ? { error: "Error: expect(locator).toBeVisible() failed — getByTestId('refunds')" } : {}) });
  db.insert("verifyResults", {
    id: "ephemeral-results-1", schemaVersion: 1, runId, createdAt: now - 61 * 60_000,
    payload: {
      runId, sha: review.headSha, planId: "ephemeral-plan-1", cliVersion: "0.1.0", existingTestsTouchingDiff: [], timings: { startedAt: now - 70 * 60_000, finishedAt: now - 61 * 60_000 },
      results: [
        { id: "r1", testId: "t1", criterionIds: ["1"], test: tests[0].path, runner: "playwright", level: "e2e", origin: "generated", status: "fail", attempts: [attempt(1, "fail", ["a1-video-1", "a1-poster-1", "a1-trace-1", "a1-shot-1"]), attempt(2, "fail", ["a1-video-2", "a1-poster-2", "a1-trace-2", "a1-shot-2"]), attempt(3, "fail", ["a1-video-3", "a1-poster-3", "a1-trace-3", "a1-shot-3"])], durationMs: 5400, error: "Error: expect(locator).toBeVisible() failed", artifactIds: ["a1-log", "a1-file"] },
        { id: "r2", testId: "t2", criterionIds: ["2"], test: tests[1].path, runner: "playwright", level: "e2e", origin: "generated", status: "pass", attempts: [attempt(1, "pass", ["a2-video"], 900)], durationMs: 900, artifactIds: [] },
        { id: "r3", testId: "t3", criterionIds: ["3"], test: tests[2].path, runner: "playwright", level: "e2e", origin: "generated", status: "flaky", attempts: [attempt(1, "fail", ["a3-video-1", "a3-poster-1"], 2100), attempt(2, "pass", ["a3-video-2", "a3-poster-2", "a3-trace-2"], 1500)], durationMs: 3600, artifactIds: [] },
        { id: "r4", testId: "t4", criterionIds: ["4"], test: tests[3].path, runner: "node-test", level: "unit", origin: "existing", status: "pass", attempts: [attempt(1, "pass", ["a4-log"], 120)], durationMs: 120, artifactIds: ["a4-log"] },
      ],
    },
  } as never);
  db.insert("verifyRuns", {
    id: runId, schemaVersion: 1, reviewId: review.id, repoId: repo.id, installationId: installId, prNumber: 42, sha: review.headSha, attempt: 1,
    status: "completed", skipReason: null, error: null, criteriaRevision: 2, planTier: "pro", planId: "ephemeral-plan-1", resultsId: "ephemeral-results-1",
    verdicts: [
      { criterionId: "1", verdict: "fail", reason: "the refunds line never became visible on any of 3 attempts", evidenceRefs: [{ artifactId: "a1-video-3" }, { artifactId: "a1-shot-3" }] },
      { criterionId: "2", verdict: "pass", reason: "the total renders as $1,234.56", evidenceRefs: [] },
      { criterionId: "3", verdict: "unverifiable", reason: "flaky test — quarantined", evidenceRefs: [{ artifactId: "a3-video-1" }, { artifactId: "a3-video-2" }], flaky: true },
      { criterionId: "4", verdict: "pass", reason: "the existing unit test passed", evidenceRefs: [{ artifactId: "a4-log" }] },
    ],
    timings: { forkedAt: now - 2 * 60 * 60_000, criteriaFinishedAt: now - 2 * 60 * 60_000 + 200, planStartedAt: now - 2 * 60 * 60_000 + 900, planFinishedAt: now - 118 * 60_000, resolvedAt: now - 100 * 60_000, resultsAt: now - 61 * 60_000, judgedAt: now - 60 * 60_000, reportedAt: now - 60 * 60_000, reviewBranch: { startedAt: now - 2 * 60 * 60_000, finishedAt: now - 115 * 60_000 } },
    tokenUsage: { plan: { anthropic: { inputTokens: 18_400, outputTokens: 5_100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.22 } }, judge: { anthropic: { inputTokens: 6_200, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.05 } } },
    artifactBytes: rows.reduce((s, r) => s + r.bytes, 0),
    report: { checkRunUrl: "https://github.com/acme/revenue/runs/1", commentId: 5001 },
    triggeredBy: { kind: "pr_event" }, createdAt: now - 2 * 60 * 60_000, updatedAt: now - 60 * 60_000,
  } as never);
  for (const [sig, outcomes] of [["sig-1", ["fail"]], ["sig-2", ["pass"]], ["sig-3", ["flaky", "flaky"]], ["sig-9", ["pass"]]] as const) {
    db.insert("testFlakeHistory", { id: `ephemeral-flake-${sig}`, schemaVersion: 1, repoId: repo.id, testSignature: sig, history: outcomes.map((o, i) => ({ runId, outcome: o, strategyVersion: i + 1, at: now })), flakeCount: outcomes.filter((o) => o === "flaky").length, quarantinedAt: outcomes.includes("flaky") ? now : null, retiredAt: null, criterionText: "", updatedAt: now });
  }
  console.log(`[ephemeral] seeded verify run: open /reviews/${review.id}?run=${runId}&criterion=1 (assets: ${video ? "recording found" : "NO recording found in " + assetsDir})`);
  return { reviewId: review.id, runId };
}
