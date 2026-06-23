// Repo indexer. Builds and maintains a per-file LLM-generated summary of the
// repository so the PR-review pipeline can reason about regressions, critical
// errors, and security flaws beyond the diff itself.
//
// Triggered by `enqueueIndex(...)` from queue.ts and dispatched by worker.ts.
// Full build: walk the default-branch tree, summarise each allowed file with
// Haiku, store in `repoIndex`. Incremental: re-summarise only the paths a
// merged PR touched. SHA-keyed cache means re-runs on unchanged files are free.

import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { gh, installationToken } from "../github/app.js";
import { complete, currentUsage, withUsage } from "../llm.js";
import { track } from "../statsig.js";
import type { Installation, RepoIndexEntry, Repository, ReviewLogEntry, User, Vulnerability, VulnerabilitySeverity } from "../types.js";

// Per-run summary returned by the full/incremental builders so buildRepoIndex can
// emit one "repo indexed" analytics event with the counts + the rolled-up usage.
type IndexSummary = {
  mode: "full" | "incremental";
  fileCount: number | null; // total indexed files (full only; null for incremental)
  summarised: number;
  cacheHits: number;
  removed: number;
  commit: string | null;
};

// Statsig actor for the repo owner — full User when found, else the userId string,
// else null for an unattached install (nothing to attribute the event to).
function analyticsUser(userId: string | undefined): User | string | null {
  if (!userId) return null;
  return db.find("users", (u) => u.id === userId) ?? userId;
}

const INDEX_MODEL = "claude-haiku-4-5";
// The gated security sub-pass uses the configured frontier model, not Haiku:
// security reasoning is the one place the cheap summariser isn't good enough,
// and the result is sha-cached so we pay the frontier call once per blob.
const SECURITY_MODEL = config.llm.model;
const MAX_FILE_BYTES = 256_000;
const MAX_PATH_LEN = 256;
const ALLOWED_JSON_BYTES = 50_000;       // .json files are allowed only when small
const CONCURRENCY = 8;
const MAX_LLM_RETRIES = 3;

// Directory prefixes we never index — vendor/build/lock content provides no
// useful review signal and would balloon both the LLM bill and the JSON DB.
const SKIP_DIR_PREFIXES = [
  "node_modules/", "dist/", "build/", ".next/", "out/", ".git/",
  "coverage/", "vendor/", "__pycache__/", ".venv/", "target/",
  ".terraform/", ".cache/", ".turbo/", ".parcel-cache/",
];

const SKIP_PATH_REGEX = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.lock$/,
  /\.lockb$/,
  /-lock\.json$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
];

const BINARY_EXT = new Set([
  "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "mov", "webm", "mp3", "wav", "ogg",
  "pdf", "zip", "tar", "gz", "tgz", "rar", "7z",
  "exe", "dll", "so", "dylib", "class", "jar",
]);

const ALLOWED_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "php", "cs",
  "c", "cc", "cpp", "h", "hpp",
  "css", "scss", "html", "vue", "svelte",
  "sql", "md", "yml", "yaml", "toml", "json",
]);

const FILE_SUMMARY_SYSTEM =
  "You are DevAsign's file summarisation step. Read a single source file and emit ONLY JSON: " +
  '{"summary": string, "exports": [string], "imports": [string], "securityFlags": [string]}. ' +
  "`summary` is 2-4 sentences describing what this file does and its role in the repo. " +
  "`exports` lists top-level symbol names (functions, classes, constants) declared in the file. " +
  "`imports` lists module specifiers as written (relative paths like './db.js' or package names like '@anthropic-ai/sdk'). " +
  "`securityFlags` are short tags for security-sensitive patterns you observe " +
  '(examples: "reads-env", "writes-env", "raw-sql", "executes-shell", "handles-auth", "parses-user-input", "uses-crypto"). ' +
  "Be terse, factual, and skip narrative. Do not invent symbols or imports that are not in the file.";

