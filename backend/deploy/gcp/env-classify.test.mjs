import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_KEYS, classify, isSkipped, parseEnvText } from "./env-classify.mjs";

test("parseEnvText handles export, quotes, inline comments, and = inside values", () => {
  const vars = parseEnvText(
    [
      "# a comment",
      "",
      "export WEB_ORIGIN=https://app.example.com",
      'SESSION_SECRET="has # hash"',
      "GITHUB_APP_NAME='devasign-agent'",
      "STRIPE_PRICE_PRO=price_123   # trailing note",
      "DATABASE_URL=postgres://u:p@h/db?sslmode=require&x=1",
      "GITHUB_APP_PRIVATE_KEY=-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
      "EMPTY=",
      "not a var line",
    ].join("\r\n")
  );
  assert.deepEqual(Object.fromEntries(vars), {
    WEB_ORIGIN: "https://app.example.com",
    SESSION_SECRET: "has # hash",
    GITHUB_APP_NAME: "devasign-agent",
    STRIPE_PRICE_PRO: "price_123",
    DATABASE_URL: "postgres://u:p@h/db?sslmode=require&x=1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    EMPTY: "",
  });
});

test("isSkipped drops host-specific variables only", () => {
  for (const k of ["PORT", "WEB_CONCURRENCY", "RENDER", "RENDER_SERVICE_ID", "GITHUB_APP_PRIVATE_KEY_PATH"]) {
    assert.equal(isSkipped(k), true, k);
  }
  for (const k of ["WEB_ORIGIN", "DATABASE_URL", "GITHUB_APP_PRIVATE_KEY", "API_ORIGIN"]) {
    assert.equal(isSkipped(k), false, k);
  }
});

test("classify routes secrets, plain, skipped, and empty values, and reports missing required keys", () => {
  const result = classify(
    new Map([
      ["WEB_ORIGIN", "https://app.example.com"],
      ["DATABASE_URL", "postgres://x"],
      ["STRIPE_SECRET_KEY", "sk_live_x"],
      ["PORT", "10000"],
      ["RESEND_API_KEY", ""],
      ["ANTHROPIC_MODEL", "claude"],
    ])
  );
  assert.deepEqual(result.secrets, ["DATABASE_URL", "STRIPE_SECRET_KEY"]);
  assert.deepEqual(result.plain, ["ANTHROPIC_MODEL", "WEB_ORIGIN"]);
  assert.deepEqual(result.skipped, ["PORT"]);
  assert.deepEqual(result.empty, ["RESEND_API_KEY"]);
  assert.deepEqual(result.missing, ["SESSION_SECRET", "INTEGRATION_ENCRYPTION_KEY", "GITHUB_APP_NAME"]);
});

// A secret the backend starts reading must be added to SECRET_KEYS, or it would be written to the plaintext YAML.
test("every secret-looking variable the backend reads is classified as a secret", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const files = readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const names = new Set();
  for (const f of files) {
    for (const m of readFileSync(path.join(src, f), "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  }
  assert.ok(names.size > 20, `expected to find the backend's env vars, found ${names.size}`);
  const secretLooking = /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|ENCRYPTION_KEY|DATABASE_URL/;
  const leaked = [...names].filter((n) => secretLooking.test(n) && !isSkipped(n) && !SECRET_KEYS.has(n));
  assert.deepEqual(leaked, []);
});
