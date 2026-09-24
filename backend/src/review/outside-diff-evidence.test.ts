// Criteria that depend on repository state outside the diff (PR #263: a script
// writes .env.cloudrun.yaml, which a pre-existing root `.env.*` rule already
// ignores) must be looked up — or reported unverifiable — never failed.
//   node --import tsx/esm --test src/review/outside-diff-evidence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  criteriaNeedIgnoreFacts,
  diffWriteCandidates,
  gatherIgnoreFacts,
  pathsInLine,
  renderRepoStateSection,
  runRepoRead,
  type RepoEntry,
} from "./repo-state.js";
import { awaitsConfirmation, criterionOutcome, isHedgedEvidence, resolveReviewEvent, resolveVerdictStatus } from "./decisions.js";
import { completeStructuredWithLookups, runLookupLoop, type SendTurn } from "../llm.js";
import { buildReviewUserText, endGoalCheck } from "./pipeline.js";
import { reviewSystemPrompt } from "./prompts.js";
import { readRepoFileTool, reviewVerdictTool } from "./tools.js";
import { buildReviewItems } from "./items.js";
import { formatThreadBody } from "./comment.js";
import { mergeScore } from "./score.js";
import { EMPTY_HOLISTIC } from "./verdict-types.js";
import type { Criterion } from "../types.js";

// Lines lifted from PR #263's diff; the ignore rule lives only in the root
// .gitignore, which the PR does not touch.
const PR263_DIFF = [
  "diff --git a/backend/deploy/gcp/import-render-env.mjs b/backend/deploy/gcp/import-render-env.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/backend/deploy/gcp/import-render-env.mjs",
  "@@ -0,0 +1,6 @@",
  '+import path from "node:path";',
  "+const outDir = path.dirname(fileURLToPath(import.meta.url));",
  '+const envYamlPath = path.join(outDir, ".env.cloudrun.yaml");',
  '+const secretsSpecPath = path.join(outDir, ".env.cloudrun.secrets");',
  '+const gcloud = process.env.GCLOUD || path.join(homedir(), "google-cloud-sdk/bin/gcloud");',
  "+console.log(`Wrote ${path.relative(process.cwd(), envYamlPath)} (plain env, gitignored)`);",
].join("\n");

const ROOT_GITIGNORE = [
  "node_modules",
  "dist",
  "build",
  ".DS_Store",
  "*.log",
  "coverage",
  ".vite",
  ".turbo",
  ".cache",
  "*.tsbuildinfo",
  "",
  "# Environment variables and secrets",
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
].join("\n");

const CRITERION: Criterion = {
  id: "3",
  text: "Variables not classified as secrets are written to a Cloud Run env-vars YAML file that is gitignored.",
  met: null,
  evidence: null,
};

// The reviewer's own words from the three failed runs on PR #263.
const PR263_EVIDENCE =
  "I cannot confirm from the provided context that an existing .gitignore already ignores .env.cloudrun.yaml; " +
  "the diff adds no ignore rule for it, so there is no positive evidence the file is gitignored.";

const repoFiles: Record<string, string> = { ".gitignore": ROOT_GITIGNORE };
const readFile = async (p: string) => repoFiles[p] ?? null;

