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
