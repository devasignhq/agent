// DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/repo-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bootHash, browserTestsStatus } from "./repo-state.js";
import type { RepoVerifyState } from "../types.js";
import type { DevasignVerifyConfig } from "./contract.js";

const last = (reason: NonNullable<RepoVerifyState["lastBrowserless"]>["reason"]) => ({ count: 2, reason, runId: "run1", prNumber: 9, at: 1 });
const state = (parsed: DevasignVerifyConfig | null, lastBrowserless: RepoVerifyState["lastBrowserless"] = null, withSnapshot = true): RepoVerifyState => ({
  onboarding: { state: "none" },
  ...(withSnapshot ? { defaultYml: { sha: "abc", parsed, bootHash: null, at: 1 } } : {}),
  lastBrowserless,
});
const booted = { start: "npm start", url: "http://localhost:3000" };

test("an outdated runner outranks unproven, but never e2e: never or missing boot keys", () => {
  assert.deepEqual(browserTestsStatus(state(booted, last("runner_outdated"))), { status: "runner_outdated", missing: [] });
  assert.equal(browserTestsStatus(state({ ...booted, servers: [{ name: "api", start: "npm run api", url: "http://localhost:4000" }] }, last("runner_outdated"))).status, "runner_outdated");
  assert.equal(browserTestsStatus(state({ ...booted, e2e: "never" }, last("runner_outdated"))).status, "disabled");
  assert.deepEqual(browserTestsStatus(state({ start: "npm start" }, last("runner_outdated"))), { status: "not_configured", missing: ["url"] });
  assert.equal(browserTestsStatus(state(booted)).status, "unproven");
  assert.equal(browserTestsStatus(state(booted, last("did_not_start"))).status, "failing");
  assert.equal(browserTestsStatus(state(booted, last("browser_errored"))).status, "failing", "browser tests that decided nothing are failing too");
  assert.equal(browserTestsStatus(state(booted, last("not_configured"))).status, "unproven", "a stale not-configured flag after boot keys merged");
});

test("without a default-branch snapshot the last run decides, runner_outdated included", () => {
  assert.equal(browserTestsStatus(state(null, last("runner_outdated"), false)).status, "runner_outdated");
  assert.equal(browserTestsStatus(state(null, last("did_not_start"), false)).status, "failing");
  assert.equal(browserTestsStatus(state(null, last("browser_errored"), false)).status, "failing");
  assert.equal(browserTestsStatus(state(null, null, false)).status, "unknown");
  assert.equal(browserTestsStatus(null).status, "unknown");
});

const probed = (parsed: DevasignVerifyConfig, boot: Partial<NonNullable<RepoVerifyState["boot"]>> = {}, lastBrowserless: RepoVerifyState["lastBrowserless"] = null): RepoVerifyState => ({
  onboarding: { state: "pr_merged" },
  defaultYml: { sha: "abc", parsed, bootHash: bootHash(parsed), at: 10 },
  lastBrowserless,
  boot: { ok: true, configHash: bootHash(parsed)!, configSha: "def", prNumber: 7, sha: "def", at: 100, stage: "done", signedIn: null, probeId: "p1", ...boot },
});

test("a probe is only about the config it read, at the commit it booted", () => {
  assert.equal(browserTestsStatus(probed(booted, { configSha: null })).status, "unproven", "the App could not read the setup PR's head");
  assert.equal(browserTestsStatus(probed(booted, { configSha: "other" })).status, "unproven", "the yml was read at a commit the runner did not boot");
  assert.equal(browserTestsStatus(probed(booted, { configSha: "DEF" })).status, "proven", "the same sha in another case is the same sha");
});

test("a probe that could not boot the current config is not a configured setup", () => {
  assert.equal(browserTestsStatus(probed(booted, { ok: false, stage: "page" })).status, "boot_failed");
  assert.equal(browserTestsStatus(probed(booted, { ok: false, configHash: "0000000000000000" })).status, "unproven", "a failure about some other config says nothing about this one");
});

test("a boot probe proves the setup only for the config it booted", () => {
  assert.equal(browserTestsStatus(probed(booted)).status, "proven");
  assert.equal(browserTestsStatus(probed(booted, { ok: false })).status, "boot_failed", "a probe that failed proves nothing, and says so");
  assert.equal(browserTestsStatus(probed(booted, { configHash: "0000000000000000" })).status, "unproven", "the yml moved under the probe");
  assert.equal(browserTestsStatus(probed({ ...booted, start: "npm run dev" })).status, "proven", "and a re-probe of the new yml proves it again");
  const unhashed = { ...probed(booted, { configHash: "" }), defaultYml: { sha: "abc", parsed: booted, bootHash: "", at: 10 } };
  assert.equal(browserTestsStatus(unhashed).status, "unproven", "two configs with nothing to boot are not the same proven config");
});