test("PR #263: the file the script writes is found and resolved against the pre-existing root rule", async () => {
  const candidates = diffWriteCandidates(PR263_DIFF).map((c) => c.path);
  assert.ok(candidates.includes("backend/deploy/gcp/.env.cloudrun.yaml"), candidates.join(", "));
  assert.ok(!candidates.some((c) => c.includes("gcloud")), "a path without a file shape is not a candidate");

  const facts = await gatherIgnoreFacts({ diff: PR263_DIFF, criteria: [CRITERION], read: readFile });
  const fact = facts.find((f) => f.path === "backend/deploy/gcp/.env.cloudrun.yaml");
  assert.deepEqual(fact?.match, { ignored: true, source: ".gitignore", line: 14, pattern: ".env.*" });
  assert.equal(fact?.from, "backend/deploy/gcp/import-render-env.mjs");

  const section = renderRepoStateSection(facts);
  assert.match(section, /^# Repository state outside the diff/);
  assert.match(section, /`backend\/deploy\/gcp\/\.env\.cloudrun\.yaml` \(written by backend\/deploy\/gcp\/import-render-env\.mjs\): ignored by git — `\.gitignore:14` `\.env\.\*`/);
});

test("PR #263: the reviewer's hedged 'cannot confirm' verdict is unverifiable, not a failed criterion", () => {
  assert.deepEqual(criterionOutcome({ met: false, evidence: PR263_EVIDENCE }), { met: null, unverifiable: true });
  assert.deepEqual(criterionOutcome({ met: false, unverifiable: true, evidence: "x" }), { met: null, unverifiable: true });
});

test("PR #263: with the lookup tool, the reviewer reads the root .gitignore and passes the criterion", async () => {
  const calls: Array<{ choice: unknown; last: Anthropic.MessageParam }> = [];
  let toolResult = "";
  const send: SendTurn = async (messages, choice) => {
    calls.push({ choice, last: messages[messages.length - 1] });
    if (calls.length === 1) {
      return fakeMessage([{ type: "tool_use", id: "t1", name: "read_repo_file", input: { path: ".gitignore" } }]);
    }
    const content = messages[messages.length - 1].content as Anthropic.ToolResultBlockParam[];
    toolResult = String(content[0].content);
    const ignored = /14 \| \.env\.\*/.test(toolResult);
    return fakeMessage([
      {
        type: "tool_use",
        id: "t2",
        name: "submit_review_verdict",
        input: {
          verdict: ignored ? "passed" : "changes_requested",
          summary: "",
          criteria: [{ id: "3", met: ignored, evidence: ".gitignore:14 `.env.*` already ignores it." }],
          comments: [],
          suggestions: [],
        },
      },
    ]);
  };
  const read = async (p: string): Promise<RepoEntry> =>
    repoFiles[p] != null ? { kind: "file", content: repoFiles[p] } : null;
  const res = await runLookupLoop({
    send,
    messages: [{ role: "user", content: "# Criteria\n- 3: ..." }],
    tool: reviewVerdictTool,
    lookups: [{ tool: readRepoFileTool, run: (input) => runRepoRead(input, read) }],
    maxLookupTurns: 4,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].choice, { type: "any" });
  assert.match(toolResult, /BEGIN_UNTRUSTED_FILE_CONTENT/);
  const verdict = res.input as { criteria: Array<{ met: boolean }> };
  assert.equal(verdict.criteria[0].met, true);
  assert.notEqual(criterionOutcome(verdict.criteria[0]).met, false);
});

test("PR #263: an unverifiable criterion renders as 'could not be verified', not 'not met'", () => {
  const c: Criterion = { ...CRITERION, ...criterionOutcome({ met: false, evidence: PR263_EVIDENCE }), evidence: PR263_EVIDENCE };
  const items = buildReviewItems({
    criteria: [c],
    prior: new Map(),
    suggestions: [],
    holistic: EMPTY_HOLISTIC,
  });
  assert.equal(items[0].scoreKind, "criterion-unverifiable");
  const body = formatThreadBody(items[0]);
  assert.match(body, /could not be verified/);
  assert.doesNotMatch(body, /not met/);
  assert.ok(mergeScore(items) > mergeScore([{ ...items[0], scoreKind: "criterion-unmet" }]));
});

test("PR #263: a met criterion plus the unverifiable one posts a neutral COMMENT and a neutral check", () => {
  const live = [
    { met: true, unverifiable: false },
    criterionOutcome({ met: false, evidence: PR263_EVIDENCE }),
  ];
  const metCount = live.filter((c) => c.met === true).length;
  const status = resolveVerdictStatus({
    allMet: false,
    hasBlocker: false,
    liveCount: live.length,
    scoredCount: live.filter((c) => c.met !== null).length,
    metCount,
  });
  assert.equal(status, "changes_requested");
  const awaiting = awaitsConfirmation({
    hasBlocker: false,
    liveCount: live.length,
    metCount,
    unverifiableCount: live.filter((c) => c.unverifiable).length,
  });
  const r = resolveReviewEvent({ status, specless: false, blocking: true, endGoalAlreadyRequested: false, awaitingConfirmation: awaiting });
  assert.equal(r.event, "COMMENT");
  assert.deepEqual(endGoalCheck(status, r.confirmationPending, false), { conclusion: "neutral", title: "Needs manual confirmation" });
});

test("endGoalCheck keeps the existing conclusions for every other verdict", () => {
  assert.equal(endGoalCheck("passed", false, false).conclusion, "success");
  assert.equal(endGoalCheck("blocked", true, false).conclusion, "action_required");
  assert.deepEqual(endGoalCheck("changes_requested", false, false), { conclusion: "action_required", title: "Changes requested" });
});

test("a genuine failure stays failed", () => {
  const evidence = "import-render-env.mjs writes the plain vars to stdout only; no YAML file is produced.";
  assert.equal(isHedgedEvidence(evidence), false);
  assert.deepEqual(criterionOutcome({ met: false, evidence }), { met: false, unverifiable: false });
  assert.deepEqual(criterionOutcome({ met: true, unverifiable: true, evidence }), { met: true, unverifiable: false });
  assert.deepEqual(criterionOutcome({}), { met: null, unverifiable: false });
});

test("ignore facts are only gathered for criteria that turn on ignore/tracking state", async () => {
  assert.equal(criteriaNeedIgnoreFacts([{ text: "Returns 404 for unknown ids." }]), false);
  let reads = 0;
  const facts = await gatherIgnoreFacts({
    diff: PR263_DIFF,
    criteria: [{ text: "Returns 404 for unknown ids." }],
    read: async () => (reads++, null),
  });
  assert.deepEqual(facts, []);
  assert.equal(reads, 0);
});

test("a failed ignore-file read is reported as unknown, never as 'not ignored'", async () => {
  const facts = await gatherIgnoreFacts({
    diff: PR263_DIFF,
    criteria: [CRITERION],
    read: async (p) => {
      if (p === ".gitignore") throw new Error("gh 403 rate limited");
      return null;
    },
  });
  const section = renderRepoStateSection(facts);
  assert.match(section, /`backend\/deploy\/gcp\/\.env\.cloudrun\.yaml` .*UNKNOWN whether ignored by git — could not read `\.gitignore`/);
  assert.doesNotMatch(section, /\.env\.cloudrun\.yaml` \(written[^\n]*NOT ignored/);
});

test("a path nothing ignores is reported as not ignored, naming the files checked", async () => {
  const facts = await gatherIgnoreFacts({
    diff: PR263_DIFF,
    criteria: [CRITERION],
    read: async (p) => (p === ".gitignore" ? "node_modules\n" : null),
  });
  assert.match(renderRepoStateSection(facts), /\.env\.cloudrun\.yaml` \(written by [^)]+\): NOT ignored by git \(checked `\.gitignore`\)/);
});

