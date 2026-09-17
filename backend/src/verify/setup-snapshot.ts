// What the setup panel needs from GitHub and no stored state can answer: the yml the open setup
// PR proposes, and the default tree its candidate pickers are built from. A tree costs a listing
// plus a read per manifest, so it is cached per repo and refetched only when the default head moves.
import { db } from "../db.js";
import { readFileAtRefStrict } from "../github/app.js";
import { fetchTree, type TreeEntry } from "../review/indexer.js";
import type { Installation, Repository } from "../types.js";
import type { DevasignVerifyConfig } from "./contract.js";
import { inferenceFilesFor } from "./boot-inference.js";
import { parseDevasignVerify } from "./yml.js";
import { DEVASIGN_YML_PATH, ONBOARDING_BRANCH } from "./onboarding/generate.js";

export type SetupSnapshotDeps = {
  tree?: (repo: Repository, install: Installation, sha: string) => Promise<TreeEntry[]>;
  read?: (install: Installation, repo: Repository, path: string, ref: string) => Promise<string | null>;
  now?: () => number;
};

export type SetupTree = { paths: string[]; files: Record<string, string | null> };
export type SetupSnapshot = { proposed: DevasignVerifyConfig | null; tree: SetupTree | null };

export const SETUP_SNAPSHOT_TTL_MS = 60_000;

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAX_WORKFLOWS = 10;
const MAX_READS = 40;
const ROOT_FILES = ["package.json", ".env.example", ".env.test"];

type Entry = { at: number; sha: string | null; paths: string[]; files: Record<string, string | null>; proposed: DevasignVerifyConfig | null };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry>>();

const view = (e: Entry): SetupSnapshot => ({ proposed: e.proposed, tree: e.paths.length ? { paths: e.paths, files: e.files } : null });

/** The panel's view of `defaultSha`, from cache when it can be. Never throws: GitHub being down
 *  leaves the pickers empty rather than failing the whole status read. */
export function setupSnapshot(repoId: string, defaultSha: string | null, deps: SetupSnapshotDeps = {}): Promise<SetupSnapshot> {
  const now = deps.now ?? Date.now;
  const cached = cache.get(repoId);
  if (cached && cached.sha === defaultSha && now() - cached.at < SETUP_SNAPSHOT_TTL_MS) return Promise.resolve(view(cached));
  const running = inFlight.get(repoId);
  if (running) return running.then(view);
  const next = build(repoId, defaultSha, deps, cached).then(
    (entry) => {
      cache.set(repoId, entry);
      return entry;
    },
    (err) => {
      console.warn(`[verify] setup snapshot failed for repo ${repoId}:`, err instanceof Error ? err.message : err);
      return cached ?? { at: now(), sha: defaultSha, paths: [], files: {}, proposed: null };
    }
  );
  inFlight.set(repoId, next);
  const clear = () => {
    if (inFlight.get(repoId) === next) inFlight.delete(repoId);
  };
  next.then(clear, clear);
  return next.then(view);
}

/** The tree from the panel's last open, for callers that cannot afford to fetch one. Answers are
 *  posted seconds after that open, so this is normally the tree they were chosen against. */
export function cachedSetupTree(repoId: string): SetupTree | undefined {
  const e = cache.get(repoId);
  return e?.paths.length ? { paths: e.paths, files: e.files } : undefined;
}

async function build(repoId: string, defaultSha: string | null, deps: SetupSnapshotDeps, prev: Entry | undefined): Promise<Entry> {
  const now = (deps.now ?? Date.now)();
  const repo = db.find("repositories", (r) => r.id === repoId);
  const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
  if (!repo || !install) return { at: now, sha: defaultSha, paths: [], files: {}, proposed: null };
  const read = deps.read ?? ((i: Installation, r: Repository, path: string, ref: string) => readFileAtRefStrict(i.installationId, r.owner, r.name, path, ref));
  const listTree = deps.tree ?? ((r: Repository, i: Installation, sha: string) => fetchTree(r, i, sha));

  let paths = prev?.sha === defaultSha ? prev.paths : [];
  let files = prev?.sha === defaultSha ? prev.files : {};
  if (defaultSha && prev?.sha !== defaultSha) {
    const entries = await listTree(repo, install, defaultSha);
    paths = entries.filter((e) => e.type === "blob").map((e) => e.path);
    files = {};
    const workflows = paths.filter((p) => WORKFLOW_FILE.test(p)).slice(0, MAX_WORKFLOWS);
    for (const p of [...new Set([...ROOT_FILES, ...inferenceFilesFor(paths), ...workflows])].slice(0, MAX_READS)) {
      files[p] = paths.includes(p) ? await read(install, repo, p, defaultSha) : null;
    }
  }
  // Only an open setup PR proposes anything; the branch outlives the PR, so its content is not
  // what the maintainer is being asked about once that PR closed.
  const proposed = repo.verify?.onboarding?.setupPrOpen
    ? parseDevasignVerify(await read(install, repo, DEVASIGN_YML_PATH, ONBOARDING_BRANCH))
    : null;
  return { at: now, sha: defaultSha, paths, files, proposed };
}
