// Pure generators for the onboarding PR: the verify workflow, the `verify:`
// block of .devasign.yml, the extend-an-existing-workflow edit, the expected
// secret list, the PR body, and mechanical doctor follow-up patches. No I/O.
import { parseDocument, stringify, isMap, isSeq, YAMLMap, YAMLSeq } from "yaml";
import type { DetectedSetup, DevasignVerifyConfig, DoctorDiagnosis } from "../contract.js";

export const WORKFLOW_PATH = ".github/workflows/devasign-verify.yml";
export const DEVASIGN_YML_PATH = ".devasign.yml";
export const ACTION_REF = "devasignhq/verify-action@v1";
export const ONBOARDING_BRANCH = "devasign/enable-verification";
export const ONBOARDING_TITLE = "Enable DevAsign verification";

export type PackageJsonLike = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
} | null;

export type StackHints = {
  node: boolean;
  python: boolean;
  go: boolean;
  nextjs: boolean;
  vite: boolean;
  express: boolean;
  fastapi: boolean;
  django: boolean;
  flask: boolean;
  prisma: boolean;
  nodeVersion: string;
  pythonVersion: string;
  goVersion: string;
};

const dep = (pkg: PackageJsonLike, name: string) => !!(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);

function majorFromRange(range: string | undefined, fallback: string): string {
  const m = /(\d+)(?:\.(\d+))?/.exec(range || "");
  return m ? m[1] : fallback;
}

export function stackHints(setup: DetectedSetup, paths: string[], pkg: PackageJsonLike, files: Record<string, string | null> = {}): StackHints {
  const has = (p: string) => paths.includes(p);
  const py = setup.languages.includes("python") || has("pyproject.toml") || has("requirements.txt");
  const reqs = (files["requirements.txt"] || "") + (files["pyproject.toml"] || "");
  const pyVer = (files[".python-version"] || "").trim() || majorMinorPython(files["pyproject.toml"]) || "3.12";
  return {
    node: !!pkg || setup.languages.includes("typescript") || setup.languages.includes("javascript"),
    python: py,
    go: has("go.mod"),
    nextjs: dep(pkg, "next"),
    vite: dep(pkg, "vite"),
    express: dep(pkg, "express") || dep(pkg, "fastify") || dep(pkg, "koa"),
    fastapi: /fastapi/i.test(reqs),
    django: /django/i.test(reqs),
    flask: /flask/i.test(reqs),
    prisma: dep(pkg, "prisma") || dep(pkg, "@prisma/client") || paths.some((p) => p.endsWith("schema.prisma")),
    nodeVersion: majorFromRange((files[".nvmrc"] || files[".node-version"] || "").trim() || setup.nodeVersion, "20"),
    pythonVersion: pyVer,
    goVersion: majorMinorGo(files["go.mod"]) || "stable",
  };
}

function majorMinorPython(pyproject: string | null | undefined): string | null {
  const m = /requires-python\s*=\s*"[^\d]*(\d+\.\d+)/.exec(pyproject || "");
  return m ? m[1] : null;
}
function majorMinorGo(gomod: string | null | undefined): string | null {
  const m = /^go\s+(\d+\.\d+)/m.exec(gomod || "");
  return m ? m[1] : null;
}

// Vars that are wiring, not secrets: never expected from the customer's store.
const CI_VARS = new Set(["NODE_ENV", "PORT", "CI", "GITHUB_TOKEN", "HOST", "LOG_LEVEL", "DEBUG", "TZ", "WEB_ORIGIN", "VITE_API_BASE", "NEXT_PUBLIC_API_URL"]);

export type ServiceEnv = { postgres?: string; mysql?: string; redis?: string };

/** Connection strings pointing at the job's service containers, keyed by env var. */
export function connectionEnv(setup: DetectedSetup): Record<string, string> {
  const out: Record<string, string> = {};
  const vars = new Set(setup.envExampleVars);
  if (setup.services.includes("postgres")) {
    for (const v of ["DATABASE_URL", "POSTGRES_URL", "PG_URL", "POSTGRES_PRISMA_URL"]) if (vars.has(v) || v === "DATABASE_URL") out[v] = "postgresql://postgres:postgres@localhost:5432/test";
  }
  if (setup.services.includes("mysql")) out.MYSQL_URL = "mysql://root:root@localhost:3306/test";
  if (setup.services.includes("redis")) for (const v of ["REDIS_URL"]) out[v] = "redis://localhost:6379";
  return out;
}

/** Secret names the workflow expects: env-example vars + `secrets.X` refs in existing workflows, minus wiring vars. */
export function expectedSecrets(setup: DetectedSetup, workflowTexts: string[]): string[] {
  const conn = new Set(Object.keys(connectionEnv(setup)));
  const out = new Set<string>();
  for (const v of setup.envExampleVars) if (!CI_VARS.has(v) && !conn.has(v)) out.add(v);
  for (const t of workflowTexts) for (const m of t.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)) if (m[1] !== "GITHUB_TOKEN") out.add(m[1]);
  return [...out].sort();
}

