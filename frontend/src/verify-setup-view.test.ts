// node --test src/verify-setup-view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserTests, LastBrowserless, VerifySetup } from "./api.ts";
import type { BootCheckSetup } from "./verify-setup-view.ts";
import { BOOT_CHECK_ASK_FAILED, bootCheckStarted, bootCheckView, browserTestsRow, opensBrowserSetup, uiCriteriaCount, withoutBrowserSetup } from "./verify-setup-view.ts";

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
  assert.equal(browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing" }) }).text, "Browser tests could not run", "with no run to blame the boot, the weaker claim");
  const ok = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "unproven" }) });
  assert.deepEqual([ok.text, ok.tone], ["Configured", "ok"]);
  const off = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "disabled", lastBrowserless: last() }) });
  assert.deepEqual([off.text, off.tone, off.last], ["Off (e2e: never)", "mute", null], "e2e: never suppresses the browser-less note");
  assert.equal(browserTestsRow({ devasignYml: null, browserTests: bt({}) }).text, "Not checked yet");
});

test("a failing run says which of the two happened, with or without a PR number", () => {
  const failing = (over: Partial<NonNullable<BrowserTests["lastBrowserless"]>>) =>
    browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing", lastBrowserless: last(over) }) }).text;
  assert.equal(failing({ reason: "did_not_start", prNumber: 40 }), "The app did not start in CI on PR #40");
  assert.equal(failing({ reason: "did_not_start", prNumber: 0 }), "The app did not start in CI");
  assert.equal(failing({ reason: "browser_errored", prNumber: 40 }), "Browser tests could not run on PR #40");
  assert.equal(failing({ reason: "browser_errored", prNumber: 0 }), "Browser tests could not run");
  assert.doesNotMatch(failing({ reason: "browser_errored", prNumber: 40 }), /did not start/, "the boot is not blamed once the browser tests ran");
  // Only a run that said the app never came up blames the boot: a reason this build does not know must not.
  assert.equal(failing({ reason: "added_later" as LastBrowserless["reason"], prNumber: 40 }), "Browser tests could not run on PR #40");
});

test("runner_outdated asks for a newer runner and still names the last browser-less run", () => {
  const row = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "runner_outdated", lastBrowserless: last({ reason: "runner_outdated", prNumber: 51 }) }) });
  assert.deepEqual([row.text, row.tone], ["The runner in CI is too old for verify.servers or verify.login — update @devasign/verify", "warn"]);
  assert.equal(row.last, "PR #51: 3 UI criteria checked without a browser");
  assert.equal(browserTestsRow({ devasignYml: null, browserTests: bt({ status: "runner_outdated", lastBrowserless: last({ reason: "runner_outdated", count: 0 }) }) }).last, null, "nothing was checked below the browser either");
  assert.doesNotMatch(browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing", lastBrowserless: last({ reason: "did_not_start" }) }) }).text, /too old/);
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

const boot = { start: "npm --prefix frontend run dev -- --port 3001", url: "http://localhost:3001", servers: [{ name: "backend" }] };

test("a configured repo shows the command and url CI boots, with its servers", () => {
  const row = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "unproven", defaultYml: boot }) });
  assert.deepEqual(row.boot, { start: boot.start, url: boot.url, servers: ["backend"] });
  const failing = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "failing", defaultYml: boot }) });
  assert.deepEqual(failing.boot?.servers, ["backend"], "a boot that failed in CI is the one worth showing");
  const noServers = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "unproven", defaultYml: { start: boot.start, url: boot.url } }) });
  assert.deepEqual(noServers.boot?.servers, []);
});

test("proven says the app came up in CI, and where", () => {
  const row = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "proven", defaultYml: boot }) });
  assert.deepEqual([row.text, row.tone], ["Working — the app came up at http://localhost:3001 in CI", "ok"]);
  assert.deepEqual(row.boot, { start: boot.start, url: boot.url, servers: ["backend"] }, "the proven boot is still worth showing");
  const noUrl = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "proven" }) });
  assert.deepEqual([noUrl.text, noUrl.tone], ["Working — the app came up in CI", "ok"]);
  const stillNoting = browserTestsRow({ devasignYml: null, browserTests: bt({ status: "proven", defaultYml: boot, lastBrowserless: last({ count: 2, prNumber: 8 }) }) });
  assert.equal(stillNoting.last, "PR #8: 2 UI criteria checked without a browser", "an older browser-less run is still reported");
});

