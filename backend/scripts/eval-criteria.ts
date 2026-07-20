// Prompt-quality eval for bounty acceptance criteria.
//
// The offline mock returns four fixed criteria whatever you feed it, so the
// unit suite proves the drafting plumbing works and NOTHING about whether the
// criteria are any good. This runs the real prompt against real GitHub issues
// and has a second model judge each criterion against the four failure modes
// the prompt's guardrails target. It is a pre-ship gate read by a human, not a
// CI step: it needs a live API key and costs a few dollars a pass.
//
//   npm run eval:criteria -- --repo-root ..
//   npm run eval:criteria -- --corpus ./my-corpus.json --limit 3 --out report.md
//
// Env is pinned before the dynamic imports below — dotenv inside config.ts
// never overrides keys already present in process.env, so these win over
// backend/.env regardless of cwd. DATABASE_URL is blanked for a free in-memory
// store; ANTHROPIC_API_KEY is deliberately NOT blanked (that is the whole
// point) and is read from your .env as usual.
process.env.DATABASE_URL = "";
process.env.STATSIG_SECRET_KEY = ""; // an eval run must not pollute analytics

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Type-only imports are fully erased, so these do NOT pull the modules in
// ahead of the env pin above — the values still come from the dynamic imports.
import type { IngestedSource } from "../src/review/pipeline.js";
import type { IndexedFile } from "../src/bounties/criteria-context.js";
import type { EvalCase, JudgeVerdict } from "../src/bounties/criteria-eval.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const CORPUS_PATH = arg("corpus") ?? path.join(SCRIPT_DIR, "eval-criteria-corpus.json");
const REPO_ROOT = arg("repo-root");
const OUT_PATH = arg("out");
const LIMIT = Number(arg("limit") ?? "0") || 0;

// ── dynamic imports (after the env pin above) ────────────────────────────────

const { isLLMLive, config } = await import("../src/config.js");
const { complete } = await import("../src/llm.js");
const { synthesizeCriteriaCore } = await import("../src/review/pipeline.js");
const { selectRepoContext, renderRepoContext } = await import("../src/bounties/criteria-context.js");
const { JUDGE_SYSTEM_PROMPT, parseJudgeVerdicts, scoreCriteria, summarizeEval, CRITERION_FLAGS } =
  await import("../src/bounties/criteria-eval.js");

if (!isLLMLive()) {
  console.warn(
    "[eval] ANTHROPIC_API_KEY is unset — running against the offline mock.\n" +
      "       That only smoke-tests the harness; it cannot judge prompt quality.\n" +
      "       Set the key in backend/.env for a real run."
  );
}

// ── corpus ───────────────────────────────────────────────────────────────────

// `repoRoot` is per-entry and points at a local checkout of THAT issue's repo.
// Repo context has to be paired with its own codebase: feeding one project's
// issue another project's file summaries would flag `invented_from_context`
// noise that says nothing about the prompt.
type CorpusEntry = { url: string; note?: string; repoRoot?: string };

const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

async function loadCorpus(): Promise<CorpusEntry[]> {
  const raw = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  const entries: CorpusEntry[] = Array.isArray(raw) ? raw : raw.issues;
  if (!Array.isArray(entries) || !entries.length) throw new Error(`empty corpus: ${CORPUS_PATH}`);
  return LIMIT ? entries.slice(0, LIMIT) : entries;
}

/**
 * Fetch a PUBLIC issue with no credentials. gh() needs an installation id we
 * don't have in a script, and there is no PAT env var anywhere in this repo —
 * so this copies the unauthenticated shape already used in server.ts for the
 * app-metadata lookup. GitHub allows 60 req/hr per IP, ample for a corpus.
 */