// Gated security sub-pass (SECURITY_MODEL). Runs only on files the summariser
// flagged as security-sensitive. Reports concrete, in-file vulnerabilities —
// this is the whole-codebase audit's detector, distinct from the PR-time
// "did this diff introduce a vuln" check in the review pipeline.
const SECURITY_SCAN_SYSTEM =
  "You are DevAsign's file security audit step. Read a single source file and report ONLY real, concrete " +
  "vulnerabilities that are actually present IN THIS FILE. Look for: injection (SQL/command/template), missing or " +
  "broken authentication/authorization, secrets or credentials committed in source, unsafe deserialization, SSRF, " +
  "path traversal, XSS, weak or misused cryptography, and unvalidated/untrusted input reaching a dangerous sink. " +
  'Emit ONLY JSON: {"vulnerabilities": [{"class": string, "severity": "blocker"|"warn", "symbol": string?, ' +
  '"line": number?, "concern": string, "fixPrompt": string}]}. ' +
  '`class` is a short taxonomy tag (e.g. "sql-injection", "command-injection", "xss", "ssrf", "path-traversal", ' +
  '"missing-authz", "hardcoded-secret", "weak-crypto", "unsafe-deserialization"). ' +
  'Use severity="blocker" only for a directly exploitable vulnerability that exposes data, allows code/command ' +
  'execution, or bypasses auth; use "warn" for a plausible weakness that needs human review. ' +
  "Only report issues genuinely present in the provided file — never speculate, never flag style, and prefer an " +
  "empty array over padding. " +
  "Each vulnerability MUST include a `fixPrompt` the user can paste into another AI coding agent (Cursor / Claude " +
  "Code / Codex). Use this exact template:\n" +
  "Fix: <one-line summary>\n\n" +
  "File: <path>\n" +
  "Symbol: <function/class name, or 'n/a'>\n\n" +
  "Issue:\n<2-3 sentence description of the vulnerability and how it is exploitable>\n\n" +
  "Expected behavior:\n<1-2 sentences: the secure behavior once fixed>\n\n" +
  "Suggested approach:\n<concrete remediation steps>";

export type ChangedPaths = {
  added: string[];
  modified: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
};