export type WorkflowInput = { setup: DetectedSetup; hints: StackHints; secrets: string[] };

function serviceBlocks(setup: DetectedSetup): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (setup.services.includes("postgres")) {
    s.postgres = {
      image: "postgres:16",
      env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "test" },
      ports: ["5432:5432"],
      options: "--health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5",
    };
  }
  if (setup.services.includes("mysql")) {
    s.mysql = { image: "mysql:8", env: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "test" }, ports: ["3306:3306"], options: "--health-cmd \"mysqladmin ping -h 127.0.0.1\" --health-interval 10s --health-timeout 5s --health-retries 5" };
  }
  if (setup.services.includes("redis")) {
    s.redis = { image: "redis:7", ports: ["6379:6379"], options: "--health-cmd \"redis-cli ping\" --health-interval 10s --health-timeout 5s --health-retries 5" };
  }
  return s;
}

function installSteps(setup: DetectedSetup, hints: StackHints, paths: string[]): unknown[] {
  const steps: unknown[] = [];
  const pm = setup.packageManager;
  if (hints.node || pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") {
    if (pm === "pnpm") steps.push({ uses: "pnpm/action-setup@v4", with: { version: 9 } });
    if (pm === "bun") steps.push({ uses: "oven-sh/setup-bun@v2" });
    const cache = pm === "pnpm" ? "pnpm" : pm === "yarn" ? "yarn" : pm === "npm" ? "npm" : undefined;
    const hasLock = paths.some((p) => /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(p));
    steps.push({ uses: "actions/setup-node@v4", with: { "node-version": hints.nodeVersion, ...(cache && hasLock ? { cache } : {}) } });
    if (paths.includes("package.json")) {
      const cmd =
        pm === "pnpm" ? (hasLock ? "pnpm install --frozen-lockfile" : "pnpm install")
        : pm === "yarn" ? (hasLock ? "yarn install --frozen-lockfile" : "yarn install")
        : pm === "bun" ? "bun install"
        : hasLock ? "npm ci" : "npm install";
      steps.push({ name: "Install dependencies", run: cmd });
    }
  } else {
    // The runner itself is a Node CLI (npx); a Python/Go-only repo still needs Node.
    steps.push({ uses: "actions/setup-node@v4", with: { "node-version": "20" } });
  }
  if (hints.python) {
    steps.push({ uses: "actions/setup-python@v5", with: { "python-version": hints.pythonVersion } });
    if (pm === "poetry") steps.push({ name: "Install dependencies", run: "pipx install poetry && poetry install --no-interaction" });
    else if (paths.includes("requirements.txt")) steps.push({ name: "Install dependencies", run: "pip install -r requirements.txt" });
    else if (paths.includes("pyproject.toml")) steps.push({ name: "Install dependencies", run: "pip install -e ." });
  }
  if (hints.go) steps.push({ uses: "actions/setup-go@v5", with: { "go-version": hints.goVersion } });
  if (hints.prisma) steps.push({ name: "Prepare the database schema", run: "npx prisma migrate deploy || npx prisma db push" });
  return steps;
}

export const WORKFLOW_HEADER =
  "# Added by DevAsign. Runs DevAsign's generated acceptance tests for each pull\n" +
  "# request inside this CI and reports per-criterion evidence on the PR.\n" +
  "# Secrets stay here: DevAsign never receives them. Edit freely.\n";

