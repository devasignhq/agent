// Baseline eval: runs the PRODUCTION security audit path over the benchmark
// fixture (evals/security/vendor/secbench) with no GitHub involved, and scores it
// against the fixture's manifest of known answers. The number that matters is how
// many decoys and fixed-tree cases come out surfaced — those are the false reports
// a customer sees today.
//
//   npm run eval:security                       # mock LLM: wiring smoke test only
//   npm run eval:security -- --runs 3 --out /tmp/sec-baseline.json
//
// Mirror prod's provider for a meaningful baseline, e.g.
//   LLM_PROVIDER=vertex VERTEX_PROJECT=… npm run eval:security -- --runs 3

// Pinned BEFORE the dynamic imports below: config.ts/llm.ts read these at module
// load, and dotenv never overrides an already-set key. LLM credentials are
// deliberately left alone — a real run needs them.
process.env.DATABASE_URL = "";
process.env.STATSIG_SECRET_KEY = "";

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchCase, BenchDetection, BenchTree, RunScore } from "../src/security/bench-score.js";
import type { AgentFinding } from "../src/security/agent.js";
import type { RepoIndexEntry } from "../src/types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(SCRIPT_DIR, "..", "evals", "security", "vendor", "secbench");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const RUNS = Math.max(1, Number(arg("runs") ?? "1") || 1);
const ONLY_TREE = arg("tree") as BenchTree | "both" | undefined;
const ONLY_CASE = arg("case");
const OUT_PATH = arg("out");
const CONCURRENCY = Math.max(1, Number(arg("concurrency") ?? "4") || 4);
const USE_SUMMARISER = arg("no-summariser") === undefined;

const { isLLMLive, config } = await import("../src/config.js");
const { currentUsage, withUsage } = await import("../src/llm.js");
const { AUDIT_MODEL, scanFile } = await import("../src/security/agent.js");
const { DEFAULT_SECURITY_POLICY } = await import("../src/security/policy.js");
const { selectCandidates } = await import("../src/security/audit.js");
const { applyVerdict, buildEvidenceBundle, holdVerification, mechanicalCheck, verifyFindings } = await import(
  "../src/security/verify.js"
);
const { buildLocalIndex } = await import("../src/security/local-index.js");
const { headline, rates, scoreRun } = await import("../src/security/bench-score.js");
const { runPool, summariseFile } = await import("../src/review/indexer.js");

const LIVE = isLLMLive();
console.log(
  `[eval] provider=${config.llm.provider ?? "anthropic"} model=${AUDIT_MODEL} live=${LIVE} runs=${RUNS} summariser=${USE_SUMMARISER && LIVE}`
);
if (!LIVE) {
  console.warn(
    "[eval] no LLM credentials — running the offline mock. This smoke-tests the\n" +
      "       harness only and will NOT be scored. Set credentials in backend/.env."
  );
}

type Manifest = { cases: Array<BenchCase & { expected: Record<BenchTree, string>; title: string }>; trees: Record<string, string> };
const manifest = JSON.parse(await readFile(path.join(BENCH_DIR, "manifest.json"), "utf8")) as Manifest;
const cases = manifest.cases.filter((c) => !ONLY_CASE || c.id === ONLY_CASE);

const SKIP_DIRS = new Set(["node_modules", ".git", "var"]);
async function treeFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir)).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else out.push({ path: path.relative(root, full), content: await readFile(full, "utf8") });
    }
  };
  await walk(root);
  return out;
}