export async function buildRepoIndex(
  repoId: string,
  opts: { full: boolean; changedPaths?: ChangedPaths }
): Promise<void> {
  const repo = db.find("repositories", (r) => r.id === repoId);
  if (!repo) {
    console.warn(`[indexer] repo ${repoId} not found, skipping`);
    return;
  }

  // Skip empty incremental runs (e.g. a merge that touched only ignored paths).
  if (!opts.full && (!opts.changedPaths || !changedPathsHaveWork(opts.changedPaths))) {
    log(repoId, "Index skipped — no relevant changes", "ingest");
    return;
  }

  setIndexState(repo.id, { indexState: "indexing", indexError: null });
  log(repoId, opts.full ? "Index started (full)" : "Index started (incremental)", "ingest", {
    files: opts.full ? undefined : opts.changedPaths,
  });

  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) {
    // Dev / unattached state: nothing to fetch. Mark as ready with zero files so
    // the downstream holistic step's "ready" gate is satisfied and the pipeline
    // can keep running end-to-end without a GitHub App.
    setIndexState(repo.id, {
      indexState: "ready",
      indexedAt: Date.now(),
      indexedFileCount: 0,
      indexError: null,
    });
    log(repoId, "Index skipped — no installation token (dev mode)", "ingest");
    return;
  }

  const t0 = Date.now();
  const indexUser = analyticsUser(install.userId);
  try {
    // withUsage scopes token/cost accounting to this build; read it (and emit the
    // event) inside the scope, since currentUsage() is null once it returns.
    await withUsage(async () => {
      const summary = opts.full
        ? await runFullIndex(repo, install)
        : await runIncrementalIndex(repo, install, opts.changedPaths!);
      if (indexUser) {
        const usage = currentUsage();
        const idx = db.filter("repoIndex", (e) => e.repoId === repo.id);
        const vulnFiles = idx.filter((e) => (e.vulnerabilities?.length ?? 0) > 0).length;
        const vulnCount = idx.reduce((n, e) => n + (e.vulnerabilities?.length ?? 0), 0);
        track(indexUser, "repo indexed", {
          repo: `${repo.owner}/${repo.name}`,
          mode: summary.mode,
          index_model: INDEX_MODEL,
          security_model: SECURITY_MODEL,
          vuln_files: vulnFiles,
          vuln_count: vulnCount,
          file_count: summary.fileCount,
          summarised: summary.summarised,
          cache_hits: summary.cacheHits,
          removed: summary.removed,
          commit: summary.commit,
          is_private: repo.private,
          duration_ms: Date.now() - t0,
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: usage?.outputTokens ?? 0,
          cache_read_tokens: usage?.cacheReadTokens ?? 0,
          est_cost_usd: usage ? Number(usage.costUsd.toFixed(4)) : 0,
        });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[indexer] ${repo.owner}/${repo.name} failed:`, err);
    setIndexState(repo.id, { indexState: "errored", indexError: msg });
    log(repoId, "Index errored", "error", { error: msg });
    if (indexUser) {
      track(indexUser, "repo index failed", {
        repo: `${repo.owner}/${repo.name}`,
        mode: opts.full ? "full" : "incremental",
        error: msg.slice(0, 200),
      });
    }
  }
}

// ─── Full build ───────────────────────────────────────────────────────────

async function runFullIndex(repo: Repository, install: Installation): Promise<IndexSummary> {
  const headSha = await fetchHeadSha(repo, install);

  // List blobs on the default branch in a single tree call.
  const tree = await gh<{ tree: Array<{ path: string; type: string; size?: number; sha: string }> }>(
    install.installationId,
    `/repos/${repo.owner}/${repo.name}/git/trees/${headSha}?recursive=1`
  );

  const candidates = tree.tree.filter((entry) => entry.type === "blob" && isIndexable(entry.path, entry.size ?? 0));

  const existing = db.filter("repoIndex", (e) => e.repoId === repo.id);
  const existingByPath = new Map(existing.map((e) => [e.path, e]));
  const seenPaths = new Set<string>();

  const tasks: Array<{ path: string; sha: string; size: number }> = candidates.map((c) => ({
    path: c.path,
    sha: c.sha,
    size: c.size ?? 0,
  }));

  let processed = 0;
  let summarised = 0;
  let cacheHits = 0;
  await runPool(tasks, CONCURRENCY, async (t) => {
    seenPaths.add(t.path);
    const prior = existingByPath.get(t.path);
    if (prior && prior.sha === t.sha) {
      cacheHits++;
      // Summary is cached, but a flagged file may still owe a security scan
      // (legacy row / first run after the pass shipped) — backfill it here.
      await backfillSecurityScanIfOwed(repo, install, prior);
      processed++;
      return;
    }
    const ok = await summariseAndUpsert(repo, install, t.path, t.sha, t.size, prior);
    if (ok) summarised++;
    processed++;
  });

  // Drop entries that no longer exist on the default branch.
  let removed = 0;
  for (const e of existing) {
    if (!seenPaths.has(e.path)) {
      db.remove("repoIndex", (x) => x.id === e.id);
      removed++;
    }
  }

  setIndexState(repo.id, {
    indexState: "ready",
    indexedAt: Date.now(),
    indexedCommit: headSha,
    indexedFileCount: seenPaths.size,
    indexError: null,
  });
  log(repo.id, "Index built", "ingest", {
    processed,
    summarised,
    cacheHits,
    removed,
    commit: headSha,
  });
  return { mode: "full", fileCount: seenPaths.size, summarised, cacheHits, removed, commit: headSha };
}

// ─── Incremental update ───────────────────────────────────────────────────

async function runIncrementalIndex(
  repo: Repository,
  install: Installation,
  changed: ChangedPaths
): Promise<IndexSummary> {
  const headSha = await fetchHeadSha(repo, install).catch(() => null);

  // Removed first so we don't keep stale rows around.
  let removed = 0;
  for (const p of changed.removed) {
    if (!isIndexable(p, 0)) continue;
    removed += db.remove("repoIndex", (e) => e.repoId === repo.id && e.path === p);
  }
  for (const { from } of changed.renamed) {
    if (!isIndexable(from, 0)) continue;
    removed += db.remove("repoIndex", (e) => e.repoId === repo.id && e.path === from);
  }

  // Modified and added are re-fetched + re-summarised. Need fresh sha+size per
  // path; query the tree once on the new HEAD if we got it, otherwise per-file.
  const toUpdate = Array.from(new Set([...changed.added, ...changed.modified]))
    .filter((p) => isIndexable(p, 0));

  let summarised = 0;
  let cacheHits = 0;
  await runPool(toUpdate, CONCURRENCY, async (path) => {
    let sha = "";
    let size = 0;
    try {
      // contents endpoint gives sha + size in one shot
      const file = await gh<{ sha: string; size: number; type: string }>(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}${headSha ? `?ref=${headSha}` : ""}`
      );
      if (file.type !== "file") return;
      sha = file.sha;
      size = file.size;
      if (size > MAX_FILE_BYTES) return;
    } catch {
      // path may have been deleted between merge and now; skip silently
      return;
    }
    const prior = db.find("repoIndex", (e) => e.repoId === repo.id && e.path === path);
    if (prior && prior.sha === sha) {
      cacheHits++;
      await backfillSecurityScanIfOwed(repo, install, prior);
      return;
    }
    const ok = await summariseAndUpsert(repo, install, path, sha, size, prior || undefined);
    if (ok) summarised++;
  });

  setIndexState(repo.id, {
    indexState: "ready",
    indexedAt: Date.now(),
    indexedCommit: headSha || repo.indexedCommit,
    indexError: null,
  });
  log(repo.id, "Index updated (incremental)", "ingest", {
    summarised,
    cacheHits,
    removed,
    commit: headSha || repo.indexedCommit,
  });
  return {
    mode: "incremental",
    fileCount: null,
    summarised,
    cacheHits,
    removed,
    commit: headSha || repo.indexedCommit || null,
  };
}

