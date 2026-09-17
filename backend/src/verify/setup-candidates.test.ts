// Offline: the picker data the setup panel offers, and what it says when it cannot read the tree.
//   DATABASE_URL= ANTHROPIC_API_KEY= node --import tsx/esm --test src/verify/setup-candidates.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepoVerifyState } from "../types.js";
import { CANDIDATE_LIMITS, setupCandidates } from "./setup-candidates.js";

const REPO = { owner: "devasignhq", name: "agent" };

const state = (onboarding: Partial<RepoVerifyState["onboarding"]> = {}): RepoVerifyState => ({
  onboarding: { state: "pr_open", prNumber: 7, ...onboarding },
});

const viteConfig = (port: number, proxy = 8787) => `import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: ${port}, proxy: { '/api': 'http://localhost:${proxy}' } },
});
`;

const vitePkg = JSON.stringify({
  scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview", test: "node --test 'src/**/*.test.ts'" },
  dependencies: { react: "^18.3.1" },
  devDependencies: { typescript: "^5.6.2", vite: "^8.2.1" },
});

const CI = "name: CI\non:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm ci\n";

const AGENT_PATHS = [
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "backend/package.json",
  "backend/.env.example",
  "backend/src/server.ts",
  "contributor/package.json",
  "contributor/vite.config.ts",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "scripts/devasign-login.mjs",
  "scripts/seed.ts",
];

const AGENT_FILES: Record<string, string | null> = {
  ".github/workflows/ci.yml": CI,
  "package.json": JSON.stringify({ workspaces: ["backend", "frontend", "contributor"], scripts: { test: "node --test" } }),
  "backend/package.json": JSON.stringify({
    scripts: { dev: "tsx watch src/server.ts", "dev:ephemeral": "tsx scripts/ephemeral-dev.ts", build: "tsc -b" },
    dependencies: { express: "^4.19.2" },
  }),
  "backend/.env.example": "DATABASE_URL=\nPORT=8787\n",
  "contributor/package.json": vitePkg,
  "contributor/vite.config.ts": viteConfig(3002),
  "frontend/package.json": vitePkg,
  "frontend/vite.config.ts": viteConfig(3001),
};

test("the agent monorepo shape offers every installable package, with the ports each one claims", () => {
  const got = setupCandidates({ repo: REPO, verify: state({ mode: "extend" }), tree: { paths: AGENT_PATHS, files: AGENT_FILES } });

  // Inference's own picks lead, so the cap can only ever drop a package nothing pointed at.
  assert.deepEqual(got.packages.map((p) => p.dir), ["frontend", "backend", ".", "contributor"]);
  assert.deepEqual(got.packages[0], {
    dir: "frontend",
    pm: "npm",
    framework: "vite",
    scripts: ["dev", "build", "preview", "test"],
    port: 3001,
    proxyPort: 8787,
  });
  assert.deepEqual(got.packages[1], {
    dir: "backend",
    pm: "npm",
    framework: "server",
    scripts: ["dev", "dev:ephemeral", "build"],
    port: 8787,
  });
  assert.deepEqual(got.packages[2], { dir: ".", pm: "npm", framework: null, scripts: ["test"] }, "the root manifest has no app in it, and says so rather than being hidden");
  assert.deepEqual(got.packages[3], { dir: "contributor", pm: "npm", framework: "vite", scripts: ["dev", "build", "preview", "test"], port: 3002, proxyPort: 8787 });
  assert.deepEqual(got.loginScripts, ["scripts/devasign-login.mjs"], "seed.ts is not a runnable login script");
  assert.equal(got.secretsUrl, "https://github.com/devasignhq/agent/settings/secrets/actions");
});

test("an extend-mode repo offers only the packages its own CI installs", () => {
  const files = { ...AGENT_FILES, "package.json": JSON.stringify({ scripts: { test: "node --test" } }) };
  const got = setupCandidates({ repo: REPO, verify: state({ mode: "extend" }), tree: { paths: AGENT_PATHS, files } });
  assert.deepEqual(got.packages.map((p) => p.dir), ["."], "no workspaces and a workflow that installs no directory: nothing nested is installed");

  const separate = setupCandidates({ repo: REPO, verify: state({ mode: "separate" }), tree: { paths: AGENT_PATHS, files } });
  assert.deepEqual(separate.packages.map((p) => p.dir), ["frontend", "backend", ".", "contributor"], "we write the workflow ourselves, so we can install them");
});

test("two vite apps inference cannot choose between are both offered", () => {
  const paths = ["admin/package.json", "admin/vite.config.ts", "pnpm-lock.yaml", "ui/package.json", "ui/vite.config.ts"];
  const files: Record<string, string | null> = {
    "admin/package.json": vitePkg,
    "admin/vite.config.ts": viteConfig(4100, 4000),
    "ui/package.json": vitePkg,
    "ui/vite.config.ts": viteConfig(4200, 4000),
  };
  const got = setupCandidates({ repo: REPO, verify: state(), tree: { paths, files } });
  assert.deepEqual(got.packages.map((p) => [p.dir, p.port, p.proxyPort]), [["admin", 4100, 4000], ["ui", 4200, 4000]]);
  assert.deepEqual(got.packages.map((p) => p.pm), ["pnpm", "pnpm"], "the root lockfile decides the package manager for both");
  assert.deepEqual(got.loginScripts, []);
});