async function fetchIssue(url: string): Promise<{ ref: string; title: string; body: string } | null> {
  const m = ISSUE_URL_RE.exec(url.trim());
  if (!m) {
    console.warn(`[eval] skipping malformed issue url: ${url}`);
    return null;
  }
  const [, owner, repo, number] = m;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "devasign-eval" },
    });
    if (!resp.ok) {
      console.warn(`[eval] ${url} → HTTP ${resp.status}`);
      return null;
    }
    const issue: any = await resp.json();
    return {
      ref: `${owner}/${repo}#${number}`,
      title: String(issue?.title ?? ""),
      body: typeof issue?.body === "string" ? issue.body : "",
    };
  } catch (err) {
    console.warn(`[eval] ${url} fetch failed:`, err);
    return null;
  }
}

// ── local repo index (no API, no cost) ───────────────────────────────────────

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|cs|cc|cpp)$/i;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo",
  "vendor", "target", "__pycache__", ".venv",
]);
const MAX_INDEX_FILES = 2000;

/**
 * Approximate a RepoIndexEntry set by walking a local checkout.
 *
 * The real index is per-file Haiku summaries, which costs an indexing run.
 * A leading comment block plus regex-extracted exports is a much cruder
 * summary, but it is free and it is enough to exercise the one failure mode
 * that is otherwise untestable: whether the model invents requirements out of
 * `repo_context` instead of the issue.
 */
async function buildLocalIndex(root: string): Promise<IndexedFile[]> {
  const files: IndexedFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_INDEX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_INDEX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (CODE_EXT.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
        try {
          const [text, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
          files.push({
            path: path.relative(root, full),
            size: info.size,
            summary: leadingComment(text),
            exports: exportedNames(text),
          });
        } catch {
          // unreadable file — skip
        }
      }
    }
  }

  await walk(root);
  return files;
}

/** The file's leading `//` run or first block comment — its de-facto summary. */
function leadingComment(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (out.length) break;
      continue;
    }
    if (t.startsWith("//")) out.push(t.replace(/^\/\/\s?/, ""));
    else if (t.startsWith("/*") || t.startsWith("*")) out.push(t.replace(/^\/?\*+\/?\s?/, ""));
    else break;
    if (out.join(" ").length > 400) break;
  }
  return out.join(" ").trim();
}

function exportedNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  return [...names].slice(0, 30);
}

// ── the run ──────────────────────────────────────────────────────────────────

async function judge(args: {
  ref: string;
  issueText: string;
  contextPaths: string[];
  criteria: string[];
}): Promise<JudgeVerdict[]> {
  if (!args.criteria.length) return [];
  // `[n]` indices are what the judge keys its verdicts to (and what the offline
  // mock echoes back), so the numbering here is load-bearing.
  const user =
    `# Issue\n${args.ref}\n\n${args.issueText}\n\n` +
    (args.contextPaths.length
      ? `# Background repository files shown to the drafter\n${args.contextPaths.map((p) => `- ${p}`).join("\n")}\n\n`
      : "# Background repository files shown to the drafter\n(none)\n\n") +
    `# Drafted criteria\n${args.criteria.map((c, i) => `[${i}] ${c}`).join("\n")}`;
  const raw = await complete({
    system: JUDGE_SYSTEM_PROMPT,
    cacheSystem: true,
    messages: [{ role: "user", content: user }],
  });
  return parseJudgeVerdicts(raw, args.criteria.length);
}

const corpus = await loadCorpus();
console.log(`[eval] ${corpus.length} issues · model ${config.llm.model}\n`);

// One index per checkout, built lazily and reused across that repo's issues.
const indexCache = new Map<string, IndexedFile[]>();
async function indexFor(root: string | undefined): Promise<IndexedFile[]> {
  if (!root) return [];
  const abs = path.resolve(root);
  const cached = indexCache.get(abs);
  if (cached) return cached;
  const files = await buildLocalIndex(abs);
  console.log(`[eval] indexed ${files.length} local files from ${abs}`);
  indexCache.set(abs, files);
  return files;
}

const cases: EvalCase[] = [];