export function generateWorkflow(setup: DetectedSetup, hints: StackHints, secrets: string[], paths: string[]): string {
  const env: Record<string, string> = { ...connectionEnv(setup) };
  for (const s of secrets) env[s] = `\${{ secrets.${s} }}`;
  const services = serviceBlocks(setup);
  const job: Record<string, unknown> = {
    "runs-on": "ubuntu-latest",
    ...(Object.keys(services).length ? { services } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    steps: [
      { uses: "actions/checkout@v4", with: { ref: "${{ github.event.pull_request.head.sha || github.event.client_payload.sha }}" } },
      ...installSteps(setup, hints, paths),
      { name: "DevAsign verify", uses: ACTION_REF },
    ],
  };
  const doc = {
    name: "DevAsign verify",
    on: {
      pull_request: { types: ["opened", "synchronize", "reopened"] },
      repository_dispatch: { types: ["devasign-verify"] },
    },
    permissions: { contents: "read", "id-token": "write" },
    concurrency: { group: "devasign-verify-${{ github.event.pull_request.number || github.event.client_payload.pr }}", "cancel-in-progress": true },
    jobs: { verify: job },
  };
  return WORKFLOW_HEADER + stringify(doc, { lineWidth: 0 });
}

/** Best-effort boot config per stack; omitted when unknown so e2e is honestly unverifiable. */
export function guessVerifyConfig(setup: DetectedSetup, hints: StackHints, pkg: PackageJsonLike, secrets: string[]): DevasignVerifyConfig {
  const scripts = pkg?.scripts || {};
  const pmRun = setup.packageManager === "pnpm" ? "pnpm" : setup.packageManager === "yarn" ? "yarn" : setup.packageManager === "bun" ? "bun run" : "npm run";
  const cfg: DevasignVerifyConfig = { e2e: "auto" };
  if (hints.nextjs) Object.assign(cfg, { build: scripts.build ? `${pmRun} build` : undefined, start: scripts.dev ? `${pmRun} dev` : `${pmRun} start`, url: "http://localhost:3000", ready: "/" });
  else if (hints.vite) Object.assign(cfg, { start: scripts.dev ? `${pmRun} dev -- --port 5173` : undefined, url: "http://localhost:5173", ready: "/" });
  else if (hints.fastapi) Object.assign(cfg, { start: "uvicorn app.main:app --port 8000", url: "http://localhost:8000", ready: "/docs" });
  else if (hints.django) Object.assign(cfg, { start: "python manage.py runserver 0.0.0.0:8000", url: "http://localhost:8000", ready: "/" });
  else if (hints.flask) Object.assign(cfg, { start: "flask run --port 5000", url: "http://localhost:5000", ready: "/" });
  else if (hints.express && scripts.start) Object.assign(cfg, { start: `${pmRun.replace(" run", "")} start`, url: "http://localhost:3000", ready: "/" });
  if (setup.services.length) cfg.services = setup.services.map((name) => ({ name }));
  if (hints.prisma) cfg.seed = "npx prisma db seed || true";
  cfg.login = { strategy: "none" };
  if (secrets.length) cfg.env = secrets;
  for (const k of Object.keys(cfg) as Array<keyof DevasignVerifyConfig>) if (cfg[k] === undefined) delete cfg[k];
  return cfg;
}

export const DEVASIGN_YML_HEADER =
  "# .devasign.yml — DevAsign verification settings for this repository.\n" +
  "# verify.start/url tell the runner how to boot the app for end-to-end tests;\n" +
  "# without them UI criteria are reported as unverifiable (never as failed).\n" +
  "# e2e: auto | always | never.\n";

/** Merge the `verify:` block into an existing .devasign.yml (comments kept) or create one. */
export function generateDevasignYml(existing: string | null, verify: DevasignVerifyConfig): string {
  if (existing && existing.trim()) {
    const doc = parseDocument(existing);
    if (!doc.errors.length && (isMap(doc.contents) || doc.contents == null)) {
      if (doc.get("verify")) return existing; // already configured: leave the customer's block alone
      doc.set("verify", verify);
      return doc.toString({ lineWidth: 0 });
    }
  }
  return DEVASIGN_YML_HEADER + stringify({ verify }, { lineWidth: 0 });
}

export type ExtendResult = { text: string; job: string } | { error: string };

/** Insert the verify step after the chosen job's last step and grant id-token: write. */
export function extendWorkflow(existing: string, opts: { job?: string } = {}): ExtendResult {
  const doc = parseDocument(existing);
  if (doc.errors.length) return { error: "the workflow file did not parse" };
  const jobs = doc.get("jobs");
  if (!isMap(jobs)) return { error: "the workflow has no jobs" };
  const names = jobs.items.map((i) => String((i.key as { value?: unknown })?.value ?? i.key));
  const pick = opts.job && names.includes(opts.job) ? opts.job : names.find((n) => /test|ci|check|build/i.test(n)) ?? names[0];
  if (!pick) return { error: "the workflow has no jobs" };
  const job = jobs.get(pick) as YAMLMap;
  if (!isMap(job)) return { error: `job ${pick} is not a map` };
  if (JSON.stringify(job.toJSON()).includes(ACTION_REF.split("@")[0])) return { error: "the workflow already runs DevAsign verify" };
  let steps = job.get("steps");
  if (!isSeq(steps)) {
    steps = new YAMLSeq();
    job.set("steps", steps);
  }
  (steps as YAMLSeq).add(doc.createNode({ name: "DevAsign verify", uses: ACTION_REF }));
  // Permissions: the job needs id-token for OIDC. Extend a map that already
  // exists (job first, then workflow); otherwise add a job-level block so the
  // token of every OTHER job in the file is left exactly as it was.
  const jobPerms = job.get("permissions");
  const topPerms = (doc.contents as YAMLMap).get("permissions");
  if (isMap(jobPerms)) {
    jobPerms.set("id-token", "write");
    if (!jobPerms.has("contents")) jobPerms.set("contents", "read");
  } else if (typeof jobPerms === "string") {
    // "write-all"/"read-all" on the job: leave it; both cover id-token only when write-all.
  } else if (isMap(topPerms)) {
    topPerms.set("id-token", "write");
    if (!topPerms.has("contents")) topPerms.set("contents", "read");
  } else if (typeof topPerms !== "string") {
    job.set("permissions", doc.createNode({ contents: "read", "id-token": "write" }));
  }
  // Let comment-triggered re-runs reach this workflow too.
  const on = doc.get("on") ?? doc.get(true);
  if (isMap(on)) {
    if (!on.has("repository_dispatch")) on.set("repository_dispatch", doc.createNode({ types: ["devasign-verify"] }));
  }
  return { text: doc.toString({ lineWidth: 0 }), job: pick };
}

export function prBody(args: {
  mode: "separate" | "extend";
  workflowPath: string;
  hints: StackHints;
  setup: DetectedSetup;
  verify: DevasignVerifyConfig;
  expected: string[];
  missing: string[] | null; // null when the secrets API was not readable
  extendedJob?: string;
}): string {
  const stack = [
    args.hints.nextjs ? "Next.js" : args.hints.vite ? "Vite" : args.hints.express ? "Node service" : args.hints.node ? "Node" : null,
    args.hints.fastapi ? "FastAPI" : args.hints.django ? "Django" : args.hints.flask ? "Flask" : args.hints.python ? "Python" : null,
    args.hints.go ? "Go" : null,
    args.hints.prisma ? "Prisma" : null,
    ...args.setup.services.map((s) => s === "postgres" ? "Postgres" : s),
    ...args.setup.frameworks.map((f) => f.name),
  ].filter(Boolean);
  const lines = [
    "DevAsign will verify each pull request by generating tests from the ticket's acceptance criteria, running them in this repository's own CI, and reporting a per-criterion verdict with evidence on the PR.",
    "",
    "### What this PR adds",
    args.mode === "extend"
      ? `- A **DevAsign verify** step appended to the \`${args.extendedJob}\` job in \`${args.workflowPath}\`, reusing that job's environment and services (with \`id-token: write\` so the runner can authenticate).`
      : `- \`${args.workflowPath}\` — a workflow that runs on every pull request${stack.length ? ` (detected: ${stack.join(", ")})` : ""}.`,
    "- `.devasign.yml` — how the runner boots the app for end-to-end tests and which secrets the tests need. Correct it once; DevAsign reads it on every run.",
    "",
    "### Secrets this workflow expects",
    args.expected.length
      ? args.expected.map((s) => `- \`${s}\`${args.missing ? (args.missing.includes(s) ? " — **not found in this repository's secrets**" : " — present") : ""}`).join("\n")
      : "- none detected",
    ...(args.missing && args.missing.length ? ["", `Add the missing ${args.missing.length === 1 ? "secret" : "secrets"} under Settings → Secrets and variables → Actions before merging, or remove the lines you don't need. Values never leave your CI; DevAsign only sees names.`] : []),
    ...(args.missing === null && args.expected.length ? ["", "DevAsign could not read this repository's secret names (the App lacks `secrets: read`), so it cannot tell which are missing."] : []),
    "",
    "### End-to-end tests",
    args.verify.start && args.verify.url
      ? `The runner will start the app with \`${args.verify.start}\` and wait for \`${args.verify.url}${args.verify.ready ?? ""}\`. If that is wrong, fix \`verify.start\` / \`verify.url\` in \`.devasign.yml\`.`
      : "No start command could be inferred. UI criteria will be reported as **unverifiable** (never failed) until `verify.start` and `verify.url` are set in `.devasign.yml`.",
    "",
    "Merging this PR enables verification. Until then, DevAsign posts each PR's criteria with a neutral \"Setup pending\" check.",
  ];
  return lines.join("\n");
}

/** Mechanical fixes to our workflow after a doctor diagnosis; null when the fix needs a human. */
export function patchWorkflowForDoctor(text: string, doctor: DoctorDiagnosis): string | null {
  if (doctor.code === "wrong_runtime_version") {
    const m = /Node ([^ ]+) but/.exec(doctor.message);
    const want = majorFromRange(m?.[1], "");
    if (!want) return null;
    const next = text.replace(/(node-version:\s*)["']?[^\n"']+["']?/, `$1"${want}"`);
    return next === text ? null : next;
  }
  if (doctor.code === "browser_install_failed") {
    if (/playwright install/.test(text)) return null;
    return text.replace(/(\n\s*- name: DevAsign verify\n)/, "\n      - name: Install Playwright browsers\n        run: npx playwright install --with-deps chromium$1");
  }
  return null;
}
