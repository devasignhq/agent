// node --test src/tests-view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserSetupEntry, RunView, VerifyTestRow } from "./api.ts";
import { EMPTY_FILTERS, browserBanner, countRows, filterRows, markAdopted, markArchived, pickEvidence, repoOptions, soonestEvidenceExpiry, sortRows, statusLabel, statusTone, testDetail, testName } from "./tests-view.ts";

const row = (over: Partial<VerifyTestRow> & { key: string }): VerifyTestRow => ({
  testId: over.key,
  path: ".devasign/tests/x.spec.ts",
  level: "e2e",
  category: "e2e",
  origin: "generated",
  runner: "playwright",
  criterionIds: [],
  status: "pass",
  attempts: 1,
  durationMs: 10,
  evidence: [],
  adopted: null,
  archived: null,
  repo: { id: "r1", name: "acme/shop" },
  review: { id: "rev1", prNumber: 7, prTitle: "Refunds" },
  run: { id: "run1", sha: "abc", status: "completed", createdAt: 100, checkRunUrl: null },
  ...over,
});

test("testName is the last path segment", () => {
  assert.equal(testName(".devasign/tests/e2e/checkout.spec.ts"), "checkout.spec.ts");
  assert.equal(testName("x.test.ts"), "x.test.ts");
});

test("status tone and label", () => {
  assert.equal(statusTone("pass"), "ok");
  assert.equal(statusTone("fail"), "danger");
  assert.equal(statusTone("error"), "danger");
  assert.equal(statusTone("flaky"), "warn");
  assert.equal(statusTone("skipped"), "nit");
  assert.equal(statusTone("not_run"), "mute");
  assert.equal(statusLabel("fail"), "FAIL");
  assert.equal(statusLabel("error"), "FAIL");
  assert.equal(statusLabel("not_run"), "not run");
  assert.equal(statusLabel("pass"), "pass");
});

test("filters narrow by repo, category, status, origin, review, and search", () => {
  const rows = [
    row({ key: "a", path: "a/checkout.spec.ts" }),
    row({ key: "b", path: "b/tax.test.ts", level: "unit", category: "unit", origin: "existing", status: "fail", repo: { id: "r2", name: "acme/api" }, review: { id: "rev2", prNumber: 9, prTitle: "Tax" } }),
  ];
  const keys = (f: Partial<typeof EMPTY_FILTERS>) => filterRows(rows, { ...EMPTY_FILTERS, ...f }).map((r) => r.key);
  assert.deepEqual(keys({}), ["a", "b"]);
  assert.deepEqual(keys({ repo: "r2" }), ["b"]);
  assert.deepEqual(keys({ category: "e2e" }), ["a"]);
  assert.deepEqual(keys({ status: "fail" }), ["b"]);
  assert.deepEqual(keys({ origin: "existing" }), ["b"]);
  assert.deepEqual(keys({ review: "rev1" }), ["a"]);
  assert.deepEqual(keys({ q: "CHECKOUT" }), ["a"]);
  assert.deepEqual(keys({ q: "#9" }), ["b"]);
  assert.deepEqual(keys({ q: "acme/api" }), ["b"]);
});

test("the Failed filter includes errored tests; archived rows show only under the Archived view", () => {
  const rows = [
    row({ key: "p" }),
    row({ key: "e", status: "error" }),
    row({ key: "x", status: "fail", archived: { at: 1 } }),
  ];
  const keys = (f: Partial<typeof EMPTY_FILTERS>) => filterRows(rows, { ...EMPTY_FILTERS, ...f }).map((r) => r.key);
  assert.deepEqual(keys({}), ["p", "e"]);
  assert.deepEqual(keys({ status: "fail" }), ["e"]);
  assert.deepEqual(keys({ archived: true }), ["x"]);
  assert.deepEqual(keys({ archived: true, status: "fail" }), ["x"]);
});

test("markArchived toggles matching paths of one review; countRows sets archived rows apart", () => {
  const rows = [
    row({ key: "a", path: "a.ts" }),
    row({ key: "b", path: "b.ts", status: "error" }),
    row({ key: "c", path: "a.ts", review: { id: "rev2", prNumber: 9, prTitle: "Tax" } }),
  ];
  const archived = markArchived(rows, "rev1", ["a.ts"], true, 5);
  assert.deepEqual(archived.map((r) => r.archived), [{ at: 5 }, null, null]);
  assert.deepEqual(countRows(archived), { ran: 2, e2e: 2, unit: 0, passed: 1, failed: 1, archived: 1 });
  assert.equal(markArchived(archived, "rev1", ["a.ts"], false)[0].archived, null);
});

test("sort: newest run first, then failures, then path", () => {
  const rows = [
    row({ key: "old", run: { id: "r0", sha: "s", status: "completed", createdAt: 1, checkRunUrl: null } }),
    row({ key: "z", path: "z.ts" }),
    row({ key: "f", path: "m.ts", status: "fail" }),
    row({ key: "a", path: "a.ts" }),
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.key), ["f", "a", "z", "old"]);
});

