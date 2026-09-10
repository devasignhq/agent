// GitHub's markdown is unforgiving in two specific ways, and both fail silently
// — the comment posts fine and simply renders as a scattered mess:
//
//   1. Markdown inside <details> is only parsed when a blank line follows
//      </summary>; without it the body renders as literal text.
//   2. A fenced block is closed by the FIRST line of at least as many backticks
//      with no info string. Our fix prompts carry their own ```diff fences, so a
//      naive 3-backtick wrapper is closed by the prompt's own fence and
//      everything after it leaks out of the block.
//
// Nothing else in the suite would catch either, so this file audits the real
// shape of every body we post. No db / network / LLM. Run:
//   node --import tsx/esm --test src/review/markdown-shape.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResolvedThreadBody, formatSummaryCard, formatThreadBody } from "./comment.js";
import { buildReviewItems, type ReviewItem } from "./items.js";
import { EMPTY_HOLISTIC, type HolisticFinding } from "./verdict-types.js";
import { buildVerificationView, formatTestsComment } from "../verify/report.js";
import type { Criterion, Repository } from "../types.js";

// Walk the body the way a CommonMark parser does and report every structural
// problem that would make GitHub render it wrong.
function audit(body: string): string[] {
  const problems: string[] = [];
  const lines = body.split("\n");
  let openFence: number | null = null;
  const inFence: boolean[] = [];

  for (const line of lines) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (m) {
      const ticks = m[1].length;
      const info = m[2].trim();
      if (openFence === null) {
        openFence = ticks;
        inFence.push(false); // the opening line itself is markup, not content
        continue;
      }
      // Only a bare run of at least as many backticks closes the block.
      if (info === "" && ticks >= openFence) {
        openFence = null;
        inFence.push(false);
        continue;
      }
    }
    inFence.push(openFence !== null);
  }
  if (openFence !== null) problems.push("a code fence is never closed");

  let depth = 0;
  lines.forEach((line, i) => {
    if (inFence[i]) return; // literal text inside a code block, not markup
    if (line.includes("<details>")) depth++;
    if (line.includes("</details>")) {
      depth--;
      if (depth < 0) problems.push(`line ${i + 1}: </details> with no opening tag`);
      if (i > 0 && lines[i - 1].trim() !== "") {
        problems.push(`line ${i + 1}: </details> must be preceded by a blank line`);
      }
    }
    if (line.includes("</summary>") && (lines[i + 1] === undefined || lines[i + 1].trim() !== "")) {
      problems.push(`line ${i + 1}: </summary> must be followed by a blank line`);
    }
  });
  if (depth !== 0) problems.push(`${depth} <details> left unclosed`);
  return problems;
}

const ok = (name: string, body: string) => {
  const problems = audit(body);
  assert.deepEqual(problems, [], `${name} would render wrong on GitHub:\n  ${problems.join("\n  ")}`);
};

// A fix prompt exactly as the stage prompts mandate: it carries its OWN ```diff
// fence, which is the thing that breaks a naive wrapper.
const FIX_PROMPT =
  "Fix: await the flush before returning\n\nFile: src/a.ts\nSymbol: handler\n\n" +
  "Issue:\nThe handler returns before the write lands.\n\n" +
  "Relevant diff:\n```diff\n-  flush();\n+  await flush();\n```";

const finding = (over: Partial<HolisticFinding> = {}): HolisticFinding => ({
  path: "src/a.ts",
  line: 11,
  concern: "Missing await on flush().",
  severity: "blocker",
  fixPrompt: FIX_PROMPT,
  ...over,
});

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  id: "2",
  text: "A claim for someone else's installation is rejected with 403.",
  met: false,
  evidence: "The handler returns 200 for a mismatched account.",
  evidenceCode: { path: "src/a.ts", startLine: 12, language: "typescript", code: "const x = `tpl`;" },
  suggestedChange: { path: "src/a.ts", startLine: 20, original: "  link(a);", suggested: "  guard(a);" },
  ...over,
});