test("a repo with no manifests offers nothing rather than throwing", () => {
  const paths = ["README.md", "src/main.py", "requirements.txt"];
  const got = setupCandidates({ repo: REPO, verify: null, tree: { paths, files: { "requirements.txt": "flask\n" } } });
  assert.deepEqual(got.packages, []);
  assert.deepEqual(got.loginScripts, []);
  assert.equal(got.secretNames, null);
  assert.equal(got.missingSecrets, null);

  const empty = setupCandidates({ repo: REPO, verify: state(), tree: { paths: [], files: {} } });
  assert.deepEqual(empty.packages, []);

  const broken = setupCandidates({
    repo: REPO,
    verify: state({ mode: "separate" }),
    tree: { paths: ["app/package.json"], files: { "app/package.json": "{ not json" } },
  });
  assert.deepEqual(broken.packages, [], "an unreadable manifest is not a package to pick from");
});

test("secret names: could not read, read as empty, and read as populated are three different answers", () => {
  const url = "https://github.com/devasignhq/agent/settings/secrets/actions";
  const unread = setupCandidates({ repo: REPO, verify: state({ expectedSecrets: ["SESSION_SECRET"], missingSecrets: null }) });
  assert.deepEqual(unread, { packages: [], loginScripts: [], secretNames: null, missingSecrets: null, secretsUrl: url });

  const never = setupCandidates({ repo: REPO, verify: state({ expectedSecrets: ["SESSION_SECRET"] }) });
  assert.equal(never.secretNames, null, "no missing list means nothing was ever compared");
  assert.equal(never.missingSecrets, null);

  const none = setupCandidates({ repo: REPO, verify: state({ expectedSecrets: ["SESSION_SECRET", "OPENAI_KEY"], missingSecrets: ["SESSION_SECRET", "OPENAI_KEY"] }) });
  assert.deepEqual(none.secretNames, [], "the repo has none of them, which is not the same as not knowing");
  assert.deepEqual(none.missingSecrets, ["SESSION_SECRET", "OPENAI_KEY"]);

  const some = setupCandidates({ repo: REPO, verify: state({ expectedSecrets: ["SESSION_SECRET", "OPENAI_KEY"], missingSecrets: ["OPENAI_KEY"] }) });
  assert.deepEqual(some.secretNames, ["SESSION_SECRET"], "only a name GitHub confirmed is present is reported present");
  assert.deepEqual(some.missingSecrets, ["OPENAI_KEY"]);
});

test("without a tree nothing is invented: no packages, and only the login script already cached", () => {
  const verify = state({
    candidates: { sha: "a".repeat(40), webApp: { dir: "frontend", framework: "vite", port: 3001 }, servers: [], loginScript: "node ./scripts/devasign-login.mjs", ambiguousWebApps: [], eligibleDirs: ["frontend"] },
    expectedSecrets: [],
    missingSecrets: [],
  });
  const got = setupCandidates({ repo: REPO, verify });
  assert.deepEqual(got.packages, [], "no manifest was read, so no script name can be offered");
  assert.deepEqual(got.loginScripts, ["scripts/devasign-login.mjs"]);
  assert.deepEqual(got.secretNames, []);
});

test("login scripts: everything under scripts/, login-shaped files anywhere, and never a traversal", () => {
  const paths = [
    "ci/auth-setup.sh",
    "e2e/fixtures/data.json",
    "e2e/login.mjs",
    "scripts/build.sh",
    "scripts/devasign-login.mjs",
    "scripts/nested/deep.mjs",
    "src/app.js",
    "../escape/login.mjs",
    "-rf.sh",
  ];
  const got = setupCandidates({ repo: REPO, verify: state(), tree: { paths, files: {} } });
  assert.deepEqual(got.loginScripts, ["scripts/devasign-login.mjs", "ci/auth-setup.sh", "e2e/login.mjs", "scripts/build.sh"]);
});

test("a huge tree is capped, and the caps are the ones the panel is told about", () => {
  const dirs = Array.from({ length: 20 }, (_, i) => `pkg${String(i).padStart(2, "0")}`);
  const scripts: Record<string, string> = { "bad name": "true", "-x": "true", blank: "  " };
  for (let i = 0; i < 60; i++) scripts[`s${i}`] = "node .";
  const paths = [
    "package.json",
    ...dirs.map((d) => `${d}/package.json`),
    ...Array.from({ length: 5000 }, (_, i) => `src/gen/file${i}.ts`),
  ];
  const files: Record<string, string | null> = { "package.json": JSON.stringify({ scripts }) };
  for (const d of dirs) files[`${d}/package.json`] = JSON.stringify({ scripts: { dev: "node ." } });

  const got = setupCandidates({ repo: REPO, verify: state({ mode: "separate" }), tree: { paths, files } });
  assert.equal(got.packages.length, CANDIDATE_LIMITS.packages);
  const root = got.packages.find((p) => p.dir === ".")!;
  assert.equal(root.scripts.length, CANDIDATE_LIMITS.scripts);
  assert.ok(!root.scripts.some((s) => ["bad name", "-x", "blank"].includes(s)), "a name no start command could use is never offered");
});