// One audit pass over one tree, mirroring runSecurityAudit's per-file sequence
// (security/audit.ts): scan → mechanical check → evidence bundle → verifier.
async function auditTree(tree: BenchTree): Promise<{ score: RunScore; costUsd: number; bundles: Record<string, string[]> }> {
  const root = path.join(BENCH_DIR, manifest.trees[tree]);
  const files = await treeFiles(root);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  const entries = await buildLocalIndex(
    `bench-${tree}`,
    files,
    USE_SUMMARISER && LIVE ? (f) => summariseFile(f.path, f.content) : undefined
  );
  const { candidates } = selectCandidates({
    entries,
    policy: DEFAULT_SECURITY_POLICY,
    scopePaths: null,
    full: true,
  });
  console.log(`[eval] ${tree}: ${files.length} files indexed, ${candidates.length} candidates`);

  const detections: BenchDetection[] = [];
  const scanFailedPaths: string[] = [];
  const bundles: Record<string, string[]> = {};
  const fetchEntry = async (e: RepoIndexEntry) => byPath.get(e.path) ?? "";

  const costUsd: number = await withUsage(async () => {
    await runPool(candidates, CONCURRENCY, async (entry: RepoIndexEntry) => {
      const content = byPath.get(entry.path) ?? "";
      const scanned = await scanFile({
        path: entry.path,
        content,
        repoContext: (
          `flags: ${entry.securityFlags?.join(", ") || "(none)"} · ` +
          `static: ${entry.staticFlags?.join(", ") || "(none)"} · ${entry.summary}`
        ).slice(0, 500),
        engines: DEFAULT_SECURITY_POLICY.engines,
      });
      if (scanned === null) {
        scanFailedPaths.push(entry.path);
        console.log(`[eval]   ! scan failed ${entry.path}`);
        return;
      }
      if (!scanned.length) return;

      const valid: AgentFinding[] = [];
      for (const d of scanned) {
        const m = mechanicalCheck(d, content);
        if (m.ok) valid.push(m.finding);
        else {
          const held = applyVerdict(d, holdVerification(m.reason, m.detail, Date.now()));
          detections.push(toDetection(held));
        }
      }
      if (!valid.length) return;

      const bundle = await buildEvidenceBundle({ entry, allEntries: entries, fetch: fetchEntry });
      bundles[entry.path] = bundle.files.map((f) => `${f.path} (${f.role})`);
      const verdicts = await verifyFindings({ path: entry.path, content, findings: valid, bundle });
      if (verdicts === null) {
        scanFailedPaths.push(entry.path);
        console.log(`[eval]   ! verify failed ${entry.path}`);
        return;
      }
      valid.forEach((d, i) => detections.push(toDetection(applyVerdict(d, verdicts[i]))));
    });
    return Number((currentUsage()?.costUsd ?? 0).toFixed(4));
  });

  return { score: scoreRun({ tree, cases, detections, scanFailedPaths }), costUsd, bundles };
}

function toDetection(f: ReturnType<typeof applyVerdict>): BenchDetection {
  return {
    path: f.path ?? "",
    class: f.class,
    ...(f.symbol ? { symbol: f.symbol } : {}),
    title: f.title,
    severity: f.severity,
    verification: f.verification.status,
    ...(f.verification.reason ? { holdReason: f.verification.reason } : {}),
  };
}

const trees: BenchTree[] = ONLY_TREE && ONLY_TREE !== "both" ? [ONLY_TREE] : ["vulnerable", "fixed"];
const allScores: RunScore[] = [];
const report: any = { at: new Date().toISOString(), model: AUDIT_MODEL, live: LIVE, runs: RUNS, trees: {} };

for (const tree of trees) {
  report.trees[tree] = { runs: [] as any[] };
  for (let run = 1; run <= RUNS; run++) {
    const { score, costUsd, bundles } = await auditTree(tree);
    allScores.push(score);
    const h = headline(score, cases);
    report.trees[tree].runs.push({ run, headline: h, costUsd, cases: score.cases, noise: score.noise, bundles });

    console.log(`\n[eval] ${tree} run ${run}/${RUNS}  (cost $${costUsd})`);
    for (const r of score.cases) {
      const c = cases.find((x) => x.id === r.caseId)!;
      const want = c.expected[tree];
      const ok = want === "verified" ? r.outcome === "surfaced" : r.outcome !== "surfaced";
      console.log(`  ${ok ? "ok  " : "BAD "} ${c.id} ${c.kind.padEnd(6)} ${r.outcome.padEnd(20)} want ${want}`);
    }
    console.log(
      `  real surfaced ${h.realSurfaced}/${h.realTotal} · decoys surfaced ${h.decoysSurfaced}/${h.decoyTotal} · noise ${h.noise} · scan failures ${h.scanFailed}`
    );
    for (const n of score.noise) console.log(`       noise: ${n.path} [${n.class}] ${n.verification} — ${n.title}`);
  }
}

if (RUNS > 1) {
  console.log("\n[eval] per-case surfacing rate across runs");
  for (const r of rates(allScores)) {
    const c = cases.find((x) => x.id === r.caseId)!;
    console.log(`  ${r.caseId} ${c.kind.padEnd(6)} ${r.surfaced}/${r.runs} (${(r.rate * 100).toFixed(0)}%)`);
  }
  report.ratesAcrossRuns = rates(allScores);
}

if (OUT_PATH) {
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[eval] wrote ${OUT_PATH}`);
}

if (!LIVE) {
  console.log("\n[eval] mock run complete — smoke only, not scored.");
}