const build = (over: Partial<Parameters<typeof buildReviewItems>[0]> = {}) =>
  buildReviewItems({
    criteria: [],
    prior: new Map(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
    ...over,
  });

test("the summary card renders as one block, with the fix prompt inside its <details>", () => {
  const items = build({
    criteria: [criterion()],
    holistic: { ...EMPTY_HOLISTIC, defects: [finding()] },
  });
  const body = formatSummaryCard({
    open: items,
    fixedCount: 2,
    score: 45,
    specless: false,
    criteriaTotal: 1,
    criteriaMet: 0,
    summary: "Close, but the org path is ungated.",
    fixPrompt: `You are helping fix PR "x".\n\n${FIX_PROMPT}`,
    unanchored: items,
    overflow: items,
    metWithoutThread: [],
    notes: ["**Tests:** 4 passed, 1 failed."],
    cta: "## Want a deeper review?",
  });
  ok("the summary card", body);
  // The wrapper must outrun the prompt's own ```diff fence, or everything after
  // that fence leaks out of the block as plain text.
  assert.match(body, /^````$/m);
  assert.ok(
    body.indexOf("</details>") > body.indexOf("Relevant diff:"),
    "the prompt must still be inside the collapsed block"
  );
});

test("a card whose every test failed audits clean, callout included", () => {
  const items = build({ criteria: [criterion()] });
  const body = formatSummaryCard({
    open: items,
    fixedCount: 0,
    score: 100,
    specless: false,
    criteriaTotal: 1,
    criteriaMet: 0,
    summary: "",
    fixPrompt: FIX_PROMPT,
    verification: {
      state: "completed",
      counts: { pass: 0, fail: 2, unverifiable: 0, pending: 0 },
      rows: [
        { id: "1", text: "Refunds show", verdict: "fail", reason: "missing", testName: "t.test.ts" },
        { id: "2", text: "Total is currency", verdict: "fail", reason: "bare number" },
      ],
    },
  });
  ok("the all-failing card", body);
  assert.match(body, /Do not merge/);
});

test("a card full of unanchored blocks with fix prompts still audits clean", () => {
  const defects = Array.from({ length: 30 }, (_, i) =>
    finding({ path: `src/module-${i}.ts`, concern: `Unanchored finding ${i} about subsystem ${i}.`, fixPrompt: FIX_PROMPT } as any)
  );
  const items = build({ holistic: { ...EMPTY_HOLISTIC, defects } });
  const body = formatSummaryCard({
    open: items,
    fixedCount: 0,
    score: 30,
    specless: true,
    criteriaTotal: 0,
    criteriaMet: 0,
    summary: "",
    unanchored: items,
  });
  assert.equal(items.length, 30);
  ok("the card with unanchored blocks", body);
  assert.ok(body.length < 65_536, "stays under GitHub's review body limit");
});

test("every thread body renders as one block, whatever the item is", () => {
  const cases: Array<[string, ReviewItem]> = [
    ["unmet criterion", build({ criteria: [criterion()] })[0]],
    ["met criterion", build({ criteria: [criterion({ met: true })] })[0]],
    ["unevaluated criterion", build({ criteria: [criterion({ met: null })] })[0]],
    ["defect", build({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } })[0]],
    [
      "security",
      build({
        holistic: { ...EMPTY_HOLISTIC, securityFindings: [finding({ securitySeverity: "critical" })] },
      })[0],
    ],
    [
      "convention nit",
      build({
        holistic: {
          ...EMPTY_HOLISTIC,
          conventionFindings: [finding({ severity: "nit", fixPrompt: undefined })],
        },
      })[0],
    ],
  ];
  for (const [name, item] of cases) {
    ok(`the ${name} thread`, formatThreadBody(item));
    ok(
      `the ${name} thread (snapped + relocated + reopened)`,
      formatThreadBody(item, {
        snappedFrom: 15,
        reopened: true,
        relocatedTo: { path: "src/a.ts", line: 118, url: "https://gh/blob/s/src/a.ts#L118" },
        fixedIn: "Fixed in [`9f2c1ab`](https://gh/c/9f2c1ab).",
      })
    );
  }
});

test("a resolved thread nests the original inside <details> without breaking either", () => {
  const item = build({ holistic: { ...EMPTY_HOLISTIC, defects: [finding()] } })[0];
  const openBody = formatThreadBody(item);
  for (const attribution of [
    { kind: "commit" as const, sha: "9f2c1abdead", url: "https://gh/c/9f2c1ab", message: 'He said "go"' },
    { kind: "range" as const, base: "a1b2c3d", head: "9f2c1ab", url: "https://gh/compare/a...b", count: 4 },
    { kind: "head" as const, sha: "9f2c1abdead", url: "https://gh/c/9f2c1ab" },
    { kind: "gone" as const, path: "src/a.ts", sha: "9f2c1abdead", url: "https://gh/c/9f2c1ab" },
  ]) {
    const body = formatResolvedThreadBody({ item, openBody, sha: "9f2c1abdead", attribution });
    ok(`a resolved thread (${attribution.kind})`, body);
    // The original diagnosis is preserved; its fix prompt is not, so exactly one
    // <details> survives and it must still be balanced.
    assert.match(body, /\*\*How it fails:\*\*|Missing await on flush/);
    assert.doesNotMatch(body, /Prompt to fix with AI/);
    assert.equal(body.match(/<details>/g)!.length, 1);
    assert.equal(body.match(/<\/details>/g)!.length, 1);
  }
});

test("the tests comment renders as one block, prompt and per-test sections intact", () => {
  const criteria: Criterion[] = [
    { id: "1", text: "Refunds line shows", met: null, evidence: null },
    { id: "2", text: "Total is currency", met: null, evidence: null },
  ];
  const view = buildVerificationView({
    run: {
      id: "run1",
      reviewId: "rev",
      repoId: "r",
      sha: "abc",
      status: "completed",
      verdicts: [
        { criterionId: "1", verdict: "pass", reason: "ok", evidenceRefs: [] },
        { criterionId: "2", verdict: "fail", reason: "renders a bare number", evidenceRefs: [] },
      ],
      timings: {},
      tokenUsage: {},
      artifactBytes: 0,
      criteriaRevision: 1,
      planTier: "free",
      attempt: 1,
      prNumber: 1,
      installationId: "i",
      schemaVersion: 1,
      triggeredBy: { kind: "pr_event" },
      createdAt: 0,
      updatedAt: 0,
    } as any,
    review: { id: "rev" },
    repo: { id: "r", installationId: "i", verify: { onboarding: { state: "merged" } } } as unknown as Repository,
    criteria,
    plan: null,
    results: null,
    artifacts: [],
  });
  ok("the tests comment", formatTestsComment(view, "acme/widgets"));
});

test("the auditor itself catches the two failures it exists to prevent", () => {
  // A validator that can never fail is worse than none.
  assert.deepEqual(audit("<details>\n<summary>x</summary>\nbody\n\n</details>"), [
    "line 2: </summary> must be followed by a blank line",
  ]);
  // A 3-backtick wrapper around a prompt containing its own fence: the block
  // closes early, so the trailing </details> ends up outside it and unbalanced.
  const naive = "<details>\n<summary>x</summary>\n\n```\nRelevant diff:\n```diff\n-a\n```\n```\n\n</details>";
  assert.ok(audit(naive).length > 0, "an early-closed fence must be reported");
});