// ─── Per-file path: fetch raw, summarise, upsert ──────────────────────────

async function summariseAndUpsert(
  repo: Repository,
  install: Installation,
  path: string,
  sha: string,
  size: number,
  prior: RepoIndexEntry | undefined
): Promise<boolean> {
  let content: string;
  try {
    content = await fetchBlob(repo, install, path, sha);
  } catch (err) {
    console.warn(`[indexer] fetch ${path} failed:`, err);
    return false;
  }
  if (!content) return false;

  const summary = await summariseFile(path, content);
  if (!summary) return false;

  const language = path.split(".").pop()?.toLowerCase() || "";
  // Gated security sub-pass: only files the summariser flagged as sensitive pay
  // the frontier call, and we reuse the `content` already in hand (no extra
  // fetch). securityScannedSha is set to `sha` either way, so an unflagged file
  // is recorded as evaluated and isn't reconsidered until its content changes.
  const vulnerabilities = summary.securityFlags.length
    ? await scanFileSecurity(path, content, sha)
    : [];
  const row: RepoIndexEntry = {
    id: prior?.id || uuid(),
    repoId: repo.id,
    path,
    sha,
    size,
    language,
    summary: summary.summary,
    exports: summary.exports,
    imports: summary.imports,
    securityFlags: summary.securityFlags,
    vulnerabilities,
    securityScannedSha: sha,
    indexedAt: Date.now(),
    model: INDEX_MODEL,
  };
  if (prior) {
    db.update("repoIndex", (e) => e.id === prior.id, row);
  } else {
    db.insert("repoIndex", row);
  }
  return true;
}

// Exported for reuse by the DEVASIGN.md guidance pass (see devasign.ts), which
// fetches doc blobs by sha from the PR head tree the same way the indexer does.
export async function fetchBlob(
  repo: Repository,
  install: Installation,
  path: string,
  sha: string
): Promise<string> {
  // Use the git blob endpoint with raw media type — avoids the base64 overhead
  // on contents API and works regardless of branch ref.
  const token = await installationToken(install.installationId);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "devasign-app",
    },
  });
  if (res.status === 429 || res.status === 403) {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
    const waitMs = Math.max(1000, reset - Date.now());
    console.warn(`[indexer] github ${res.status} — sleeping ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
    return fetchBlob(repo, install, path, sha);
  }
  if (!res.ok) throw new Error(`blob ${res.status} on ${path}`);
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) return text.slice(0, MAX_FILE_BYTES);
  return text;
}

async function summariseFile(path: string, content: string): Promise<
  { summary: string; exports: string[]; imports: string[]; securityFlags: string[] } | null
> {
  const userText = `Path: ${path}\n\n\`\`\`\n${content}\n\`\`\``;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      const raw = await complete({
        system: FILE_SUMMARY_SYSTEM,
        model: INDEX_MODEL,
        cacheSystem: true,
        messages: [{ role: "user", content: userText }],
        maxTokens: 600,
      });
      const parsed = tryParseJSON(raw);
      if (!parsed) continue;
      return {
        summary: String(parsed.summary || "").slice(0, 800),
        exports: arrOfStr(parsed.exports),
        imports: arrOfStr(parsed.imports),
        securityFlags: arrOfStr(parsed.securityFlags),
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const is429 = /429/.test(msg) || /rate/i.test(msg);
      if (is429 && attempt < MAX_LLM_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        continue;
      }
      console.warn(`[indexer] summarise ${path} failed:`, msg);
      return null;
    }
  }
  return null;
}

// ─── Security sub-pass ────────────────────────────────────────────────────

// Run the gated frontier security scan on one file's contents and shape the
// model output into stored Vulnerability rows. Mirrors summariseFile's retry /
// 429-backoff handling. Returns [] on any failure so a flaky scan never blocks
// indexing — the file is simply recorded as scanned with no findings.
async function scanFileSecurity(path: string, content: string, sha: string): Promise<Vulnerability[]> {
  const userText = `Path: ${path}\n\n\`\`\`\n${content}\n\`\`\``;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      const raw = await complete({
        system: SECURITY_SCAN_SYSTEM,
        model: SECURITY_MODEL,
        cacheSystem: true,
        messages: [{ role: "user", content: userText }],
        maxTokens: 1500,
      });
      const parsed = tryParseJSON(raw);
      if (!parsed) continue;
      return buildVulns(parsed.vulnerabilities, path, sha);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const is429 = /429/.test(msg) || /rate/i.test(msg);
      if (is429 && attempt < MAX_LLM_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        continue;
      }
      console.warn(`[indexer] security scan ${path} failed:`, msg);
      return [];
    }
  }
  return [];
}

