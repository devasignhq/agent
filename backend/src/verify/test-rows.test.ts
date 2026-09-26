// Pure Tests-page row building: result join, evidence filtering/expiry,
// level bucketing, adopted passthrough, and the latest-run-per-review pick.
//   DATABASE_URL= node --import tsx/esm --test src/verify/test-rows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketLevel, buildTestRows, latestRunPerReview, summarizeTestRows, supersededReviews } from "./test-rows.js";

const NOW = 1_000_000;
const run: any = { id: "run1", repoId: "repo1", reviewId: "rev1", sha: "abc", status: "completed", createdAt: 500, attempt: 1, report: { checkRunUrl: "https://gh/check" } };
const plan: any = {
  id: "p1",
  tests: [
    { id: "t1", path: ".devasign/tests/e2e/checkout.spec.ts", content: "// secret", criterionIds: ["c1"], level: "e2e", origin: "generated", runner: "playwright", adopted: { prUrl: "https://gh/pr/9", prNumber: 9, at: 1 } },
    { id: "t2", path: "src/cart.test.ts", content: null, criterionIds: ["c2"], level: "component", origin: "existing", runner: "vitest" },
    { id: "t3", path: ".devasign/tests/tax.test.ts", content: "// x", criterionIds: ["c3"], level: "unit", origin: "generated", runner: "node-test" },
  ],
};
const results: any = {
  payload: {
    results: [
      { id: "r1", testId: "t1", status: "pass", attempts: [{ n: 1, status: "pass", durationMs: 10 }, { n: 2, status: "pass", durationMs: 12 }], durationMs: 22 },
      { id: "r2", testId: "t2", status: "fail", attempts: [{ n: 1, status: "fail", durationMs: 5 }], durationMs: 5 },
    ],
  },
};
const artifacts: any[] = [
  { id: "a-video-2", runId: "run1", testId: "t1", kind: "video", attempt: 2, state: "uploaded", expiresAt: NOW + 10 },
  { id: "a-video-1", runId: "run1", testId: "t1", kind: "video", attempt: 1, state: "uploaded", expiresAt: NOW - 1 },
  { id: "a-poster", runId: "run1", testId: "t1", kind: "poster", attempt: 2, state: "uploaded", expiresAt: NOW + 10 },
  { id: "a-file", runId: "run1", testId: "t1", kind: "test_file", state: "uploaded", expiresAt: NOW + 10 },
  { id: "a-log", runId: "run1", testId: "t2", kind: "log", state: "expired", expiresAt: NOW + 10 },
  { id: "a-orphan", runId: "run1", kind: "log", state: "uploaded", expiresAt: NOW + 10 },
];
const ctx = { repoName: "acme/shop", review: { id: "rev1", prNumber: 7, prTitle: "Refunds" } };

test("bucketLevel: only e2e is e2e", () => {
  assert.equal(bucketLevel("e2e"), "e2e");
  for (const l of ["unit", "integration", "component"] as const) assert.equal(bucketLevel(l), "unit");
});

test("rows join results and evidence per test, never leak test content", () => {
  const rows = buildTestRows(run, plan, results, artifacts, ctx, NOW);
  assert.deepEqual(rows.map((r) => r.key), ["run1:t1", "run1:t2", "run1:t3"]);
  const [t1, t2, t3] = rows;
  assert.equal(t1.status, "pass");
  assert.equal(t1.attempts, 2);
  assert.equal(t1.durationMs, 22);
  assert.equal(t1.category, "e2e");
  assert.deepEqual(t1.evidence, [
    { artifactId: "a-video-1", kind: "video", attempt: 1, expired: true },
    { artifactId: "a-video-2", kind: "video", attempt: 2, expired: false },
  ]);
  assert.deepEqual(t1.adopted, { prUrl: "https://gh/pr/9", prNumber: 9, at: 1 });
  assert.equal(t2.status, "fail");
  assert.equal(t2.category, "unit");
  assert.deepEqual(t2.evidence, [{ artifactId: "a-log", kind: "log", attempt: null, expired: true }]);
  assert.equal(t2.adopted, null);
  assert.equal(t3.status, "not_run");
  assert.equal(t3.attempts, 0);
  assert.deepEqual(t3.evidence, []);
  assert.deepEqual(t1.repo, { id: "repo1", name: "acme/shop" });
  assert.deepEqual(t1.review, ctx.review);
  assert.deepEqual(t1.run, { id: "run1", sha: "abc", status: "completed", createdAt: 500, checkRunUrl: "https://gh/check" });
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});

