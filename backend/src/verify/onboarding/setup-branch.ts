// Writing the setup branch. Once its PR is open the branch belongs to the maintainer
// too — they fix a port, add a secret, tweak the workflow — so it is brought up to
// date and written file by file, never reset. A reset is only safe while the branch is
// still ours: before the PR exists, or after it merged into the base.
import type { Installation, Repository } from "../../types.js";

export type SetupBranchDeps = {
  read: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  branchTip: (install: Installation, repo: Repository, branch: string) => Promise<string | null>;
  ensureBranch: (install: Installation, repo: Repository, branch: string, sha: string) => Promise<void>;
  putFile: (install: Installation, repo: Repository, branch: string, path: string, content: string, message: string) => Promise<void>;
  createPr: (install: Installation, repo: Repository, args: { title: string; body: string; head: string; base: string }) => Promise<{ number: number; html_url: string }>;
  updatePr: (install: Installation, repo: Repository, prNumber: number, patch: { body: string }) => Promise<void>;
  findPr: (install: Installation, repo: Repository, head: string) => Promise<{ number: number; html_url: string; body?: string } | null>;
  updateBranch: (install: Installation, repo: Repository, prNumber: number) => Promise<boolean>;
  behindBy: (install: Installation, repo: Repository, base: string, head: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** What the branch should say: the full desired content of every file we manage, plus the PR body. */
export type SetupWrite = { files: Record<string, string>; body: string };

export type SetupPrOutcome<T extends SetupWrite> =
  | { status: "opened"; prNumber: number; prUrl: string; created: boolean; written: string[]; built: T }
  | { status: "skipped"; reason: string; built: T }
  | { status: "failed"; reason: string };

export const BRANCH_SYNC_TIMEOUT_MS = 15_000;
export const BRANCH_SYNC_POLL_MS = 1_000;

const commitMessage = (path: string) => `${path.includes("workflows") ? "Add" : "Configure"} DevAsign verification (${path})`;

/**
 * Open the setup PR, or update the one that is already open without clobbering it.
 * `build` sees the current content of `readAtBranch` at whichever ref is about to be
 * written, and returns the files it wants there; only the ones that differ are pushed.
 */
export async function writeSetupPr<T extends SetupWrite>(args: {
  install: Installation;
  repo: Repository;
  branch: string;
  base: string;
  headSha: string;
  title: string;
  readAtBranch: string[];
  defaults: Record<string, string | null>;
  // Whether a branch that already exists is ours to reset. False once its PR was closed
  // unmerged: whatever is on it then is the maintainer's, and force-pushing destroys it.
  resettable: boolean;
  build: (current: Record<string, string | null>) => T | Promise<T>;
  deps: SetupBranchDeps;
}): Promise<SetupPrOutcome<T>> {
  const { install, repo, branch, base, headSha, title, deps: d } = args;
  const open = await d.findPr(install, repo, branch);
  const tip = open || args.resettable ? null : await d.branchTip(install, repo, branch);

  let current = args.defaults;
  if (open) {
    const synced = await syncBranch(args, open.number);
    if (!synced.ok) return { status: "failed", reason: synced.reason };
  } else if (tip && (await d.behindBy(install, repo, base, branch)) !== 0) {
    // Their commits are on it and it is behind the base, and with no PR there is nothing
    // to update-branch. Writing here would propose reverting whatever moved on since.
    return { status: "failed", reason: `the setup branch ${branch} has unmerged commits and is behind ${base} — reopen its pull request or delete the branch, then try again` };
  }
  if (open || tip) {
    current = {};
    for (const p of new Set(args.readAtBranch)) current[p] = await d.read(install, repo, p, branch);
  }

  const built = await args.build(current);
  const written = Object.keys(built.files);
  if (!open && !written.length) return { status: "skipped", reason: "the verification setup is already up to date", built };
  if (!open && !tip) await d.ensureBranch(install, repo, branch, headSha);
  for (const [path, content] of Object.entries(built.files)) await d.putFile(install, repo, branch, path, content, commitMessage(path));

  if (open) {
    if (built.body !== (open.body ?? "")) await d.updatePr(install, repo, open.number, { body: built.body });
    return { status: "opened", prNumber: open.number, prUrl: open.html_url, created: false, written, built };
  }
  const pr = await d.createPr(install, repo, { title, body: built.body, head: branch, base });
  return { status: "opened", prNumber: pr.number, prUrl: pr.html_url, created: true, written, built };
}

// GitHub merges the base in asynchronously, so a read right after update-branch can still
// see the pre-merge tree — and writing against that would revert the maintainer's base.
async function syncBranch(
  args: { install: Installation; repo: Repository; branch: string; base: string; deps: SetupBranchDeps },
  prNumber: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { install, repo, branch, base, deps: d } = args;
  // false means GitHub refused the merge — a conflict, or nothing to merge.
  const merged = await d.updateBranch(install, repo, prNumber);
  const deadline = d.now() + BRANCH_SYNC_TIMEOUT_MS;
  for (;;) {
    // An unrecognised compare shape is not proof of "caught up": only a 0 is.
    if ((await d.behindBy(install, repo, base, branch)) === 0) return { ok: true };
    if (d.now() >= deadline) {
      const why = merged ? `after ${BRANCH_SYNC_TIMEOUT_MS / 1000}s` : "and GitHub would not merge it (conflict?)";
      return { ok: false, reason: `the setup branch is still behind ${base} ${why} — nothing was written; try again` };
    }
    await d.sleep(BRANCH_SYNC_POLL_MS);
  }
}
