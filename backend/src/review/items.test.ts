// Pure tests for the item normalizer. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/items.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewItems,
  countByChip,
  itemKey,
  suggestionsForCriterion,
  type ReviewItem,
} from "./items.js";
import type { PriorVerdict } from "./criteria-format.js";
import { EMPTY_HOLISTIC, type HolisticFinding } from "./verdict-types.js";
import type { Criterion } from "../types.js";

const crit = (over: Partial<Criterion> = {}): Criterion => ({
  id: "C1",
  text: "Personal claims succeed when account.id matches the user's githubId.",
  met: false,
  evidence: null,
  ...over,
});

const finding = (over: Partial<HolisticFinding> = {}): HolisticFinding => ({
  path: "src/a.ts",
  concern: "Missing await on flush() — the handler returns before the write lands.",
  severity: "blocker",
  ...over,
});

const build = (over: Partial<Parameters<typeof buildReviewItems>[0]> = {}) =>
  buildReviewItems({
    criteria: [],
    prior: new Map<string, PriorVerdict>(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
    ...over,
  });

const byCategory = (items: ReviewItem[], c: string) => items.filter((i) => i.category === c);

test("each bucket maps to its category and the stage that produced it", () => {
  const items = build({
    holistic: {
      ...EMPTY_HOLISTIC,
      regressions: [finding({ path: "r.ts", concern: "regressed" })],
      criticalErrors: [finding({ path: "c.ts", concern: "critical" })],
      defects: [finding({ path: "d.ts", concern: "defect" })],
      securityFindings: [finding({ path: "s.ts", concern: "sec", securitySeverity: "high" })],
      commitIntentFindings: [finding({ path: "i.ts", concern: "intent", severity: "warn" })],
      deferrals: [finding({ path: "f.ts", concern: "deferred", severity: "warn" })],
      conventionFindings: [finding({ path: "v.ts", concern: "convention", severity: "nit" })],
      docDriftFindings: [finding({ path: "o.ts", concern: "docs", severity: "nit" })],
      crossRepoImpacts: [finding({ path: "x.ts", concern: "breaks sibling", severity: "warn" })],
      parityNotes: [finding({ path: "p.ts", concern: "parity", severity: "nit" })],
    },
  });
  const stageOf = (cat: string) => byCategory(items, cat)[0]?.stage;
  assert.equal(stageOf("regression"), "holistic");
  assert.equal(stageOf("criticalError"), "holistic");
  assert.equal(stageOf("defect"), "defects");
  assert.equal(stageOf("security"), "security");
  assert.equal(stageOf("commitIntent"), "commitIntent");
  assert.equal(stageOf("deferral"), "deferrals");
  assert.equal(stageOf("convention"), "docs");
  assert.equal(stageOf("docDrift"), "docs");
  assert.equal(stageOf("crossRepo"), "crossRepo");
  assert.equal(stageOf("parity"), "crossRepo");
  assert.equal(items.length, 10);
});

test("forced severities survive normalization unchanged", () => {
  const items = build({
    holistic: {
      ...EMPTY_HOLISTIC,
      conventionFindings: [finding({ path: "v.ts", concern: "convention", severity: "nit" })],
      deferrals: [finding({ path: "f.ts", concern: "deferred", severity: "warn" })],
      parityNotes: [finding({ path: "p.ts", concern: "parity", severity: "nit" })],
    },
  });
  assert.equal(byCategory(items, "convention")[0].severity, "nit");
  assert.equal(byCategory(items, "deferral")[0].severity, "warn");
  assert.equal(byCategory(items, "parity")[0].severity, "nit");
});

test("security findings keep their 4-tier severity alongside the legacy one", () => {
  const items = build({
    holistic: {
      ...EMPTY_HOLISTIC,
      securityFindings: [finding({ severity: "blocker", securitySeverity: "critical" })],
    },
  });
  assert.equal(items[0].severity, "blocker");
  assert.equal(items[0].securitySeverity, "critical");
});

test("security findings carry their fix prompt and patch through — full detail inline", () => {
  const items = build({
    holistic: {
      ...EMPTY_HOLISTIC,
      securityFindings: [
        finding({
          securitySeverity: "high",
          fixPrompt: "Fix: escape the identifier\n\nFile: src/a.ts",
          suggestedChange: { path: "src/a.ts", startLine: 4, original: "raw", suggested: "safe" },
        }),
      ],
    },
  });
  assert.equal(items[0].fixPrompt, "Fix: escape the identifier\n\nFile: src/a.ts");
  assert.equal(items[0].suggestedChange?.suggested, "safe");
});

test("pre-existing and resolved security findings never become items", () => {
  const items = build({
    holistic: {
      ...EMPTY_HOLISTIC,
      preexistingVulns: [finding({ path: "old.ts", concern: "latent" })],
      resolvedPreexisting: [finding({ path: "old.ts", concern: "was fixed" })],
      consistencyFindings: [finding({ path: "z.ts", concern: "dead bucket" })],
    },
  });
  assert.deepEqual(items, []);
});

test("criteria split into regressed / unmet / met with the right score kinds", () => {
  const criteria = [
    crit({ id: "1", met: false }),
    crit({ id: "2", met: false }),
    crit({ id: "3", met: true }),
    crit({ id: "4", met: null }),
  ];
  const prior = new Map<string, PriorVerdict>([["2", { met: true, evidence: null }]]);
  const items = build({ criteria, prior });
  const kind = (id: string) => items.find((i) => i.criterionId === id)!.scoreKind;
  assert.equal(kind("1"), "criterion-unmet");
  assert.equal(kind("2"), "criterion-regressed");
  assert.equal(kind("3"), "criterion-met");
  assert.equal(kind("4"), "criterion-unevaluated");
  assert.equal(items.find((i) => i.criterionId === "3")!.state, "met");
  assert.equal(items.find((i) => i.criterionId === "1")!.state, "open");
});

test("retired criteria are dropped, not rendered as failures", () => {
  const items = build({
    criteria: [crit({ id: "1", supersededBy: "2" }), crit({ id: "2", notApplicable: true })],
  });
  assert.deepEqual(items, []);
});

test("a criterion borrows its anchor: suggestedChange, then evidenceCode, then a suggestion", () => {
  const patch = { path: "fix.ts", startLine: 12, original: "a", suggested: "b" };
  const evidence = { path: "ev.ts", startLine: 7, language: "ts", code: "x" };
  const withPatch = build({ criteria: [crit({ suggestedChange: patch, evidenceCode: evidence })] });
  assert.deepEqual([withPatch[0].path, withPatch[0].line], ["fix.ts", 12]);

  const withEvidence = build({ criteria: [crit({ evidenceCode: evidence })] });
  assert.deepEqual([withEvidence[0].path, withEvidence[0].line], ["ev.ts", 7]);

  const withSuggestion = build({
    criteria: [crit()],
    suggestions: [
      { criterionId: "c1", title: "t", rationale: "r", path: "sug.ts", line: 3 },
    ],
  });
  assert.deepEqual([withSuggestion[0].path, withSuggestion[0].line], ["sug.ts", 3]);

  assert.equal(build({ criteria: [crit()] })[0].path, undefined);
});

test("suggestion matching is case- and whitespace-insensitive on the criterion id", () => {
  const suggestions = [{ criterionId: " C1 ", title: "t", rationale: "r" }];
  assert.equal(suggestionsForCriterion("c1", suggestions).length, 1);
  assert.equal(suggestionsForCriterion("c2", suggestions).length, 0);
});

test("itemKey is stable across rewording inside the first 80 normalized chars", () => {
  const a = itemKey({ path: "src/a.ts", concern: "Returns before the write lands." });
  const b = itemKey({ path: "src/a.ts", concern: "returns before the write lands" });
  assert.equal(a, b);
});

test("itemKey separates deep paths that normalizeSlug would collapse", () => {
  const long = "packages/service-alpha/src/internal/handlers/deeply/nested";
  const a = itemKey({ path: `${long}/one.ts`, concern: "same concern" });
  const b = itemKey({ path: `${long}/two.ts`, concern: "same concern" });
  assert.notEqual(a, b);
});

test("itemKey ignores the bucket, so a finding that changes stage keeps its thread", () => {
  const f = finding();
  const asCritical = build({ holistic: { ...EMPTY_HOLISTIC, criticalErrors: [f] } })[0];
  const asDefect = build({ holistic: { ...EMPTY_HOLISTIC, defects: [f] } })[0];
  assert.equal(asCritical.key, asDefect.key);
  assert.notEqual(asCritical.category, asDefect.category);
});

test("the same finding reported by two stages yields one item, most severe category first", () => {
  const f = finding();
  const items = build({
    holistic: { ...EMPTY_HOLISTIC, criticalErrors: [f], defects: [{ ...f }] },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "criticalError");
});

test("line notes become nit-severity items anchored to their line", () => {
  const items = build({ lineNotes: [{ path: "src/a.ts", line: 9, body: "stray console.log" }] });
  assert.equal(items[0].category, "lineNote");
  assert.equal(items[0].severity, "nit");
  assert.deepEqual([items[0].path, items[0].line], ["src/a.ts", 9]);
});

test("titles are clipped and whitespace-collapsed for the thread heading", () => {
  const long = "x".repeat(200);
  const items = build({ holistic: { ...EMPTY_HOLISTIC, defects: [finding({ concern: long })] } });
  assert.equal(items[0].title.length, 100);
  assert.match(items[0].title, /…$/);
  assert.equal(items[0].concern, long, "the full concern is preserved for the body");
});

test("chip counts cover every open category and exclude met criteria", () => {
  const items = build({
    criteria: [crit({ id: "1", met: false }), crit({ id: "2", met: true })],
    holistic: {
      ...EMPTY_HOLISTIC,
      defects: [finding({ path: "d.ts", concern: "d" })],
      criticalErrors: [finding({ path: "c.ts", concern: "c" })],
      securityFindings: [finding({ path: "s.ts", concern: "s", securitySeverity: "low" })],
      conventionFindings: [finding({ path: "v.ts", concern: "v", severity: "nit" })],
    },
  });
  const chips = Object.fromEntries(countByChip(items).map((c) => [c.label, c.count]));
  assert.equal(chips["Criteria not met"], 1);
  assert.equal(chips["Bugs"], 2);
  assert.equal(chips["Security"], 1);
  assert.equal(chips["Nitpicks"], 1);
  assert.equal(chips["Cross-repo"], 0);
  // Every open item lands in exactly one chip.
  const open = items.filter((i) => i.state === "open").length;
  assert.equal(
    countByChip(items).reduce((n, c) => n + c.count, 0),
    open
  );
});