test("pathsInLine resolves script-relative and root-relative literals", () => {
  assert.deepEqual(pathsInLine('OUT="$(dirname "$0")/.env.cloudrun.yaml"', "deploy"), ["deploy/.env.cloudrun.yaml"]);
  assert.deepEqual(pathsInLine('cp x "$SCRIPT_DIR/out.json"', "deploy"), ["deploy/out.json"]);
  assert.deepEqual(pathsInLine('write("backend/data/cache.json")', "backend/src"), [
    "backend/data/cache.json",
    "backend/src/backend/data/cache.json",
  ]);
  assert.deepEqual(pathsInLine('write("../tmp/x.log")', "a/b"), ["a/tmp/x.log"]);
  assert.deepEqual(pathsInLine("cat /etc/hosts.txt > /tmp/out.json", "a"), []);
  assert.deepEqual(pathsInLine('fetch("https://example.com/data.json")', "a"), []);
  assert.deepEqual(pathsInLine("const x = process.env.FOO;", "a"), []);
});

test("read_repo_file refuses paths outside the repo and lists directories", async () => {
  let fetched = 0;
  const read = async (p: string): Promise<RepoEntry> => {
    fetched++;
    return p === "backend" ? { kind: "dir", entries: ["file backend/package.json", "dir  backend/src"] } : null;
  };
  assert.match(await runRepoRead({ path: "../../etc/passwd" }, read), /^Refused/);
  assert.match(await runRepoRead({ path: "a/../../x" }, read), /^Refused/);
  assert.equal(fetched, 0);
  assert.match(await runRepoRead({ path: "/backend/" }, read), /Directory `backend`[\s\S]*backend\/package\.json/);
  assert.match(await runRepoRead({ path: "nope.txt" }, read), /does not exist at the PR head/);
});

test("the lookup loop forces the verdict tool once the lookup budget is spent", async () => {
  const choices: unknown[] = [];
  const send: SendTurn = async (_messages, choice) => {
    choices.push(choice);
    if ((choice as { type: string }).type === "any") {
      return fakeMessage([{ type: "tool_use", id: `r${choices.length}`, name: "read_repo_file", input: { path: "x" } }]);
    }
    return fakeMessage([{ type: "tool_use", id: "v", name: "submit_review_verdict", input: { criteria: [] } }]);
  };
  const res = await runLookupLoop({
    send,
    messages: [{ role: "user", content: "u" }],
    tool: reviewVerdictTool,
    lookups: [{ tool: readRepoFileTool, run: async () => "missing" }],
    maxLookupTurns: 2,
  });
  assert.deepEqual(choices, [{ type: "any" }, { type: "any" }, { type: "tool", name: "submit_review_verdict" }]);
  assert.deepEqual(res.input, { criteria: [] });
});

test("the review prompt carries the repo-state section after the diff, with criteria still first", async () => {
  const facts = await gatherIgnoreFacts({ diff: PR263_DIFF, criteria: [CRITERION], read: readFile });
  const text = buildReviewUserText({
    criteria: [CRITERION],
    prior: new Map(),
    context: { diff: PR263_DIFF, commits: "", guidance: "", sources: [] },
    repoState: renderRepoStateSection(facts),
  });
  assert.ok(text.startsWith("# Criteria\n- 3: "));
  const diffAt = text.indexOf("# Diff");
  const stateAt = text.indexOf("# Repository state outside the diff");
  assert.ok(diffAt > 0 && stateAt > diffAt);
  assert.match(text, /`\.gitignore:14`/);
});

test("offline, the lookup path answers exactly like completeStructured and never reads the repo", async () => {
  let reads = 0;
  const res = await completeStructuredWithLookups({
    system: reviewSystemPrompt(),
    messages: [{ role: "user", content: "# Criteria\n- 3: x\n  [not yet evaluated]\n\n# Diff\n" }],
    tool: reviewVerdictTool,
    lookups: [{ tool: readRepoFileTool, run: async () => (reads++, "") }],
  });
  assert.equal(reads, 0);
  assert.equal((res.input as { criteria: Array<{ id: string }> }).criteria[0].id, "3");
});

function fakeMessage(content: Array<Record<string, unknown>>): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "test",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}
