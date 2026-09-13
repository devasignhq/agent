// Offline: a generated test that reads git history is caught before it ships to a one-commit checkout.
//   node --import tsx/esm --test src/verify/history-lint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyLint } from "./history-lint.js";

const file = (...body: string[]) => ['import { execFileSync, execSync, spawnSync } from "node:child_process";', ...body].join("\n");
const quoted = (content: string) => /^it reads git history \(`(.*)`\)/.exec(historyLint(content)[0] ?? "")?.[1];

test("the live miss: a git helper diffing against HEAD^, and a helper probing for the base branch", () => {
  const live = file(
    'const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();',
    "function getChangedFiles() {",
    '  return git("diff", "--name-only", "HEAD^", "HEAD").split("\\n");',
    "}"
  );
  assert.equal(quoted(live), "git diff --name-only HEAD^ HEAD");
  assert.match(historyLint(live)[0], /one commit deep.*Assert on what the files in the checkout hold/);
  const probe = file("const run = (a: string[]) => execFileSync('git', a);", "for (const ref of ['origin/main', 'main']) run(['rev-parse', '--verify', ref]);");
  assert.equal(historyLint(probe).length, 1, "a ref behind or beside HEAD, through a helper of any name");
});

test("the command is found however the test spells it", () => {
  assert.equal(quoted(file('execSync("git log --format=%H -n 2")')), "git log --format=%H -n 2");
  assert.equal(quoted(file('execFileSync("git", [', '  "--no-pager",', '  "diff",', '  "origin/main...HEAD",', "]);")), "git --no-pager diff origin/main...HEAD");
  assert.equal(quoted(file('spawnSync("sh", ["-c", "git merge-base HEAD origin/main"])')), "git merge-base HEAD origin/main");
  assert.equal(quoted("import subprocess\nout = subprocess.check_output(['git', 'diff', '--name-only', 'HEAD~1'], text=True)"), "git diff --name-only HEAD~1");
  assert.equal(quoted('out, _ := exec.Command("git", "blame", "go.mod").Output()'), "git blame go.mod");
});

test("reads that exit cleanly are flagged too: one commit deep, the head reads as a root commit", () => {
  assert.equal(historyLint(file('execSync("git show --name-only --format= HEAD")')).length, 1, "lists every file in the repository");
  assert.equal(historyLint(file('execSync("git diff-tree --no-commit-id --name-only -r HEAD")')).length, 1, "lists none");
});

test("what works one commit deep passes: files on disk, ls-files, the repo root, and a repository the test builds", () => {
  assert.deepEqual(historyLint(file('const lock = JSON.parse(readFileSync("verify/package-lock.json", "utf8"));')), []);
  assert.deepEqual(historyLint(file('execSync("git ls-files")', 'execSync("git rev-parse --show-toplevel")')), []);
  const own = file('execFileSync("git", ["init", dir]);', 'execFileSync("git", ["commit", "--allow-empty", "-m", "one"], { cwd: dir });', 'execFileSync("git", ["log", "--oneline"], { cwd: dir });');
  assert.deepEqual(historyLint(own), [], "its history is the one the test wrote");
  assert.deepEqual(historyLint(file('spawnSync("git", ["-C", dir, "log"])')), [], "pointed at another repository");
  assert.deepEqual(historyLint('const nodes = [{ icon: "git", flavor: "info", label: "origin/main" }];'), [], "the word git, never run");
  assert.deepEqual(historyLint(file("// [3] no git diff HEAD^ needed", 'assert.deepEqual(parseRef("HEAD~1"), { back: 1 });')), [], "a comment, and a ref as data");
});