test("a probe that could not boot the app is never a green row", () => {
  const probe = (over: Partial<NonNullable<VerifySetup["boot"]>>): NonNullable<VerifySetup["boot"]> => ({
    ok: false, prNumber: 7, sha: "abc", at: 2, signedIn: null, logUrl: null, screenshotUrl: null, urlExpiresAt: null, ...over,
  });
  const failed = bt({ status: "boot_failed", defaultYml: boot });
  const page = browserTestsRow({ devasignYml: null, browserTests: failed, boot: probe({ stage: "page" }) });
  assert.deepEqual([page.text, page.tone], ["The app came up in CI, but its page did not load", "warn"]);
  const servers = browserTestsRow({ devasignYml: null, browserTests: failed, boot: probe({ stage: "servers", failedServer: "backend" }) });
  assert.deepEqual([servers.text, servers.tone], ["The app did not start in CI — the backend server never came up", "warn"]);
  const login = browserTestsRow({ devasignYml: null, browserTests: failed, boot: probe({ stage: "login" }) });
  assert.equal(login.text, "The app came up in CI, but DevAsign could not sign in");
  const noDetail = browserTestsRow({ devasignYml: null, browserTests: failed });
  assert.deepEqual([noDetail.text, noDetail.tone], ["The app did not start in CI", "warn"]);
  assert.deepEqual(page.boot, { start: boot.start, url: boot.url, servers: ["backend"] }, "the boot that failed is worth showing");
});

test("nothing to boot, nothing to show", () => {
  const cases: Array<[string, BrowserTests]> = [
    ["not set up", bt({ status: "not_configured", missing: ["start", "url"], defaultYml: { e2e: "auto" } })],
    ["off", bt({ status: "disabled", defaultYml: { e2e: "never", ...boot } })],
    ["no snapshot yet", bt({ status: "unknown" })],
    ["half a block", bt({ status: "unproven", defaultYml: { start: boot.start } })],
  ];
  for (const [name, browserTests] of cases) assert.equal(browserTestsRow({ devasignYml: null, browserTests }).boot, null, name);
  assert.equal(browserTestsRow({ devasignYml: { start: boot.start, url: boot.url }, browserTests: undefined }).boot, null, "an old backend sends no block to show");
});

const bootProbe = (over: Partial<NonNullable<VerifySetup["boot"]>> = {}): NonNullable<VerifySetup["boot"]> => ({
  ok: true, prNumber: 7, sha: "abc1234def", at: 1000, signedIn: null, logUrl: null, screenshotUrl: null, urlExpiresAt: null, ...over,
});
const payload = (over: Partial<BootCheckSetup>): BootCheckSetup => ({
  browserTests: undefined, devasignYml: null, boot: null, probeUnavailable: null, bootCheck: undefined, onboarding: { state: "none" }, ...over,
});
const asked = (over: Partial<NonNullable<BootCheckSetup["onboarding"]["bootCheck"]>> = {}) => ({ at: 10_000, probeId: "p1", dispatched: true, ...over });

test("the re-check is offered when the backend says so, and says why in words when it doesn't", () => {
  const first = bootCheckView(payload({ bootCheck: { available: true } }), 2000);
  assert.deepEqual(first.button, { label: "Check boot now" }, "nothing has probed this repo yet, so there is nothing to re-check");
  assert.deepEqual([first.note, first.evidence], [null, null]);
  assert.equal(bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe() }), 2000).button?.label, "Re-check boot");
  const off = bootCheckView(payload({ bootCheck: { available: false, reason: "no_setup_pr" } }), 2000);
  assert.equal(off.button, null, "a dead button would be worse than a sentence");
  assert.equal(off.note, "DevAsign has not set this repo up yet — open the setup PR first", "the backend's code is never shown raw");
  assert.equal(bootCheckView(payload({ bootCheck: { available: false, reason: "dispatch_failed" } }), 2000).note, "GitHub would not start the check — the workflow needs a repository_dispatch trigger");
  const unknown = bootCheckView(payload({ bootCheck: { available: false, reason: "invented_later" } }), 2000);
  assert.equal(unknown.note, "DevAsign cannot re-check this repo's boot right now", "a code this build does not know still reads as a sentence");
  assert.equal(bootCheckView(payload({ bootCheck: { available: false } }), 2000).note, "DevAsign cannot re-check this repo's boot right now");
  assert.deepEqual(bootCheckView(payload({}), 2000), { evidence: null, button: null, note: null }, "a backend that never heard of re-checks offers nothing");
});

test("every reason the backend can refuse a check with reads as a sentence about this repo", () => {
  const say = (reason: string) => bootCheckView(payload({ bootCheck: { available: false, reason } }), 2000).note;
  assert.equal(say("setup_pr_open"), "The setup PR is still open — its own CI is what proves the config it proposes");
  assert.match(say("not_dispatchable")!, /no repository_dispatch trigger/);
  assert.equal(say("requested"), "DevAsign asked CI to boot the app — nothing has picked it up yet");
  assert.notEqual(say("requested"), say("pending"), "a request nothing picked up is not a run that is going");
  assert.equal(say("cooldown"), "A check was just asked for — try again in a minute");
  assert.equal(say("rate_limited"), "This repo has used its boot checks for today — try again tomorrow");
});

