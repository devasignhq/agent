// First step of prepublishOnly. 1.4.0 went out from a stale worktree minutes after the fix
// it lacked (#224) merged, so only a committed origin/main tip may be published.
import { git, head, short, uncommitted } from "./git-state.mjs";

const OVERRIDE = "DEVASIGN_PUBLISH_OVERRIDE";
const cwd = process.cwd();
const sha = head(cwd);
const problems = [];

try {
  git(cwd, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
  const main = git(cwd, "rev-parse", "refs/remotes/origin/main").trim();
  if (sha !== main) problems.push(`HEAD ${short(sha)} is not origin/main ${short(main)}`);
} catch (err) {
  problems.push(`could not fetch origin/main: ${String(err.stderr || err.message).trim()}`);
}
const dirty = uncommitted(cwd);
if (dirty.length) problems.push(`uncommitted changes:\n${dirty.map((line) => `    ${line}`).join("\n")}`);

if (!problems.length) {
  console.log(`publish-guard: ${short(sha)} is origin/main, nothing uncommitted`);
  process.exit(0);
}
for (const p of problems) console.error(`publish-guard: ${p}`);

// Must name HEAD, so an override left exported cannot wave through a later commit.
const override = process.env[OVERRIDE] ?? "";
if (override.length >= 7 && sha.startsWith(override)) {
  console.error(`publish-guard: ${OVERRIDE} names HEAD; publishing ${short(sha)} anyway`);
  process.exit(0);
}
if (override) console.error(`publish-guard: ${OVERRIDE}=${override} does not name HEAD ${short(sha)}`);
console.error(`publish-guard: refusing to publish. Publish from a clean checkout of origin/main, or in an emergency: ${OVERRIDE}=${short(sha)} npm publish`);
process.exit(1);
