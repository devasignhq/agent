// node --test scripts/publish-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./publish-guard.mjs", import.meta.url));
const OVERRIDE = "DEVASIGN_PUBLISH_OVERRIDE";

// A hook's GIT_DIR would aim every call at the outer repo, and user config (signing,
// hooks, default branch) would change what commit and push do.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== OVERRIDE)),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

function commit(repo, file, body) {
  writeFileSync(path.join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", file);
  return git(repo, "rev-parse", "HEAD");
}

// Shaped like this repo: the package lives in verify/, pushed to a local bare origin.
function checkout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dv-guard-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(path.join(work, "verify"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", origin);
  commit(work, "verify/package.json", "{}");
  git(work, "push", "-q", "--no-verify", "origin", "main");
  return { root, origin, work, pkg: path.join(work, "verify") };
}

const publish = (pkg, override) =>
  spawnSync(process.execPath, [guard], { cwd: pkg, env: override === undefined ? env : { ...env, [OVERRIDE]: override }, encoding: "utf8" });

test("passes the tip of origin/main, whatever lies outside the package or in a node_modules symlink", () => {
  const { work, pkg } = checkout();
  writeFileSync(path.join(work, "notes.txt"), "scratch");
  symlinkSync(os.tmpdir(), path.join(pkg, "node_modules"));
  const r = publish(pkg);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is origin\/main, nothing uncommitted/);
});

test("refuses a checkout that origin/main has moved past, though its own origin/main ref is stale", () => {
  const { root, origin, pkg } = checkout();
  const other = path.join(root, "other");
  git(root, "clone", "-q", origin, other);
  const merged = commit(other, "verify/fix.ts", "export {};");
  git(other, "push", "-q", "--no-verify", "origin", "main");

  const r = publish(pkg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`is not origin/main ${merged.slice(0, 12)}`));
});

test("refuses a commit origin/main does not have", () => {
  const { work, pkg } = checkout();
  commit(work, "verify/unpushed.ts", "export {};");
  const r = publish(pkg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not origin\/main/);
});

test("refuses uncommitted changes in the package, tracked or untracked", () => {
  const { pkg } = checkout();
  writeFileSync(path.join(pkg, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(path.join(pkg, "stray.ts"), "export {};");
  const r = publish(pkg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, / M verify\/package\.json/);
  assert.match(r.stderr, /\?\? verify\/stray\.ts/);
});

test("an override must name HEAD: then it publishes and still reports what it overrode", () => {
  const { work, pkg } = checkout();
  const sha = commit(work, "verify/unpushed.ts", "export {};");
  writeFileSync(path.join(pkg, "stray.ts"), "export {};");

  for (const value of ["1", "true", sha.slice(0, 6)]) {
    const r = publish(pkg, value);
    assert.equal(r.status, 1, `${OVERRIDE}=${value}`);
    assert.match(r.stderr, /does not name HEAD/);
  }
  const r = publish(pkg, sha.slice(0, 12));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /is not origin\/main/);
  assert.match(r.stderr, /stray\.ts/);
});

test("refuses when origin/main cannot be fetched, unless overridden", () => {
  const { root, work, pkg } = checkout();
  git(work, "remote", "set-url", "origin", path.join(root, "missing.git"));
  const r = publish(pkg);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not fetch origin\/main/);
  assert.equal(publish(pkg, git(work, "rev-parse", "HEAD")).status, 0);
});