test("only the check's own probe answers it: another probe's verdict does not close the request", () => {
  const seen = (boot: Partial<NonNullable<VerifySetup["boot"]>>) =>
    bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe(boot), onboarding: { state: "verified", bootCheck: asked() } }), 12_000);
  const mine = seen({ at: 11_000, probeId: "p1" });
  assert.equal(mine.note, null, "the probe this click dispatched is the one that reported");
  // A setup-PR probe settling in between is newer, but it is not an answer to this click.
  const theirs = seen({ at: 11_000, probeId: "p2", prNumber: 12 });
  assert.equal(theirs.note, "The last check never reported back");
  assert.equal(theirs.evidence?.line, "The app came up in CI · checked on PR #12", "and the line that is shown says whose verdict it is");
});

test("a re-check already in flight does not offer a second one", () => {
  const pending = bootCheckView(payload({ bootCheck: { available: false, reason: "pending" }, boot: bootProbe(), onboarding: { state: "verified", bootCheck: asked() } }), 10_500);
  assert.equal(pending.button, null);
  assert.equal(pending.note, "A check is already running — its result lands here when CI finishes");
  assert.equal(pending.evidence?.line, "The app came up in CI · checked on PR #7", "the check in flight does not erase what the last one found");
});

test("a re-check the backend let through, having recorded a request nothing answered, says so", () => {
  const dangling = bootCheckView(payload({ bootCheck: { available: true }, onboarding: { state: "verified", bootCheck: asked() } }), 10_500);
  assert.deepEqual(dangling.button, { label: "Check boot now" }, "the backend says another check can be asked for, so the button is live");
  assert.equal(dangling.note, "The last check never reported back");
  const answered = bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ at: 10_001 }), onboarding: { state: "verified", bootCheck: asked() } }), 10_500);
  assert.deepEqual([answered.button, answered.note], [{ label: "Re-check boot" }, null], "the probe reported after the request, so there is nothing to explain");
  const older = bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ at: 9_999 }), onboarding: { state: "verified", bootCheck: asked() } }), 10_500);
  assert.equal(older.note, "The last check never reported back", "a probe from before the request is not its answer");
});

test("a re-check that never reached CI says so and lets the maintainer try again", () => {
  const failed = bootCheckView(payload({ bootCheck: { available: true }, onboarding: { state: "verified", bootCheck: asked({ dispatched: false, error: "no verify workflow on the default branch" }) } }), 10_500);
  assert.deepEqual(failed.button, { label: "Check boot now" });
  assert.equal(failed.note, "The last check did not run: no verify workflow on the default branch");
  const quiet = bootCheckView(payload({ bootCheck: { available: true }, onboarding: { state: "verified", bootCheck: asked({ dispatched: false }) } }), 10_500);
  assert.deepEqual([quiet.button, quiet.note], [{ label: "Check boot now" }, "The last check did not reach CI"]);
});

test("the answer to a click is reported even when the request was accepted and dispatched nothing", () => {
  // GitHub accepts a dispatch whether or not any workflow listens for it, so "started" would
  // be a claim the panel cannot make: all DevAsign knows is that it asked.
  assert.equal(bootCheckStarted({ dispatched: true }), "DevAsign asked CI to boot the app — the result lands here when it finishes");
  assert.equal(bootCheckStarted({ dispatched: false, reason: "head_unreadable" }), "Could not start the check: DevAsign could not read the latest commit on the default branch");
  assert.equal(bootCheckStarted({ dispatched: false }), "Could not start the check: DevAsign cannot re-check this repo's boot right now");
  assert.equal(BOOT_CHECK_ASK_FAILED, "Could not ask for the check — try again");
});

test("the probe's account of the boot claims only what it managed", () => {
  const say = (over: Partial<NonNullable<VerifySetup["boot"]>>) => bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe(over) }), 2000).evidence!;
  assert.deepEqual([say({ ok: true, signedIn: true }).line, say({ ok: true, signedIn: true }).tone], ["The app came up in CI and DevAsign signed in · checked on PR #7", "ok"]);
  assert.deepEqual([say({ ok: true, signedIn: false }).line, say({ ok: true, signedIn: false }).tone], ["The app came up in CI, but DevAsign did not sign in · checked on PR #7", "warn"], "a sign-in that did not happen is not a green boot");
  assert.deepEqual([say({ ok: true, signedIn: null }).line, say({ ok: true, signedIn: null }).tone], ["The app came up in CI · checked on PR #7", "ok"]);
  assert.deepEqual([say({ ok: false, signedIn: null, stage: "page" }).line, say({ ok: false, signedIn: null, stage: "page" }).tone], ["The app came up in CI, but its page did not load · checked on PR #7", "warn"]);
  assert.equal(say({ ok: false, signedIn: true, stage: "page" }).tone, "warn", "signing in cannot make a failed boot green");
});

