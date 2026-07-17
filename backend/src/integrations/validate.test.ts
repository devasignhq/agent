// Tests for the POST /integrations body validator. Offline, pure. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/integrations/validate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntegrationInput } from "./validate.js";

// The three shapes the app actually sends — these MUST keep working, or Settings
// → Integrations breaks. Slack/Discord come from the paste-a-token UI; the Linear
// shapes mirror what the OAuth callback stores.
test("accepts the legitimate slack / discord / linear shapes", () => {
  const slack = parseIntegrationInput({
    type: "slack",
    tokens: { botToken: "xoxb-123" },
    workspaceMeta: { channel: "#pr-reviews" },
  });
  assert.deepEqual(slack, {
    ok: true,
    value: { type: "slack", tokens: { botToken: "xoxb-123" }, workspaceMeta: { channel: "#pr-reviews" } },
  });

  const discord = parseIntegrationInput({
    type: "discord",
    tokens: { botToken: "abc" },
    workspaceMeta: { channelId: "42" },
  });
  assert.equal(discord.ok, true);

  // Linear, both credential forms (OAuth accessToken, personal apiKey).
  assert.equal(parseIntegrationInput({ type: "linear", tokens: { accessToken: "lin_oauth" } }).ok, true);
  assert.equal(parseIntegrationInput({ type: "linear", tokens: { apiKey: "lin_pat" } }).ok, true);
});

test("workspaceMeta is optional", () => {
  const r = parseIntegrationInput({ type: "slack", tokens: { botToken: "x" } });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.workspaceMeta, {});
});

test("rejects an off-taxonomy type", () => {
  for (const type of ["github", "__proto__", "", "SLACK", 42, null, undefined]) {
    const r = parseIntegrationInput({ type, tokens: { botToken: "x" } });
    assert.deepEqual(r, { ok: false, error: "unsupported_integration_type" }, `type=${String(type)}`);
  }
});

test("rejects a non-object or missing tokens payload", () => {
  for (const tokens of [undefined, null, "xoxb-raw-string", 123, ["botToken"], true]) {
    const r = parseIntegrationInput({ type: "slack", tokens });
    assert.equal(r.ok, false, `tokens=${JSON.stringify(tokens)}`);
    if (!r.ok) assert.equal(r.error, "invalid_tokens");
  }
});

test("rejects non-string token values (the Bearer [object Object] case)", () => {
  const r = parseIntegrationInput({ type: "linear", tokens: { accessToken: { nested: "obj" } } });
  assert.deepEqual(r, { ok: false, error: "invalid_tokens" });
});

test("rejects when the type's credential is absent or blank", () => {
  // slack needs botToken, not accessToken.
  assert.deepEqual(parseIntegrationInput({ type: "slack", tokens: { accessToken: "x" } }), {
    ok: false,
    error: "missing_credential",
  });
  // present but empty / whitespace is not a credential.
  assert.deepEqual(parseIntegrationInput({ type: "slack", tokens: { botToken: "   " } }), {
    ok: false,
    error: "missing_credential",
  });
});

test("rejects an over-long token value", () => {
  const r = parseIntegrationInput({ type: "slack", tokens: { botToken: "a".repeat(8193) } });
  assert.deepEqual(r, { ok: false, error: "invalid_tokens" });
});

test("sanitizes workspaceMeta: drops non-strings, caps value length, skips unsafe keys", () => {
  const r = parseIntegrationInput({
    type: "slack",
    tokens: { botToken: "x" },
    workspaceMeta: {
      channel: "#ok",
      bad: { deep: 1 }, // non-string → dropped
      n: 5, // non-string → dropped
      long: "y".repeat(2000), // capped to 1024
      __proto__: "polluted", // unsafe key → skipped
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.workspaceMeta.channel, "#ok");
    assert.equal("bad" in r.value.workspaceMeta, false);
    assert.equal("n" in r.value.workspaceMeta, false);
    assert.equal(r.value.workspaceMeta.long.length, 1024);
    // prototype is untouched — no pollution from the __proto__ key.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  }
});

test("caps the number of workspaceMeta fields", () => {
  const meta: Record<string, string> = {};
  for (let i = 0; i < 50; i++) meta[`k${i}`] = "v";
  const r = parseIntegrationInput({ type: "slack", tokens: { botToken: "x" }, workspaceMeta: meta });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(Object.keys(r.value.workspaceMeta).length, 16);
});

test("a non-object body is rejected, not thrown", () => {
  for (const body of [undefined, null, "x", 42, []]) {
    const r = parseIntegrationInput(body);
    assert.equal(r.ok, false, `body=${JSON.stringify(body)}`);
  }
});
