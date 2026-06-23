// Unit tests for buildVulns — the normalizer that turns the security sub-pass's
// (untrusted) LLM output into stored Vulnerability rows. No db / network / LLM.
// Run: node --import tsx/esm --test src/review/indexer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVulns } from "./indexer.js";

test("buildVulns: stamps path/sha/model and keeps a well-formed blocker", () => {
  const out = buildVulns(
    [{ class: "sql-injection", severity: "blocker", symbol: "runQuery", line: 12, concern: "raw query", fixPrompt: "fix it" }],
    "backend/src/db.ts",
    "abc123"
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "backend/src/db.ts");
  assert.equal(out[0].detectedSha, "abc123");
  assert.equal(out[0].severity, "blocker");
  assert.equal(out[0].class, "sql-injection");
  assert.equal(out[0].symbol, "runQuery");
  assert.equal(out[0].line, 12);
  assert.ok(out[0].id && out[0].model);
});

test("buildVulns: coerces any non-'blocker' severity to 'warn'", () => {
  const out = buildVulns(
    [
      { class: "xss", severity: "high", concern: "c1", fixPrompt: "f" }, // junk severity → warn
      { class: "xss", severity: "warn", concern: "c2", fixPrompt: "f" },
    ],
    "f.ts",
    "sha"
  );
  assert.deepEqual(out.map((v) => v.severity), ["warn", "warn"]);
});

test("buildVulns: drops items with an empty/missing concern", () => {
  const out = buildVulns(
    [
      { class: "xss", severity: "warn", concern: "   ", fixPrompt: "f" },
      { class: "xss", severity: "warn", fixPrompt: "f" },
      { class: "xss", severity: "warn", concern: "real", fixPrompt: "f" },
    ],
    "f.ts",
    "sha"
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].concern, "real");
});

test("buildVulns: defaults a missing class and omits absent symbol/line", () => {
  const out = buildVulns([{ severity: "warn", concern: "c", fixPrompt: "f" }], "f.ts", "sha");
  assert.equal(out[0].class, "unspecified");
  assert.equal(out[0].symbol, undefined);
  assert.equal(out[0].line, undefined);
});

test("buildVulns: caps findings at 20 even when the model returns more", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ class: "c", severity: "warn", concern: `c${i}`, fixPrompt: "f" }));
  assert.equal(buildVulns(many, "f.ts", "sha").length, 20);
});

test("buildVulns: non-array input yields an empty list", () => {
  assert.deepEqual(buildVulns(null, "f.ts", "sha"), []);
  assert.deepEqual(buildVulns({}, "f.ts", "sha"), []);
  assert.deepEqual(buildVulns(undefined, "f.ts", "sha"), []);
});
