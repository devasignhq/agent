// node --test src/verify-setup-view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserTests } from "./api.ts";
import { browserTestsRow, opensBrowserSetup, uiCriteriaCount, withoutBrowserSetup } from "./verify-setup-view.ts";

const bt = (over: Partial<BrowserTests>): BrowserTests => ({
  status: "unknown",
  missing: [],
  lastBrowserless: null,
  fixUrl: "https://app.devasign.test/workflow?repo=r1&setup=browser",
  defaultYml: null,
  ...over,
});
const last = (over: Partial<NonNullable<BrowserTests["lastBrowserless"]>> = {}) => ({ count: 3, reason: "not_configured" as const, runId: "run1", prNumber: 12, at: 1, ...over });

test("uiCriteriaCount pluralises", () => {
  assert.equal(uiCriteriaCount(1), "1 UI criterion");
  assert.equal(uiCriteriaCount(3), "3 UI criteria");
});

test("not_configured names the missing keys and the last browser-less run", () => {
  const row = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "not_configured", missing: ["url"], lastBrowserless: last() }) });
  assert.equal(row.tone, "warn");
  assert.equal(row.text, "Not set up — add verify.start and verify.url to .devasign.yml (missing: verify.url)");
  assert.equal(row.last, "PR #12: 3 UI criteria checked without a browser");
  const bare = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "not_configured" }) });
  assert.equal(bare.text, "Not set up — add verify.start and verify.url to .devasign.yml");
  assert.equal(bare.last, null);
});

test("failing, unproven, disabled and unknown each read differently", () => {
  const failing = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing", lastBrowserless: last({ count: 1, reason: "did_not_start", prNumber: 40 }) }) });
  assert.equal(failing.text, "The app did not start in CI on PR #40");
  assert.equal(failing.last, "PR #40: 1 UI criterion checked without a browser");
  assert.equal(browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing" }) }).text, "The app did not start in CI");
  const ok = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "unproven" }) });
  assert.deepEqual([ok.text, ok.tone], ["Configured", "ok"]);
  const off = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "disabled", lastBrowserless: last() }) });
  assert.deepEqual([off.text, off.tone, off.last], ["Off (e2e: never)", "mute", null], "e2e: never suppresses the browser-less note");
  assert.equal(browserTestsRow({ devasignYml: null, browserTests: bt({}) }).text, "Not checked yet");
});

test("an old backend without browserTests falls back to the yml snapshot", () => {
  assert.equal(browserTestsRow({ devasignYml: { start: "npm start" } }).text, "Not set up — add verify.start and verify.url to .devasign.yml (missing: verify.url)");
  assert.equal(browserTestsRow({ devasignYml: { start: "npm start", url: "http://localhost:3000" } }).text, "Configured");
  assert.equal(browserTestsRow({ devasignYml: { e2e: "never" } }).status, "disabled");
  assert.equal(browserTestsRow({ devasignYml: null }).status, "unknown");
});

test("?setup=browser opens the panel only for the named repo, and closing strips just that param", () => {
  assert.equal(opensBrowserSetup(new URLSearchParams("repo=r1&setup=browser"), "r1"), true);
  assert.equal(opensBrowserSetup(new URLSearchParams("setup=browser"), "r1"), true);
  assert.equal(opensBrowserSetup(new URLSearchParams("repo=r2&setup=browser"), "r1"), false);
  assert.equal(opensBrowserSetup(new URLSearchParams("repo=r1"), "r1"), false);
  assert.equal(opensBrowserSetup(new URLSearchParams("repo=r1&setup=other"), "r1"), false);
  const params = new URLSearchParams("repo=r1&setup=browser");
  assert.equal(withoutBrowserSetup(params).toString(), "repo=r1");
  assert.equal(params.get("setup"), "browser", "the input is not mutated");
});
