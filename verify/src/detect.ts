// Detect the repo's test setup from the checkout. Ground truth for the API.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { DetectedFramework, DetectedSetup, DevasignVerifyConfig } from "./types.js";

const execFileP = promisify(execFile);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor", "__pycache__", ".venv", "target", ".devasign", ".cache", ".turbo"]);
const TEST_PATH_RE =
  /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$|_spec\.rb$/i;
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", cs: "csharp", php: "php", swift: "swift",
};

export function isTestPath(p: string): boolean {
  return TEST_PATH_RE.test(p);
}

/** Repo-relative file paths, skipping dependency/build dirs, capped for huge repos. */
export function listFiles(root: string, cap = 20_000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= cap) return;
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else out.push(rel);
    }
  };
  walk(root);
  return out;
}

function readText(root: string, rel: string): string | null {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

export function envVarNames(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export function readDevasignVerify(root: string): DevasignVerifyConfig | null {
  const raw = readText(root, ".devasign.yml");
  if (!raw) return null;
  try {
    const doc = parseYaml(raw) as { verify?: DevasignVerifyConfig } | null;
    return doc && typeof doc === "object" && doc.verify && typeof doc.verify === "object" ? doc.verify : null;
  } catch {
    return null;
  }
}

async function version(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 5_000 });
    return (stdout || stderr).trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

export async function detectSetup(root: string, opts: { probeRuntimes?: boolean } = {}): Promise<DetectedSetup> {
  const paths = listFiles(root);
  const set = new Set(paths);
  const has = (p: string) => set.has(p);
  const any = (re: RegExp) => paths.some((p) => re.test(p));
  const pkgText = readText(root, "package.json");
  let pkg: any = null;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null;
  } catch {
    pkg = null;
  }
  const deps: Record<string, string> = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const dep = (name: string) => (name in deps ? String(deps[name]).replace(/^[\^~>=<\s]+/, "") : undefined);

  const langCounts = new Map<string, number>();
  for (const p of paths) {
    const lang = LANG_BY_EXT[p.split(".").pop()?.toLowerCase() || ""];
    if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
  }
  const languages = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

  let packageManager: DetectedSetup["packageManager"] = null;
  if (has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (has("yarn.lock")) packageManager = "yarn";
  else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
  else if (has("package-lock.json") || has("package.json")) packageManager = "npm";
  else if (has("poetry.lock")) packageManager = "poetry";
  else if (has("requirements.txt") || has("pyproject.toml")) packageManager = "pip";
  else if (has("go.mod")) packageManager = "go";

  const frameworks: DetectedFramework[] = [];
  const cfg = (re: RegExp) => paths.find((p) => re.test(p));
  const vitestCfg = cfg(/^vitest\.config\.[cm]?[jt]s$/);
  if (vitestCfg || dep("vitest")) frameworks.push({ name: "vitest", version: dep("vitest"), configPath: vitestCfg });
  const jestCfg = cfg(/^jest\.config\.[cm]?[jt]s$/);
  if (jestCfg || dep("jest")) frameworks.push({ name: "jest", version: dep("jest"), configPath: jestCfg });
  const pwCfg = cfg(/^playwright\.config\.[cm]?[jt]s$/);
  if (pwCfg || dep("@playwright/test")) frameworks.push({ name: "playwright", version: dep("@playwright/test"), configPath: pwCfg });
  const cyCfg = cfg(/^cypress\.config\.[cm]?[jt]s$/);
  if (cyCfg || dep("cypress")) frameworks.push({ name: "cypress", version: dep("cypress"), configPath: cyCfg });
  if (has("pytest.ini") || any(/(^|\/)conftest\.py$/) || any(/(^|\/)test_[^/]+\.py$/)) frameworks.push({ name: "pytest" });
  if (has("go.mod") && any(/_test\.go$/)) frameworks.push({ name: "go-test" });
  if (/\bnode\b.*\s--test\b/.test(String(pkg?.scripts?.test || ""))) frameworks.push({ name: "node-test" });

  const testCommands = Object.entries((pkg?.scripts || {}) as Record<string, string>)
    .filter(([k]) => /^(test|e2e|test:[\w-]+)$/.test(k))
    .map(([k, v]) => `${packageManager === "npm" || !packageManager ? "npm run" : packageManager} ${k}  # ${v}`);

  const envVars = [...new Set([...envVarNames(readText(root, ".env.example")), ...envVarNames(readText(root, ".env.test"))])];
  const yml = readDevasignVerify(root);
  const services: DetectedSetup["services"] = [];
  const declared = new Set((yml?.services || []).map((s) => (typeof s === "string" ? s : s.name)));
  if (declared.has("postgres") || dep("pg") || dep("prisma") || dep("@prisma/client") || dep("drizzle-orm") || any(/schema\.prisma$/) || envVars.some((v) => /DATABASE_URL|POSTGRES/.test(v))) services.push("postgres");
  if (declared.has("mysql") || dep("mysql2") || envVars.some((v) => /MYSQL/.test(v))) services.push("mysql");
  if (declared.has("redis") || dep("redis") || dep("ioredis") || envVars.some((v) => /REDIS/.test(v))) services.push("redis");

  let monorepo: DetectedSetup["monorepo"] = null;
  const tool = has("pnpm-workspace.yaml") ? "pnpm" : has("turbo.json") ? "turbo" : has("nx.json") ? "nx" : pkg?.workspaces ? "workspaces" : null;
  if (tool) monorepo = { tool, packages: [...new Set(paths.filter((p) => /^[^/]+\/[^/]+\/package\.json$/.test(p)).map((p) => p.split("/").slice(0, 2).join("/")))] };

  const nvmrc = (readText(root, ".nvmrc") || readText(root, ".node-version") || "").trim();
  const nodeVersion = nvmrc || pkg?.engines?.node || (opts.probeRuntimes === false ? undefined : process.version);
  const pythonVersion = languages.includes("python") && opts.probeRuntimes !== false ? await version("python3", ["--version"]) : undefined;

  return {
    languages,
    packageManager,
    monorepo,
    frameworks,
    testCommands,
    envExampleVars: envVars,
    existingWorkflows: paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)),
    nodeVersion: nodeVersion || undefined,
    pythonVersion,
    services,
  };
}

export function repoHasPlaywright(root: string): boolean {
  return existsSync(path.join(root, "node_modules", "@playwright", "test", "package.json"));
}