test("pickEvidence yields one chip per kind from the highest attempt, in a fixed order", () => {
  const r = row({
    key: "a",
    evidence: [
      { artifactId: "log1", kind: "log", attempt: 1, expired: false },
      { artifactId: "v1", kind: "video", attempt: 1, expired: true },
      { artifactId: "v2", kind: "video", attempt: 2, expired: false },
      { artifactId: "t2", kind: "trace", attempt: 2, expired: false },
    ],
  });
  assert.deepEqual(pickEvidence(r), [
    { artifactId: "v2", kind: "video", expired: false },
    { artifactId: "t2", kind: "trace", expired: false },
    { artifactId: "log1", kind: "log", expired: false },
  ]);
});

test("repoOptions dedupes and sorts; markAdopted patches one row", () => {
  const rows = [row({ key: "a", repo: { id: "r2", name: "b/z" } }), row({ key: "b" }), row({ key: "c" })];
  assert.deepEqual(repoOptions(rows), [{ id: "r1", name: "acme/shop" }, { id: "r2", name: "b/z" }]);
  const adopted = { prUrl: "u", prNumber: 3, at: 1 };
  const out = markAdopted(rows, "b", adopted);
  assert.deepEqual(out.map((r) => r.adopted), [null, adopted, null]);
});

test("testDetail joins criteria, result attempts, recordings, and other evidence", () => {
  const NOW = 1_000_000;
  const view: RunView = {
    run: { id: "run1", status: "completed", sha: "abc", attempt: 1, createdAt: NOW - 1000, timings: {}, verdicts: [{ criterionId: "c1", verdict: "pass", reason: "clicked through", evidenceRefs: [] }] },
    criteria: [{ id: "c1", text: "Checkout works", met: true, evidence: null }, { id: "c2", text: "Tax applied", met: null, evidence: null }],
    revision: 1,
    plan: {
      id: "p1",
      tests: [{ id: "t1", path: "a.spec.ts", criterionIds: ["c1", "c2"], level: "e2e", origin: "generated", runner: "playwright", adopted: { prUrl: "u", prNumber: 4, at: 1 } }],
      unverifiable: [],
    },
    results: [{ id: "r1", testId: "t1", criterionIds: ["c1"], test: "a", runner: "playwright", level: "e2e", origin: "generated", status: "pass", attempts: [{ n: 1, status: "fail", durationMs: 5, error: "boom", artifactIds: [] }, { n: 2, status: "pass", durationMs: 7, artifactIds: [] }], durationMs: 12, artifactIds: [] }],
    artifacts: [
      { id: "v2", kind: "video", testId: "t1", criterionIds: ["c1"], bytes: 1, state: "uploaded", expiresAt: NOW + 10, posterArtifactId: "p2", path: "v", attempt: 2, getUrl: "https://v2", posterUrl: null, urlExpiresAt: NOW + 10 },
      { id: "p2", kind: "poster", testId: "t1", criterionIds: [], bytes: 1, state: "uploaded", expiresAt: NOW + 10, path: "p", attempt: 2, getUrl: "https://p2", posterUrl: null, urlExpiresAt: NOW + 10 },
      { id: "tr2", kind: "trace", testId: "t1", criterionIds: [], bytes: 1, state: "uploaded", expiresAt: NOW + 10, path: "t", attempt: 2, getUrl: "https://tr2", posterUrl: null, urlExpiresAt: NOW + 10 },
      { id: "lg", kind: "log", testId: "t1", criterionIds: [], bytes: 1, state: "expired", expiresAt: NOW + 10, path: "l", getUrl: "https://lg", posterUrl: null, urlExpiresAt: null },
      { id: "other", kind: "video", testId: "t9", criterionIds: [], bytes: 1, state: "uploaded", expiresAt: NOW + 10, path: "o", getUrl: "x", posterUrl: null, urlExpiresAt: null },
    ],
    report: {},
  };
  const d = testDetail(view, "t1", NOW)!;
  assert.deepEqual(d.test, { id: "t1", path: "a.spec.ts", level: "e2e", origin: "generated", runner: "playwright", adopted: { prUrl: "u", prNumber: 4, at: 1 } });
  assert.deepEqual(d.criteria, [
    { id: "c1", text: "Checkout works", verdict: "pass", reason: "clicked through" },
    { id: "c2", text: "Tax applied", verdict: "unverifiable", reason: "" },
  ]);
  assert.equal(d.result?.status, "pass");
  assert.deepEqual(d.result?.attempts, [{ n: 1, status: "fail", durationMs: 5, error: "boom" }, { n: 2, status: "pass", durationMs: 7, error: null }]);
  assert.equal(d.recordings.length, 1);
  assert.equal(d.recordings[0].posterUrl, "https://p2");
  assert.equal(d.recordings[0].trace?.getUrl, "https://tr2");
  assert.deepEqual(d.others.map((o) => [o.kind, o.getUrl, o.expired]), [["log", null, true], ["trace", "https://tr2", false]]);
  assert.equal(soonestEvidenceExpiry(d), NOW + 10, "the expired log is ignored");
  assert.equal(soonestEvidenceExpiry({ recordings: [], others: [{ artifactId: "x", kind: "log", attempt: null, getUrl: null, expiresAt: NOW - 1, expired: true }] }), null);
  assert.equal(testDetail(view, "t9", NOW), null, "a test not in the plan has no detail");
  assert.equal(testDetail(null, "t1", NOW), null);
});

