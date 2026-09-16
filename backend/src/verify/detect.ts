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

// Git allows any byte but "/" and NUL in a path component, and these names reach
// `run:` steps and start commands, so the charset gate lives at the one place every
// consumer gets its directory list from.
export const PLAIN_DIR = /^[A-Za-z0-9_.-]+$/;

export const isPlainDir = (dir: string) => PLAIN_DIR.test(dir) && dir !== "." && dir !== ".." && !dir.startsWith("-");

export type BootPm = "npm" | "pnpm" | "yarn" | "bun";

/** Top-level directories with their own package.json: "backend", "frontend". */
export function nestedPackageDirs(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => /^[^/]+\/package\.json$/.test(p)).map((p) => p.split("/")[0]))].filter(isPlainDir).sort();
}

/** The package manager of one directory, from its own lockfile, else the repository root's. */
export function pmFor(dir: string, paths: string[]): BootPm {
  for (const base of [`${dir}/`, ""]) {
    if (paths.includes(`${base}pnpm-lock.yaml`)) return "pnpm";
    if (paths.includes(`${base}yarn.lock`)) return "yarn";
    if (paths.includes(`${base}bun.lockb`) || paths.includes(`${base}bun.lock`)) return "bun";
    if (paths.includes(`${base}package-lock.json`)) return "npm";
  }
  return "npm";
}

/** The install command for one nested package. Same package manager the start command uses. */
export function installCommandFor(dir: string, paths: string[]): string {
  const pm = pmFor(dir, paths);
  if (pm === "pnpm") return `pnpm install --frozen-lockfile --dir ${dir}`;
  if (pm === "yarn") return `yarn install --frozen-lockfile --cwd ${dir}`;
  if (pm === "bun") return `bun install --cwd ${dir}`;
  return paths.includes(`${dir}/package-lock.json`) ? `npm ci --prefix ${dir}` : `npm install --prefix ${dir}`;
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

  // With no root manifest the top-level packages are the install units.
  const packages = has("package.json") ? [] : nestedPackageDirs(paths);
  const inPkg = (f: string) => packages.some((d) => has(`${d}/${f}`));

  let packageManager: DetectedSetup["packageManager"] = null;
  if (has("pnpm-lock.yaml") || inPkg("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (has("yarn.lock") || inPkg("yarn.lock")) packageManager = "yarn";
  else if (has("bun.lockb") || has("bun.lock") || inPkg("bun.lockb") || inPkg("bun.lock")) packageManager = "bun";
  else if (has("package-lock.json") || has("package.json") || packages.length) packageManager = "npm";
  else if (has("poetry.lock")) packageManager = "poetry";
  else if (has("requirements.txt") || has("pyproject.toml")) packageManager = "pip";
  else if (has("go.mod")) packageManager = "go";

  const frameworks: DetectedFramework[] = [];
  const cfg = (re: RegExp) => paths.find((p) => re.test(p));
  // A relocated test cannot import a package-local vitest or jest, so only the root's
  // count; Playwright is supplied by the runner, so a nested config still names the boot.
  const cfgAnywhere = (re: RegExp) => cfg(re) ?? paths.find((p) => p.includes("/") && packages.includes(p.split("/")[0]) && re.test(p.slice(p.indexOf("/") + 1)));
  const vitestCfg = cfg(/^vitest\.config\.[cm]?[jt]s$/);
  if (vitestCfg || dep("vitest")) frameworks.push({ name: "vitest", version: dep("vitest"), configPath: vitestCfg });
  const jestCfg = cfg(/^jest\.config\.[cm]?[jt]s$/);
  if (jestCfg || dep("jest")) frameworks.push({ name: "jest", version: dep("jest"), configPath: jestCfg });
  const pwCfg = cfgAnywhere(/^playwright\.config\.[cm]?[jt]s$/);
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
    // Absent means "not collected", which switches the import allow-list off. No root
    // manifest is not that: nothing is installed where a relocated test resolves from.
    ...(pkg ? { dependencies: Object.keys(deps).sort() } : has("package.json") ? {} : { dependencies: [] }),
    ...(packages.length ? { packages } : {}),
    testCommands,
    envExampleVars: envVars,
    existingWorkflows: paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)),
    nodeVersion: pkg?.engines?.node,
    services,
  };
}
