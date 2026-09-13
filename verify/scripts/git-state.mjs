// One definition of "this checkout" for the publish guard and the build's commit stamp.
import { execFileSync } from "node:child_process";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const head = (cwd) => git(cwd, "rev-parse", "HEAD").trim();

export const short = (sha) => sha.slice(0, 12);

// Scoped to the package, the only thing the tarball is built from. A worktree's node_modules
// is often a symlink, which .gitignore's `node_modules/` does not match.
export const uncommitted = (cwd) =>
  git(cwd, "status", "--porcelain", "--", ".", ":(exclude)node_modules").split("\n").filter(Boolean);