const setupEntry = (over: Partial<BrowserSetupEntry> & { repoId: string }): BrowserSetupEntry => ({
  repo: `acme/${over.repoId}`,
  status: "not_configured",
  missing: ["start", "url"],
  lastBrowserless: { count: 3, reason: "not_configured", runId: "run1", prNumber: 7, at: 100 },
  fixUrl: `https://app.devasign.test/workflow?repo=${over.repoId}&setup=browser`,
  ...over,
});

test("browserBanner: nothing to flag gives no banner", () => {
  assert.equal(browserBanner(undefined), null);
  assert.equal(browserBanner([]), null);
  assert.equal(
    browserBanner([
      setupEntry({ repoId: "fine", status: "unproven", lastBrowserless: null }),
      setupEntry({ repoId: "fixed", status: "unproven" }),
      setupEntry({ repoId: "off", status: "disabled" }),
      setupEntry({ repoId: "quiet", lastBrowserless: null }),
    ]),
    null,
    "configured, disabled, or never checked without a browser"
  );
});

test("browserBanner names a single repo and links in-app to its setup panel", () => {
  const b = browserBanner([setupEntry({ repoId: "r1" }), setupEntry({ repoId: "ok", status: "unproven", lastBrowserless: null })])!;
  assert.equal(b.text, "UI criteria on acme/r1 were checked without a browser");
  assert.equal(b.action, "set up browser tests");
  assert.equal(b.href, "/workflow?repo=r1&setup=browser");
  assert.deepEqual(b.repos, ["acme/r1"]);
});

test("browserBanner counts several repos and links to the most recent one", () => {
  const b = browserBanner([
    setupEntry({ repoId: "old", lastBrowserless: { count: 1, reason: "not_configured", runId: "a", prNumber: 1, at: 10 } }),
    setupEntry({ repoId: "new", status: "failing", lastBrowserless: { count: 2, reason: "did_not_start", runId: "b", prNumber: 2, at: 50 } }),
  ])!;
  assert.equal(b.text, "UI criteria on 2 repositories were checked without a browser");
  assert.equal(b.action, "set up browser tests", "mixed reasons use the setup wording");
  assert.equal(b.href, "/workflow?repo=new&setup=browser");
  assert.deepEqual(b.repos, ["acme/new", "acme/old"]);
});

test("browserBanner says the app did not start when every flagged repo is failing", () => {
  const b = browserBanner([setupEntry({ repoId: "r1", status: "failing", lastBrowserless: { count: 1, reason: "did_not_start", runId: "a", prNumber: 4, at: 1 } })])!;
  assert.equal(b.text, "UI criteria on acme/r1 were checked without a browser because the app did not start in CI");
  assert.equal(b.action, "see setup");
});

test("browserBanner flags an outdated runner like a failing app, with its own reason and action", () => {
  const outdated = (repoId: string, at: number, count = 2) => setupEntry({ repoId, status: "runner_outdated", lastBrowserless: { count, reason: "runner_outdated", runId: repoId, prNumber: 5, at } });
  const b = browserBanner([outdated("r1", 1), setupEntry({ repoId: "ok", status: "unproven", lastBrowserless: null })])!;
  assert.equal(b.text, "UI criteria on acme/r1 were checked without a browser because the runner in CI is too old");
  assert.equal(b.action, "update the runner");
  assert.equal(b.href, "/workflow?repo=r1&setup=browser");
  assert.equal(browserBanner([outdated("r1", 1, 0)]), null, "no UI criterion was checked below the browser");

  const both = browserBanner([outdated("r1", 1), outdated("r2", 2)])!;
  assert.equal(both.text, "UI criteria on 2 repositories were checked without a browser because the runner in CI is too old");
  const mixed = browserBanner([outdated("r1", 1), setupEntry({ repoId: "r2", status: "failing", lastBrowserless: { count: 1, reason: "did_not_start", runId: "b", prNumber: 2, at: 50 } })])!;
  assert.deepEqual([mixed.text, mixed.action], ["UI criteria on 2 repositories were checked without a browser", "set up browser tests"]);
});

test("browserBanner never links outside the setup panel", () => {
  assert.equal(browserBanner([setupEntry({ repoId: "r1", fixUrl: "https://evil.test/logout" })])!.href, "/workflow?repo=r1&setup=browser");
  assert.equal(browserBanner([setupEntry({ repoId: "r1", fixUrl: "" })])!.href, "/workflow?repo=r1&setup=browser");
  assert.equal(browserBanner([setupEntry({ repoId: "r 2", fixUrl: "/workflow?repo=r%202&setup=browser" })])!.href, "/workflow?repo=r%202&setup=browser");
});