test("a boot that failed never reads as proven", () => {
  const view = bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ ok: false, stage: "servers", failedServer: "backend" }) }), 2000);
  assert.equal(view.evidence?.line, "The app did not start in CI — the backend server never came up · checked on PR #7");
  assert.equal(view.evidence?.tone, "warn");
  assert.doesNotMatch(view.evidence!.line, /signed in|Working/);
  assert.equal(view.button?.label, "Re-check boot", "a failed boot is exactly what a maintainer re-checks");
});

test("the evidence names where the probe ran and links what it kept, until those links expire", () => {
  const kept = bootProbe({ logUrl: "https://r2.test/log.txt", screenshotUrl: "https://r2.test/shot.png", urlExpiresAt: 5000 });
  const fresh = bootCheckView(payload({ bootCheck: { available: true }, boot: kept }), 4999).evidence!;
  assert.match(fresh.line, /checked on PR #7$/);
  assert.deepEqual(fresh.links, [{ label: "boot log", href: "https://r2.test/log.txt" }, { label: "screenshot", href: "https://r2.test/shot.png" }]);
  assert.deepEqual(bootCheckView(payload({ bootCheck: { available: true }, boot: kept }), 5000).evidence!.links, [], "the signed links are only good for the panel that loaded them");
  assert.deepEqual(bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ logUrl: "https://r2.test/log.txt" }) }), 2000).evidence!.links, [{ label: "boot log", href: "https://r2.test/log.txt" }], "a probe that kept no screenshot links none");
  const recheck = bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ prNumber: 0, sha: "0123456789abcdef" }) }), 2000).evidence!;
  assert.equal(recheck.line, "The app came up in CI · checked on 0123456", "a re-check runs on the default branch, not a PR");
  assert.equal(bootCheckView(payload({ bootCheck: { available: true }, boot: bootProbe({ prNumber: 0, sha: "" }) }), 2000).evidence!.line, "The app came up in CI", "nothing to name, nothing to append");
});

test("the evidence line never repeats the Browser tests row it sits under", () => {
  const failed = bootCheckView(payload({ browserTests: bt({ status: "boot_failed", defaultYml: boot }), bootCheck: { available: true }, boot: bootProbe({ ok: false, stage: "servers", failedServer: "backend" }) }), 2000);
  assert.deepEqual([failed.evidence?.line, failed.evidence?.tone], ["Checked on PR #7", "warn"], "the row already blamed the backend server; the provenance is still worth keeping");
  const proven = bootCheckView(payload({ browserTests: bt({ status: "proven", defaultYml: boot }), bootCheck: { available: true }, boot: bootProbe({ ok: true, signedIn: null }) }), 2000);
  assert.equal(proven.evidence?.line, "Checked on PR #7", "the row already says the app came up");
  assert.equal(bootCheckView(payload({ browserTests: bt({ status: "proven" }), bootCheck: { available: true }, boot: bootProbe({ ok: true, signedIn: null, prNumber: 0, sha: "" }) }), 2000).evidence, null, "nothing left to add to the row");
  const signedIn = bootCheckView(payload({ browserTests: bt({ status: "proven", defaultYml: boot }), bootCheck: { available: true }, boot: bootProbe({ ok: true, signedIn: true }) }), 2000);
  assert.equal(signedIn.evidence?.line, "The app came up in CI and DevAsign signed in · checked on PR #7", "the sign-in is news the row does not carry");
});

test("with nothing probed yet, an old runner in CI is the thing worth saying", () => {
  const view = bootCheckView(payload({ bootCheck: { available: true }, probeUnavailable: { cliVersion: "1.5.1", at: 5 } }), 2000);
  assert.deepEqual([view.evidence?.line, view.evidence?.tone], ["The runner in CI (@devasign/verify 1.5.1) is too old to check the boot — update it", "warn"]);
  assert.deepEqual(view.evidence?.links, []);
  assert.equal(view.button?.label, "Check boot now");
  assert.equal(bootCheckView(payload({ probeUnavailable: { cliVersion: "", at: 5 } }), 2000).evidence?.line, "The runner in CI is too old to check the boot — update @devasign/verify");
  assert.equal(bootCheckView(payload({ boot: bootProbe(), probeUnavailable: { cliVersion: "1.5.1", at: 5 } }), 2000).evidence?.line, "The app came up in CI · checked on PR #7", "a real result outranks a note about an old runner");
});