// Coerce the model's vulnerability array into stored rows: drop malformed/empty
// items, clamp severity to blocker|warn, stamp path/sha/model, and cap the count
// so one noisy file can't balloon the index row. Exported for testing.
export function buildVulns(input: unknown, path: string, sha: string): Vulnerability[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const out: Vulnerability[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const concern = String((item as any).concern || "").trim();
    if (!concern) continue;
    const cls = String((item as any).class || "").trim() || "unspecified";
    const severity: VulnerabilitySeverity = (item as any).severity === "blocker" ? "blocker" : "warn";
    const symbol = (item as any).symbol;
    const line = (item as any).line;
    const fixPrompt = String((item as any).fixPrompt || "").trim();
    out.push({
      id: uuid(),
      class: cls.slice(0, 60),
      severity,
      path,
      ...(typeof symbol === "string" && symbol ? { symbol: symbol.slice(0, 120) } : {}),
      ...(typeof line === "number" && Number.isFinite(line) ? { line } : {}),
      concern,
      fixPrompt,
      detectedSha: sha,
      detectedAt: now,
      model: SECURITY_MODEL,
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Backfill the security sub-pass for a flagged file that's a summary cache hit
// (sha unchanged) but hasn't been scanned at this sha — e.g. a row indexed
// before the security pass existed, or one whose scan we still owe. Costs one
// blob fetch + one frontier call, once: afterwards securityScannedSha matches
// and steady-state cache hits are free again. Returns true if it ran.
async function backfillSecurityScanIfOwed(
  repo: Repository,
  install: Installation,
  prior: RepoIndexEntry
): Promise<boolean> {
  const owed = (prior.securityFlags?.length ?? 0) > 0 && prior.securityScannedSha !== prior.sha;
  if (!owed) return false;
  let content: string;
  try {
    content = await fetchBlob(repo, install, prior.path, prior.sha);
  } catch (err) {
    console.warn(`[indexer] backfill fetch ${prior.path} failed:`, err);
    return false;
  }
  if (!content) return false;
  const vulnerabilities = await scanFileSecurity(prior.path, content, prior.sha);
  db.update("repoIndex", (e) => e.id === prior.id, {
    vulnerabilities,
    securityScannedSha: prior.sha,
  });
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function fetchHeadSha(repo: Repository, install: Installation): Promise<string> {
  const branch = await gh<{ commit: { sha: string } }>(
    install.installationId,
    `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.defaultBranch)}`
  );
  return branch.commit.sha;
}

export function isIndexable(path: string, size: number): boolean {
  if (!path || path.length > MAX_PATH_LEN) return false;
  for (const dir of SKIP_DIR_PREFIXES) {
    if (path === dir || path.startsWith(dir) || path.includes(`/${dir}`)) return false;
  }
  for (const re of SKIP_PATH_REGEX) if (re.test(path)) return false;
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (BINARY_EXT.has(ext)) return false;
  if (!ALLOWED_EXT.has(ext)) return false;
  if (size > MAX_FILE_BYTES) return false;
  if (ext === "json" && size > ALLOWED_JSON_BYTES) return false;
  return true;
}

function changedPathsHaveWork(c: ChangedPaths): boolean {
  return (
    c.added.length > 0 ||
    c.modified.length > 0 ||
    c.removed.length > 0 ||
    c.renamed.length > 0
  );
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

function arrOfStr(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v) => typeof v === "string").slice(0, 40);
}

function tryParseJSON(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function setIndexState(repoId: string, patch: Partial<Repository>) {
  db.update("repositories", (r) => r.id === repoId, patch);
}

// reviewLogs is keyed by reviewId; use a sentinel `_repo:<id>` so per-repo
// index events live alongside review events without colliding.
function log(
  repoId: string,
  action: string,
  kind: ReviewLogEntry["kind"] = "ingest",
  meta?: Record<string, unknown>
) {
  const entry: ReviewLogEntry = {
    id: uuid(),
    reviewId: `_repo:${repoId}`,
    kind,
    at: Date.now(),
    action,
    meta,
  };
  db.insert("reviewLogs", entry);
}

// ─── Concurrency primitive (no new deps) ──────────────────────────────────

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      try {
        await fn(item);
      } catch (err) {
        console.warn("[indexer] worker error:", err);
      }
    }
  });
  await Promise.all(workers);
}
