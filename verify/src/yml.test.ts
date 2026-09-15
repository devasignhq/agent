// node --import tsx/esm --test src/yml.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOT_TIMEOUT, MAX_SERVERS, mergeBootConfig, needsManagedBoot, normalizeVerify, RESERVED_SERVER_NAMES } from "./yml.js";
import type { DevasignVerifyConfig } from "./types.js";

const planCfg: DevasignVerifyConfig = {
  e2e: "always",
  install: "npm ci --prefix frontend",
  start: "npm --prefix frontend run dev",
  url: "http://localhost:5173",
  ready: "/healthz",
  timeout: 300,
  servers: [{ name: "api", start: "npm --prefix backend start", url: "http://localhost:8787" }],
  login: { script: "node scripts/devasign-login.mjs", check: "http://localhost:8787/api/me" },
  env: ["PLAN_ONLY"],
};

test("a checkout without a verify block boots from the plan's block whole", () => {
  assert.equal(mergeBootConfig(null, planCfg), planCfg);
  assert.equal(mergeBootConfig(null, undefined), null);
  assert.equal(mergeBootConfig(null, null), null);
});

test("a checkout block with start keeps every key of its own and none of the plan's", () => {
  const checkout: DevasignVerifyConfig = { start: "npm start", url: "http://localhost:3000", e2e: "auto" };
  assert.equal(mergeBootConfig(checkout, planCfg), checkout);
  assert.equal(mergeBootConfig(checkout, undefined), checkout);
});

test("a checkout block without start takes the whole boot group from the plan and keeps its other keys", () => {
  const checkout: DevasignVerifyConfig = {
    e2e: "never",
    env: ["CHECKOUT_SECRET"],
    services: [{ name: "postgres" }],
    install: "npm ci",
    login: { script: "node stale-login.mjs" },
    url: "http://localhost:9999",
  };
  const merged = mergeBootConfig(checkout, planCfg)!;
  assert.deepEqual(merged, {
    e2e: "never",
    env: ["CHECKOUT_SECRET"],
    services: [{ name: "postgres" }],
    install: "npm ci --prefix frontend",
    start: "npm --prefix frontend run dev",
    url: "http://localhost:5173",
    ready: "/healthz",
    timeout: 300,
    servers: planCfg.servers,
    login: planCfg.login,
  });
  assert.equal(checkout.install, "npm ci", "the checkout's block is not mutated");
});

test("when neither block has start, the checkout's block stands as it is", () => {
  const checkout: DevasignVerifyConfig = { e2e: "auto", login: { script: "node login.mjs" } };
  const { start: _start, ...planWithoutStart } = planCfg;
  assert.equal(mergeBootConfig(checkout, planWithoutStart), checkout);
});

// Mirrored in backend/src/verify/detect.test.ts; the two normalizers must agree case for case.
test("normalizeVerify bounds timeout, keeps valid distinct servers up to the cap, and reads a login script without a strategy", () => {
  const cfg = normalizeVerify({
    start: "npm run dev",
    url: "http://localhost:5173",
    timeout: 5000,
    servers: [
      { name: "api", start: "npm start", url: "http://localhost:8787", ready: "/health" },
      { name: "API", start: "a", url: "http://localhost:1" },
      { name: "-api", start: "a", url: "http://localhost:1" },
      { name: "api", start: "dup", url: "http://localhost:2" },
      { name: "worker", start: "npm run worker" },
      "redis",
      { name: "w1", start: "b", url: "http://localhost:3" },
      { name: "w2", start: "c", url: "http://localhost:4" },
      { name: "w3", start: "d", url: "http://localhost:5" },
      { name: "w4", start: "e", url: "http://localhost:6" },
    ],
    login: { script: "node scripts/devasign-login.mjs", check: "/api/me", strategy: "magic" },
  });
  assert.equal(cfg?.timeout, BOOT_TIMEOUT.max);
  assert.deepEqual(cfg?.servers?.map((s) => s.name), ["api", "w1", "w2", "w3"]);
  assert.equal(cfg?.servers?.length, MAX_SERVERS);
  assert.deepEqual(cfg?.servers?.[0], { name: "api", start: "npm start", url: "http://localhost:8787", ready: "/health" });
  assert.deepEqual(cfg?.login, { script: "node scripts/devasign-login.mjs", check: "/api/me" });
  assert.equal(needsManagedBoot(cfg), true);

  assert.equal(normalizeVerify({ timeout: 1 })?.timeout, BOOT_TIMEOUT.min);
  assert.equal(normalizeVerify({ timeout: 12.5 })?.timeout, undefined);
  assert.equal(normalizeVerify({ timeout: "60" })?.timeout, undefined);
  assert.deepEqual(normalizeVerify({ login: { strategy: "none" } })?.login, { strategy: "none" });
  assert.deepEqual(normalizeVerify({ login: {}, servers: [{ name: "Bad!", start: "x", url: "y" }] }), {});
  assert.equal(normalizeVerify(["verify"]), null);
  assert.equal(needsManagedBoot(normalizeVerify({ login: { check: "/api/me", strategy: "cookie" } })), false, "a check alone boots nothing");
  assert.equal(needsManagedBoot({ start: "npm start", url: "http://localhost:3000" }), false);
  assert.equal(needsManagedBoot(normalizeVerify({ login: { script: "node login.mjs" } })), true);
});

test("normalizeVerify runs long commands exactly as merged and refuses server names the boot's own steps use", () => {
  const long = `npm ci --prefix frontend && ${"npm ci --prefix packages/some-workspace && ".repeat(12)}npm run build --workspace contrib`;
  assert.ok(long.length > 540);
  const cfg = normalizeVerify({
    install: long,
    start: long,
    url: "http://localhost:5173",
    servers: [
      ...[...RESERVED_SERVER_NAMES].map((name) => ({ name, start: "node api.mjs", url: "http://localhost:8787" })),
      { name: "a".repeat(33), start: "node x.mjs", url: "http://localhost:1" },
      { name: "api", start: long, url: "http://localhost:8787" },
    ],
    login: { script: long },
  });
  assert.equal(cfg?.install, long);
  assert.equal(cfg?.start, long);
  assert.equal(cfg?.login?.script, long);
  assert.deepEqual(cfg?.servers, [{ name: "api", start: long, url: "http://localhost:8787" }], "a reserved or over-long name is dropped, never cut to fit");
  assert.deepEqual([...RESERVED_SERVER_NAMES].sort(), ["app", "build", "install", "login", "seed"]);
});
