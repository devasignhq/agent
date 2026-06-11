// Token→cost math and the per-job usage scope, offline and deterministic. The
// recordUsage→currentUsage accumulation itself only fires on the live API path
// (no key in tests → no usage recorded), so we test the two exported, pure-ish
// surfaces: estimateCostUsd (the price table + cache multipliers) and the
// withUsage/currentUsage AsyncLocalStorage scope. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/llm-usage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentUsage, estimateCostUsd, withUsage } from "./llm.js";
import { config } from "./config.js";

const M = 1_000_000;
const z = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

// ── estimateCostUsd: base table ──────────────────────────────────────────────
test("opus prices input at $5 / output at $25 per 1M", () => {
  assert.equal(estimateCostUsd("claude-opus-4-8", { ...z, inputTokens: M }), 5);
  assert.equal(estimateCostUsd("claude-opus-4-8", { ...z, outputTokens: M }), 25);
  // opus 4.7 (the default ANTHROPIC_MODEL) is priced the same as 4.8
  assert.equal(estimateCostUsd("claude-opus-4-7", { ...z, inputTokens: M }), 5);
});

test("haiku prices input at $1 / output at $5 per 1M", () => {
  assert.equal(estimateCostUsd("claude-haiku-4-5", { ...z, inputTokens: M }), 1);
  assert.equal(estimateCostUsd("claude-haiku-4-5", { ...z, outputTokens: M }), 5);
});

// ── cache multipliers ────────────────────────────────────────────────────────
test("cache writes bill at 1.25x and cache reads at 0.1x of base input", () => {
  assert.equal(estimateCostUsd("claude-opus-4-8", { ...z, cacheCreationTokens: M }), 6.25); // 5 * 1.25
  assert.equal(estimateCostUsd("claude-opus-4-8", { ...z, cacheReadTokens: M }), 0.5); // 5 * 0.1
});

test("sums every component", () => {
  // input 100k*5 + output 50k*25 + write 200k*5*1.25 + read 400k*5*0.1
  // = 500k + 1.25M + 1.25M + 200k = 3.2M / 1e6 = 3.2
  assert.equal(
    estimateCostUsd("claude-opus-4-8", {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreationTokens: 200_000,
      cacheReadTokens: 400_000,
    }),
    3.2
  );
});

// ── Gemini (config-driven) and unknown models ────────────────────────────────
test("the Gemini model uses the config price, not the Anthropic table", () => {
  assert.equal(
    estimateCostUsd(config.gemini.model, { ...z, inputTokens: M }),
    config.gemini.inputPerMTok
  );
  assert.equal(
    estimateCostUsd(config.gemini.model, { ...z, outputTokens: M }),
    config.gemini.outputPerMTok
  );
});

test("an unpriced model contributes $0 (tokens still counted elsewhere)", () => {
  assert.equal(estimateCostUsd("some-future-model", { ...z, inputTokens: M, outputTokens: M }), 0);
});

// ── withUsage / currentUsage scope ────────────────────────────────────────────
test("currentUsage() is null outside a withUsage scope", () => {
  assert.equal(currentUsage(), null);
});

test("withUsage opens a zeroed scope and returns the callback's value", () => {
  const ret = withUsage(() => {
    assert.deepEqual(currentUsage(), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    });
    return 42;
  });
  assert.equal(ret, 42);
  // …and the scope is gone again once the callback returns.
  assert.equal(currentUsage(), null);
});