test("only a session check that answered wrong unproves a boot that came up", () => {
  const withLogin = { ...booted, login: { script: "node ./scripts/devasign-login.mjs" } };
  // The generated setup PR writes login.script with no check, so nothing can ever set signedIn:
  // a boot that came up already ran that script, so it must still count as proven.
  assert.equal(browserTestsStatus(probed(withLogin)).status, "proven", "a login with no check is not a failed login");
  assert.equal(browserTestsStatus(probed(withLogin, { signedIn: false })).status, "unproven");
  assert.equal(browserTestsStatus(probed(withLogin, { signedIn: true })).status, "proven");
  assert.equal(browserTestsStatus(probed({ ...booted, login: { check: "/api/me" } })).status, "proven", "a check with no script signs nothing in");
});

test("a run that failed after the probe outranks it, an older one does not", () => {
  const after = (reason: NonNullable<RepoVerifyState["lastBrowserless"]>["reason"], at: number) => ({ count: 1, reason, runId: "r", prNumber: 9, at });
  assert.equal(browserTestsStatus(probed(booted, {}, after("did_not_start", 200))).status, "failing");
  assert.equal(browserTestsStatus(probed(booted, {}, after("browser_errored", 100))).status, "failing", "same instant, the run is the later word");
  assert.equal(browserTestsStatus(probed(booted, {}, after("runner_outdated", 200))).status, "runner_outdated");
  assert.equal(browserTestsStatus(probed(booted, {}, after("did_not_start", 99))).status, "proven", "the probe fixed what that run hit");
  assert.equal(browserTestsStatus(probed(booted, {}, after("not_configured", 200))).status, "proven", "a stale not-configured flag is not a failure");
  assert.equal(browserTestsStatus(probed(booted, { ok: false }, after("did_not_start", 99))).status, "failing", "an unproven probe leaves the old failure standing");
  assert.equal(browserTestsStatus(probed({ ...booted, e2e: "never" }, {}, after("did_not_start", 200))).status, "disabled");
});

test("a re-run of the same config is not evidence that an older failure was fixed", () => {
  const sameConfig = { count: 1, reason: "did_not_start" as const, runId: "r", prNumber: 42, at: 99, bootHash: bootHash(booted) };
  assert.equal(browserTestsStatus(probed(booted, {}, sameConfig)).status, "failing", "the probe booted the very config that failed");
  assert.equal(browserTestsStatus(probed(booted, {}, { ...sameConfig, bootHash: "0000000000000000" })).status, "proven", "a probe of a different config did fix it");
  assert.equal(browserTestsStatus(probed(booted, {}, { ...sameConfig, reason: "not_configured" })).status, "proven", "a stale not-configured flag is still not a failure");
});

test("a deliberate re-check of the current config can clear a failure the setup PR's own CI left", () => {
  // judge.ts stamps the failure with the default branch's bootHash and a re-check boots that
  // same yml, so on an unchanged repo they ALWAYS match and the failure would never clear.
  const failure = { count: 1, reason: "did_not_start" as const, runId: "r", prNumber: 12, at: 1_000, bootHash: bootHash(booted) };
  const recheck = { kind: "recheck" as const, prNumber: 0, at: 9_000 };
  assert.equal(browserTestsStatus(probed(booted, recheck, failure)).status, "proven", "the maintainer booted the current config and it came up");
  assert.equal(browserTestsStatus(probed(booted, { ...recheck, ok: false }, failure)).status, "failing", "a re-check that did not come up leaves the failure standing");
  assert.equal(browserTestsStatus(probed(booted, { ...recheck, at: 999 }, failure)).status, "failing", "a re-check older than the failure proves nothing about it");
  assert.equal(browserTestsStatus(probed(booted, { ...recheck, kind: "setup_pr" }, failure)).status, "failing", "the setup PR's own re-run of that config still does not");
});

test("bootHash fingerprints every boot key, servers and login included, independent of key order", () => {
  const base = { start: "npm start", url: "http://localhost:3000" };
  // Hashes stored before servers/login existed must not change for start/url-only configs.
  const legacy = createHash("sha256").update(JSON.stringify([["start", base.start], ["url", base.url]])).digest("hex").slice(0, 16);
  assert.equal(bootHash(base), legacy);
  assert.equal(bootHash({ ...base, e2e: "always", env: ["X"] }), legacy, "non-boot keys do not count");
  const api = { name: "api", start: "npm run api", url: "http://localhost:4000" };
  const variants = [
    { ...base, timeout: 300 },
    { ...base, servers: [api] },
    { ...base, servers: [{ ...api, ready: "/health" }] },
    { ...base, login: { script: "node login.mjs" } },
    { ...base, login: { script: "node login.mjs", check: "/api/me" } },
  ];
  const hashes = variants.map(bootHash);
  assert.equal(new Set([legacy, ...hashes]).size, variants.length + 1, "each boot change is a different fingerprint");
  assert.equal(bootHash({ url: base.url, servers: [api], start: base.start }), bootHash({ ...base, servers: [{ url: api.url, start: api.start, name: api.name }] }));
  assert.equal(bootHash({ ...base, login: { check: "/api/me", script: "node login.mjs" } }), hashes[4]);
  assert.equal(bootHash({ servers: [api], url: base.url }), null);
});