test("a run with no results marks every test not_run", () => {
  const rows = buildTestRows({ ...run, report: undefined }, plan, null, [], ctx, NOW);
  assert.ok(rows.every((r) => r.status === "not_run"));
  assert.equal(rows[0].run.checkRunUrl, null);
});

test("counts: ran excludes not_run, failed = fail|error, flaky/skipped count in neither", () => {
  const rows = buildTestRows(run, plan, results, artifacts, ctx, NOW);
  assert.deepEqual(summarizeTestRows(rows), { ran: 2, e2e: 1, unit: 2, passed: 1, failed: 1, archived: 0 });
  const extra: any = { payload: { results: [...results.payload.results, { id: "r3", testId: "t3", status: "flaky", attempts: [], durationMs: 0 }] } };
  const rows2 = buildTestRows(run, plan, extra, artifacts, ctx, NOW);
  assert.deepEqual(summarizeTestRows(rows2), { ran: 3, e2e: 1, unit: 2, passed: 1, failed: 1, archived: 0 });
  const errored: any = { payload: { results: [{ id: "r1", testId: "t1", status: "error", attempts: [], durationMs: 0 }] } };
  assert.equal(summarizeTestRows(buildTestRows(run, plan, errored, [], ctx, NOW)).failed, 1);
});

test("archived paths mark their rows and drop out of the other counts", () => {
  const rows = buildTestRows(run, plan, results, artifacts, { ...ctx, archived: [{ path: "src/cart.test.ts", at: 42 }] }, NOW);
  assert.deepEqual(rows.map((r) => r.archived), [null, { at: 42 }, null]);
  assert.deepEqual(summarizeTestRows(rows), { ran: 1, e2e: 1, unit: 1, passed: 1, failed: 0, archived: 1 });
});

test("latestRunPerReview keeps the newest run per review, newest first overall", () => {
  const runs: any[] = [
    { id: "a", reviewId: "r1", createdAt: 1, attempt: 1 },
    { id: "b", reviewId: "r1", createdAt: 5, attempt: 1 },
    { id: "c", reviewId: "r1", createdAt: 5, attempt: 2 },
    { id: "d", reviewId: "r2", createdAt: 3, attempt: 1 },
  ];
  assert.deepEqual(latestRunPerReview(runs).map((r) => r.id), ["c", "d"]);
});

test("supersededReviews: the highest PR number per repo stays active, older PRs point at it", () => {
  const runs: any[] = [
    { reviewId: "a5", repoId: "r1", prNumber: 5, createdAt: 900 },
    { reviewId: "a9", repoId: "r1", prNumber: 9, createdAt: 100 },
    { reviewId: "a7", repoId: "r1", prNumber: 7, createdAt: 50 },
    { reviewId: "b2", repoId: "r2", prNumber: 2, createdAt: 10 },
  ];
  const sup = supersededReviews(runs, (id) => (id === "a9" ? 77 : undefined));
  assert.deepEqual([...sup].sort(), [["a5", { prNumber: 9, at: 77 }], ["a7", { prNumber: 9, at: 77 }]]);
  assert.deepEqual(supersededReviews(runs.slice(1, 2), () => undefined).size, 0);
  assert.deepEqual(supersededReviews([runs[0], runs[2]], () => undefined).get("a5"), { prNumber: 7, at: 50 });
});

test("a superseded PR's rows are auto-archived unless restored after the newer PR arrived", () => {
  const superseded = { prNumber: 9, at: 300 };
  const rows = buildTestRows(run, plan, results, artifacts, {
    ...ctx,
    superseded,
    archived: [{ path: "src/cart.test.ts", at: 42 }],
    restored: [{ path: ".devasign/tests/tax.test.ts", at: 400 }, { path: ".devasign/tests/e2e/checkout.spec.ts", at: 200 }],
  }, NOW);
  assert.deepEqual(rows.map((r) => r.archived), [{ at: 300, supersededBy: 9 }, { at: 42 }, null]);
  assert.deepEqual(summarizeTestRows(rows), { ran: 0, e2e: 0, unit: 1, passed: 0, failed: 0, archived: 2 });
});