for (const entry of corpus) {
  const issue = await fetchIssue(entry.url);
  if (!issue) continue;

  const issueText = `${issue.title}\n\n${issue.body}`.trim();
  const index = await indexFor(entry.repoRoot ?? REPO_ROOT);
  const selection = index.length ? selectRepoContext(issueText, index) : { files: [], manifest: [] };
  const contextSources: IngestedSource[] = index.length ? renderRepoContext(selection) : [];

  const sources: IngestedSource[] = [
    { kind: "github_issue_primary", ref: issue.ref, text: issueText },
    ...contextSources,
  ];

  const { endGoal, criteria } = await synthesizeCriteriaCore({
    title: issue.title,
    sources,
    hasAuthoritativeSpec: Boolean(issue.body.trim()),
    mode: "bounty",
  });
  const texts = criteria.map((c) => c.text);

  const verdicts = await judge({
    ref: issue.ref,
    issueText,
    contextPaths: selection.files.map((f) => f.path),
    criteria: texts,
  });

  const scored = scoreCriteria({ ref: issue.ref, endGoal, criteria: texts, verdicts });
  cases.push(scored);

  const flagNote = scored.flaggedCount ? `${scored.flaggedCount} flagged` : "clean";
  console.log(`${issue.ref} — ${texts.length} criteria, ${flagNote}${entry.note ? `  (${entry.note})` : ""}`);
  for (const s of scored.scored) {
    const mark = s.flags.length ? `!! [${s.flags.join(", ")}]` : "ok";
    console.log(`   ${mark} ${s.text}`);
    if (s.flags.length && s.note) console.log(`      ↳ ${s.note}`);
  }
  if (scored.lint.length) {
    console.log(`   lint: ${scored.lint.map((f) => `${f.lint}${f.index != null ? `#${f.index}` : ""}`).join(", ")}`);
  }
  console.log();
}

const summary = summarizeEval(cases);
console.log("─".repeat(60));
console.log(`issues            ${summary.cases}  (${summary.emptyCases} produced no criteria)`);
console.log(`criteria          ${summary.totalCriteria}`);
console.log(`flagged           ${summary.flagged}  (${(summary.flagRate * 100).toFixed(1)}%)`);
for (const flag of CRITERION_FLAGS) console.log(`  ${flag.padEnd(24)}${summary.byFlag[flag]}`);
console.log(`lint findings     ${summary.lintFindings}`);
if (summary.unjudged) console.log(`unjudged          ${summary.unjudged}  (judge returned no verdict)`);
console.log(`verdict           ${summary.passed ? "PASS" : "FAIL"}`);

if (OUT_PATH) {
  await writeFile(OUT_PATH, renderMarkdown(cases, summary), "utf8");
  console.log(`\n[eval] report written to ${OUT_PATH}`);
}

function renderMarkdown(cases: EvalCase[], summary: ReturnType<typeof summarizeEval>): string {
  const lines: string[] = [
    "# Bounty criteria eval",
    "",
    `- model: \`${config.llm.model}\``,
    `- issues: ${summary.cases} (${summary.emptyCases} produced no criteria)`,
    `- criteria: ${summary.totalCriteria}`,
    `- flagged: ${summary.flagged} (${(summary.flagRate * 100).toFixed(1)}%)`,
    `- lint findings: ${summary.lintFindings}`,
    `- verdict: **${summary.passed ? "PASS" : "FAIL"}**`,
    "",
    "| flag | count |",
    "| --- | --- |",
    ...CRITERION_FLAGS.map((f) => `| ${f} | ${summary.byFlag[f]} |`),
    "",
  ];
  for (const c of cases) {
    lines.push(`## ${c.ref}`, "", `**End goal:** ${c.endGoal || "_(none)_"}`, "");
    if (!c.criteria.length) lines.push("_No criteria drafted._", "");
    for (const s of c.scored) {
      lines.push(`- ${s.flags.length ? `**[${s.flags.join(", ")}]** ` : ""}${s.text}`);
      if (s.flags.length && s.note) lines.push(`  - ${s.note}`);
    }
    if (c.lint.length) {
      lines.push("", `_Lint:_ ${c.lint.map((f) => `${f.lint} — ${f.detail}`).join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

process.exit(summary.passed ? 0 : 1);
