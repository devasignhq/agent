// Pure tests for one item's inline review-comment thread body. No db / network /
// LLM. Several of these are ported from review-body.test.ts, which used to assert
// the same markdown inside the single verdict comment. Run:
//   node --import tsx/esm --test src/review/thread-body.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributionLine,
  formatResolvedThreadBody,
  stripFixPromptBlock,
  formatThreadBody,
  itemMarker,
  parseItemMarker,
  parseResolvedMarker,
} from "./comment.js";
import { buildReviewItems, type ReviewItem } from "./items.js";
import { EMPTY_HOLISTIC, type HolisticFinding } from "./verdict-types.js";
import type { Criterion } from "../types.js";
import type { PriorVerdict } from "./criteria-format.js";

const itemsFor = (over: Partial<Parameters<typeof buildReviewItems>[0]>) =>
  buildReviewItems({
    criteria: [],
    prior: new Map<string, PriorVerdict>(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
    ...over,
  });

const critItem = (over: Partial<Criterion> = {}, suggestions: any[] = []): ReviewItem =>
  itemsFor({
    criteria: [
      {
        id: "C1",
        text: "Personal claims succeed when account.id matches the user's githubId.",
        met: false,
        evidence: null,
        ...over,
      },
    ],
    suggestions,
  })[0];

const findingItem = (over: Partial<HolisticFinding> = {}, bucket = "defects"): ReviewItem =>
  itemsFor({
    holistic: {
      ...EMPTY_HOLISTIC,
      [bucket]: [
        {
          path: "src/a.ts",
          line: 12,
          concern: "Missing await on flush() — the handler returns before the write lands.",
          severity: "blocker",
          ...over,
        },
      ],
    } as any,
  })[0];

// ─── markers ───────────────────────────────────────────────────────────────

test("the item marker round-trips keys containing markup, newlines and unicode", () => {
  for (const key of [
    "src/a.ts::plainconcern",
    'src/a.ts::<!-- nested --> and --> again',
    "src/a.ts::line one\nline two",
    "criterion::ünïcodé—em-dash",
    "",
  ]) {
    const body = `${itemMarker(key)}\n### heading`;
    assert.equal(parseItemMarker(body), key || null);
  }
});

test("a body with no marker, or a corrupt one, parses to null instead of throwing", () => {
  assert.equal(parseItemMarker("### just a heading"), null);
  assert.equal(parseItemMarker("<!-- devasign:item v1 k=not base64! -->"), null);
  assert.equal(parseItemMarker(""), null);
});

test("every thread body opens with exactly one item marker", () => {
  const body = formatThreadBody(findingItem());
  assert.equal(body.split("\n")[0], itemMarker(findingItem().key));
  assert.equal(body.match(/devasign:item/g)!.length, 1);
});

// ─── criteria ──────────────────────────────────────────────────────────────

test("unmet criterion: heading, requirement and the reason it isn't met", () => {
  const body = formatThreadBody(
    critItem({ evidence: "linkInstallationHandler links without comparing account.id." })
  );
  assert.match(body, /^### 📋 Acceptance criterion not met — C1$/m);
  assert.match(body, /\*\*Required:\*\* Personal claims succeed when account\.id/);
  assert.match(body, /\*\*Why it isn't met:\*\* linkInstallationHandler links without comparing/);
});

test("unmet criterion without evidence still gets a reason, never a bare 'not met'", () => {
  const body = formatThreadBody(critItem());
  assert.match(body, /\*\*Why it isn't met:\*\* The current diff doesn't yet show this requirement/);
});

test("met === null reads 'could not be evaluated', not an asserted failure", () => {
  const body = formatThreadBody(critItem({ met: null }));
  assert.match(body, /### 📋 Acceptance criterion could not be evaluated — C1/);
  assert.match(body, /\*\*Why:\*\* The reviewer could not evaluate this requirement/);
  assert.doesNotMatch(body, /not met/);
});

test("a regressed criterion says what broke, not that it was never met", () => {
  const item = itemsFor({
    criteria: [{ id: "C1", text: "Claims are gated.", met: false, evidence: "a later commit dropped the check" }],
    prior: new Map([["C1", { met: true, evidence: null } as PriorVerdict]]),
  })[0];
  const body = formatThreadBody(item);
  assert.match(body, /### ⚠️ Acceptance criterion regressed — C1/);
  assert.match(body, /\*\*What broke:\*\* a later commit dropped the check/);
});

test("a met criterion gets a thread with its evidence and no fix prompt", () => {
  const body = formatThreadBody(critItem({ met: true, evidence: "the handler compares account.id" }));
  assert.match(body, /### ✅ Acceptance criterion met — C1/);
  assert.match(body, /\*\*How it's satisfied:\*\* the handler compares account\.id/);
  assert.doesNotMatch(body, /Prompt to fix with AI/);
});

test("evidence renders as an anchored, language-tagged code block", () => {
  const body = formatThreadBody(
    critItem({ evidenceCode: { path: "src/a.ts", startLine: 42, language: "typescript", code: "const x = 1;" } })
  );
  assert.match(body, /\*\*Evidence\*\* \(`src\/a\.ts:42`\):/);
  assert.match(body, /```typescript\nconst x = 1;\n```/);
});

test("a criterion's own patch renders once, and a matched suggestion doesn't repeat it", () => {
  const patch = { path: "src/a.ts", startLine: 4, original: "old", suggested: "new" };
  const body = formatThreadBody(
    critItem({ suggestedChange: patch }, [
      { criterionId: "C1", title: "t", rationale: "r", patch: { ...patch } },
    ])
  );
  assert.equal(body.match(/\*\*Suggested change\*\*/g)!.length, 1);
  assert.match(body, /```diff\n-old\n\+new\n```/);
});

test("a suggestion patch that differs from the criterion's renders in addition", () => {
  const body = formatThreadBody(
    critItem({ suggestedChange: { path: "src/a.ts", startLine: 4, original: "old", suggested: "new" } }, [
      {
        criterionId: "C1",
        title: "t",
        rationale: "r",
        patch: { path: "src/b.ts", startLine: 9, original: "p", suggested: "q" },
      },
    ])
  );
  assert.equal(body.match(/\*\*Suggested change\*\*/g)!.length, 2);
  assert.match(body, /`src\/b\.ts:9`/);
});

test("a malformed codeExample language cannot corrupt the fence info string", () => {
  const body = formatThreadBody(
    critItem({}, [
      { criterionId: "C1", title: "t", rationale: "r", codeExample: "x", language: "ts js `evil`" },
    ])
  );
  assert.match(body, /\*\*Full code:\*\*/);
  assert.match(body, /```\nx\n```/);
  assert.doesNotMatch(body, /evil/);
});

// ─── findings ──────────────────────────────────────────────────────────────

test("a defect renders severity, class and the concrete failure", () => {
  const body = formatThreadBody(
    findingItem({ defectClass: "race-condition", failureScenario: "Two writers land in the same tick." })
  );
  // The heading carries the title AND the severity; the body doesn't repeat it.
  assert.match(body, /### 🐞 Bug \(blocker\) — Missing await on flush/);
  assert.equal(body.match(/Missing await on flush/g)!.length, 1, "the concern is stated once");
  assert.match(body, /\*\*Class:\*\* `race-condition`/);
  assert.match(body, /\*\*How it fails:\*\* Two writers land in the same tick\./);
});

test("a security finding shows its 4-tier severity and carries the full fix prompt inline", () => {
  const body = formatThreadBody(
    findingItem(
      {
        securitySeverity: "high",
        concern: "User input reaches the query unescaped.",
        fixPrompt: "Fix: parameterise the query\n\n```diff\n-raw\n+bound\n```",
        suggestedChange: { path: "src/a.ts", startLine: 3, original: "raw", suggested: "bound" },
      },
      "securityFindings"
    )
  );
  assert.match(body, /### 🔒 Security \(high\) — User input reaches the query unescaped\./);
  assert.match(body, /\*\*Suggested change\*\* \(`src\/a\.ts:3`\)/);
  assert.match(body, /<summary>Prompt to fix with AI<\/summary>/);
  assert.match(body, /Fix: parameterise the query/);
});

test("a fix prompt containing its own diff fence is wrapped in a longer fence", () => {
  const body = formatThreadBody(findingItem({ fixPrompt: "Fix: x\n\n```diff\n-a\n+b\n```" }));
  assert.match(body, /^````$/m, "outer fence must outrun the inner ```diff");
  // The inner fence survives intact rather than closing the wrapper early.
  assert.match(body, /```diff\n-a\n\+b\n```/);
});

test("advisory categories carry their own heading, with severity only when notable", () => {
  const conv = formatThreadBody(
    findingItem({ concern: "Uses var instead of const.", severity: "nit" }, "conventionFindings")
  );
  assert.match(conv, /### 📝 Convention \(nit\) — Uses var instead of const\./);

  const parity = formatThreadBody(
    findingItem({ concern: "The Go SDK lacks this.", severity: "nit" }, "parityNotes")
  );
  assert.match(parity, /### 🔗 Feature parity \(nit\) — The Go SDK lacks this\./);

  // "warn" is the unremarkable middle, so it stays out of the heading entirely.
  const deferred = formatThreadBody(
    findingItem({ concern: "Stubbed the retry path for now.", severity: "warn" }, "deferrals")
  );
  assert.match(deferred, /### 🚧 Deferred work — Stubbed the retry path for now\./);
});

// ─── anchoring notes ───────────────────────────────────────────────────────

test("a snapped anchor says where the finding really pointed", () => {
  const body = formatThreadBody(findingItem(), { snappedFrom: 15 });
  assert.match(body, /_Nearest diff line to `src\/a\.ts:15`\._/);
});

test("a relocated thread links the live location", () => {
  const body = formatThreadBody(findingItem(), {
    relocatedTo: { path: "src/a.ts", line: 118, url: "https://gh/blob/sha/src/a.ts#L118" },
  });
  assert.match(body, /_Now at_ \[`src\/a\.ts:118`\]\(https:\/\/gh\/blob\/sha\/src\/a\.ts#L118\)/);
});

test("a reopened thread says so at the top", () => {
  const body = formatThreadBody(findingItem(), { reopened: true });
  assert.match(body, /\*\*Reopened\*\* — this came back in the latest review\./);
});

// ─── resolved bodies ───────────────────────────────────────────────────────

const resolved = (attribution: any) => {
  const item = findingItem();
  return formatResolvedThreadBody({
    item,
    openBody: formatThreadBody(item),
    sha: "9f2c1abdeadbeef",
    attribution,
  });
};

test("a fixed thread keeps one item marker, adds a resolved marker, and collapses the original", () => {
  const body = resolved({ kind: "commit", sha: "9f2c1abdeadbeef", url: "https://gh/c/9f2c1ab" });
  assert.equal(body.match(/devasign:item/g)!.length, 1, "exactly one item marker survives");
  assert.equal(parseResolvedMarker(body), "9f2c1ab");
  assert.equal(parseItemMarker(body), findingItem().key);
  assert.match(body, /<summary>What this was<\/summary>/);
  assert.match(body, /Missing await on flush/);
});

test("a fixed thread keeps the diagnosis but drops the prompt to fix it", () => {
  const item = findingItem({
    failureScenario: "Two writers land in the same tick.",
    fixPrompt: "Fix: await the flush\n\n```diff\n-a\n+b\n```",
  });
  const openBody = formatThreadBody(item);
  assert.match(openBody, /<summary>Prompt to fix with AI<\/summary>/, "the open thread has one");
  const body = formatResolvedThreadBody({
    item,
    openBody,
    sha: "9f2c1abdeadbeef",
    attribution: { kind: "commit", sha: "9f2c1abdeadbeef", url: "https://gh/c/9f2c1ab" },
  });
  // Nothing left to fix, so the prompt is noise — but why it mattered is not.
  assert.doesNotMatch(body, /Prompt to fix with AI/);
  assert.doesNotMatch(body, /Fix: await the flush/);
  assert.match(body, /\*\*How it fails:\*\*/);
  assert.equal(body.match(/<details>/g)!.length, 1, "only the 'What this was' block remains");
  assert.equal(body.match(/<\/details>/g)!.length, 1);
});

test("stripping the prompt survives a prompt whose code block contains a closing tag", () => {
  // The fix prompt is fenced code and can quote anything, including our own
  // markup — a regex would stop at the first match and orphan the real tag.
  const item = findingItem({
    fixPrompt: "Fix: escape the template\n\n```html\n</details>\n<details>\n```",
  });
  const openBody = formatThreadBody(item);
  const stripped = stripFixPromptBlock(openBody);
  assert.doesNotMatch(stripped, /Prompt to fix with AI/);
  assert.doesNotMatch(stripped, /escape the template/);
  assert.equal(stripped.match(/<details>/g), null, "no orphaned opening tag");
  assert.equal(stripped.match(/<\/details>/g), null, "no orphaned closing tag");
  assert.match(stripped, /### 🐞 Bug/, "the finding itself is untouched");
});

test("stripping is a no-op on a body with no prompt, and never truncates a malformed one", () => {
  const noPrompt = formatThreadBody(findingItem({ fixPrompt: undefined }));
  assert.equal(stripFixPromptBlock(noPrompt), noPrompt);
  // An unbalanced block is left alone rather than swallowing the rest of the body.
  const malformed = "### Bug\n\n<details>\n<summary>Prompt to fix with AI</summary>\n\ntext";
  assert.equal(stripFixPromptBlock(malformed), malformed);
});

test("wording stays honest: it reports our own output, not a claim about the author", () => {
  const body = resolved({ kind: "commit", sha: "9f2c1abdeadbeef", url: "https://gh/c/9f2c1ab" });
  assert.match(body, /### ✅ Fixed — Missing await on flush/);
  assert.match(body, /This no longer appears in the review of `9f2c1ab`\./);
});

test("a single-commit push names the commit and its message", () => {
  const body = resolved({
    kind: "commit",
    sha: "9f2c1abdeadbeef",
    url: "https://gh/c/9f2c1ab",
    message: "Await the flush before returning",
  });
  assert.match(body, /Fixed in \[`9f2c1ab`\]\(https:\/\/gh\/c\/9f2c1ab\) — _"Await the flush before returning"_\./);
});

test("a multi-commit push names the range rather than guessing", () => {
  const body = resolved({
    kind: "range",
    base: "a1b2c3d000",
    head: "9f2c1abdeadbeef",
    url: "https://gh/compare/a1b2c3d...9f2c1ab",
    count: 4,
  });
  assert.match(body, /Fixed somewhere in \[`a1b2c3d…9f2c1ab`\]\(https:\/\/gh\/compare\/[^)]+\) — 4 commits since the last review\./);
});

test("with only a head sha we say attribution wasn't possible", () => {
  const body = resolved({ kind: "head", sha: "9f2c1abdeadbeef", url: "https://gh/c/9f2c1ab" });
  assert.match(body, /the last commit reviewed\. DevAsign couldn't determine which commit resolved it\./);
});

test("a file that left the PR gets its own wording, with no claim of a fix", () => {
  const body = resolved({
    kind: "gone",
    path: "src/a.ts",
    sha: "9f2c1abdeadbeef",
    url: "https://gh/c/9f2c1ab",
  });
  assert.match(body, /### ✅ No longer in this PR — Missing await on flush/);
  assert.match(body, /`src\/a\.ts` is no longer part of this pull request's changes/);
  assert.doesNotMatch(body, /Fixed in/);
  assert.doesNotMatch(body, /Fixed somewhere/);
});

test("a criterion that flips to met keeps its thread and names the fixing commit", () => {
  const body = formatThreadBody(critItem({ met: true, evidence: "the check is now in place" }), {
    fixedIn: attributionLine({ kind: "commit", sha: "9f2c1abdeadbeef", url: "https://gh/c/9f2c1ab" })!,
  });
  assert.match(body, /### ✅ Acceptance criterion met — C1/);
  assert.match(body, /Fixed in \[`9f2c1ab`\]\(https:\/\/gh\/c\/9f2c1ab\)\./);
  assert.match(body, /\*\*How it's satisfied:\*\* the check is now in place/);
});

test("a concern too long for the heading is still stated in full in the body", () => {
  const long = "Missing await on flush(). " + "The handler returns before the write lands. ".repeat(4);
  const body = formatThreadBody(findingItem({ concern: long }));
  assert.match(body, /### 🐞 Bug \(blocker\) — Missing await on flush\(\)\..*…$/m, "the heading is clipped");
  assert.ok(body.includes(long.trim()), "the full concern survives in the body");
});
