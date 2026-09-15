// The default branch's verify block, snapshotted onto repo.verify.defaultYml. Setup status is
// judged on it; the planner's devasignYml follows whichever PR was planned last.
import { db } from "../db.js";
import { getBranchSha, ghText } from "../github/app.js";
import type { Installation, Repository, RepoVerifyState } from "../types.js";
import { parseDevasignVerify } from "./yml.js";
import { bootHash, patchRepoVerify } from "./repo-state.js";

export const DEFAULT_YML_REFRESH_MS = 60_000;

export type DefaultYmlDeps = {
  branchSha?: (install: Installation, repo: Repository, branch: string) => Promise<string>;
  // null only when the file is absent; any other failure throws, so it is never cached as "no yml".
  read?: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  now?: () => number;
};

async function readOrAbsent(install: Installation, repo: Repository, path: string, ref: string): Promise<string | null> {
  try {
    return await ghText(install.installationId, `/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { Accept: "application/vnd.github.raw" });
  } catch (err) {
    if (/^gh text 404 /.test(err instanceof Error ? err.message : "")) return null;
    throw err;
  }
}

const lastAttemptAt = new Map<string, number>();
const inFlight = new Map<string, Promise<RepoVerifyState["defaultYml"] | null>>();

// At most once per DEFAULT_YML_REFRESH_MS per repo unless forced, failed attempts included, and one
// at a time; no file read when the head has not moved. Never throws: a GitHub error keeps the old snapshot.
export function refreshDefaultYml(repoId: string, opts: { force?: boolean; deps?: DefaultYmlDeps } = {}): Promise<RepoVerifyState["defaultYml"] | null> {
  const running = inFlight.get(repoId);
  if (running && !opts.force) return running;
  const go = () => attempt(repoId, opts);
  const next = (running ?? Promise.resolve(null)).then(go, go);
  inFlight.set(repoId, next);
  const clear = () => {
    if (inFlight.get(repoId) === next) inFlight.delete(repoId);
  };
  next.then(clear, clear);
  return next;
}

async function attempt(repoId: string, opts: { force?: boolean; deps?: DefaultYmlDeps }): Promise<RepoVerifyState["defaultYml"] | null> {
  const d = {
    branchSha: opts.deps?.branchSha ?? ((install, repo, branch) => getBranchSha(install.installationId, repo.owner, repo.name, branch)),
    read: opts.deps?.read ?? readOrAbsent,
    now: opts.deps?.now ?? Date.now,
  } satisfies Required<DefaultYmlDeps>;
  const repo = db.find("repositories", (r) => r.id === repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return null;
  const prev = repo.verify?.defaultYml ?? null;
  const now = d.now();
  const since = Math.max(prev?.at ?? -Infinity, lastAttemptAt.get(repoId) ?? -Infinity);
  if (!opts.force && now - since < DEFAULT_YML_REFRESH_MS) return prev;
  lastAttemptAt.set(repoId, now);
  try {
    const sha = await d.branchSha(install, repo, repo.defaultBranch || "main");
    if (prev && prev.sha === sha) {
      const touched = { ...prev, at: now };
      patchRepoVerify(repoId, (cur) => ({ ...cur, defaultYml: touched }));
      return touched;
    }
    const parsed = parseDevasignVerify(await d.read(install, repo, ".devasign.yml", sha));
    const next = { sha, parsed, bootHash: bootHash(parsed), at: now };
    patchRepoVerify(repoId, (cur) => ({ ...cur, defaultYml: next }));
    return next;
  } catch (err) {
    console.warn(`[verify] could not refresh the default-branch .devasign.yml for ${repo.owner}/${repo.name}:`, err instanceof Error ? err.message : err);
    return prev;
  }
}
