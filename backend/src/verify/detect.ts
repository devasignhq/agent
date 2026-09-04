// Repo test-setup inference from a git tree (+ package.json when readable).
// The runner's own detection (posted on resolve) is ground truth; this is the
// server-side approximation used before a runner has ever run.
import type { DetectedFramework, DetectedSetup } from "./contract.js";

const TEST_PATH_RE =
  /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$|_spec\.rb$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

export function isFrontendPath(path: string): boolean {
  return /\.(tsx|jsx|vue|svelte|html|css|scss)$/i.test(path);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", cs: "csharp", php: "php", swift: "swift",
};

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  engines?: { node?: string };
};

function parsePackageJson(text: string | null | undefined): PackageJson | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? (j as PackageJson) : null;
  } catch {
    return null;
  }
}

export function envVarNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export function inferSetupFromTree(
  paths: string[],
  files: { packageJson?: string | null; envExample?: string | null } = {}
): DetectedSetup {
  const set = new Set(paths);
  const has = (p: string) => set.has(p);
  const any = (re: RegExp) => paths.some((p) => re.test(p));
  const pkg = parsePackageJson(files.packageJson);
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const dep = (name: string) => (name in deps ? String(deps[name]).replace(/^[\^~>=<\s]+/, "") : undefined);

  const langCounts = new Map<string, number>();
  for (const p of paths) {
    const ext = p.split(".").pop()?.toLowerCase() || "";
    const lang = LANG_BY_EXT[ext];
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
  const testScript = pkg?.scripts?.test || "";
  if (/\bnode\b.*\s--test\b/.test(testScript)) frameworks.push({ name: "node-test" });

  const testCommands = Object.entries(pkg?.scripts || {})
    .filter(([k]) => /^(test|e2e|test:[\w-]+)$/.test(k))
    .map(([k, v]) => `${packageManager === "npm" || !packageManager ? "npm run" : packageManager} ${k}  # ${v}`);

  const services: DetectedSetup["services"] = [];
  const envVars = envVarNames(files.envExample);
  if (dep("pg") || dep("prisma") || dep("@prisma/client") || dep("drizzle-orm") || dep("psycopg2") || any(/schema\.prisma$/) || envVars.some((v) => /DATABASE_URL|POSTGRES/.test(v)))
    services.push("postgres");
  if (dep("mysql2") || envVars.some((v) => /MYSQL/.test(v))) services.push("mysql");
  if (dep("redis") || dep("ioredis") || envVars.some((v) => /REDIS/.test(v))) services.push("redis");

  let monorepo: DetectedSetup["monorepo"] = null;
  const tool = has("pnpm-workspace.yaml") ? "pnpm" : has("turbo.json") ? "turbo" : has("nx.json") ? "nx" : pkg?.workspaces ? "workspaces" : null;
  if (tool) {
    const packages = [...new Set(paths.filter((p) => /^[^/]+\/[^/]+\/package\.json$/.test(p)).map((p) => p.split("/").slice(0, 2).join("/")))];
    monorepo = { tool, packages };
  }

  return {
    languages,
    packageManager,
    monorepo,
    frameworks,
    testCommands,
    envExampleVars: envVars,
    existingWorkflows: paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)),
    nodeVersion: pkg?.engines?.node,
    services,
  };
}
