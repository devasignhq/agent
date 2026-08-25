// Orchestrates the four cross-repo phases inside a PR review.
//
// Every exit is a log line and an empty result — never a throw and never a
// verdict change. The stage is last in the pipeline precisely so that an abort
// costs nothing already computed.
import { db } from "../../db.js";
import { enqueueCrossRepoTopology } from "../../queue.js";
import { discoverCandidates, probeParity, type ParityProbe } from "./discovery.js";
import { familyOf, rankSiblings, topologyFor } from "./topology.js";
import { ownerOf, repoNameOf } from "./naming.js";
import { slugify } from "./naming.js";
import { closeParityGapsFor } from "./parity.js";
import {
  CROSS_REPO_BUDGET_MS,
  EMPTY_CROSS_REPO,
  assessCrossRepoImpact,
  extractContractDelta,
  needlesForDelta,
  scanContractCandidates,
  type CrossRepoResult,
} from "./stage.js";
import type { Installation, PRReview, RepoTopology, Repository } from "../../types.js";

export const CROSS_REPO_STAGE_DISABLED = "Cross-repo impact disabled by workflow";
export const CROSS_REPO_PLAN_LOCKED = "Cross-repo impact is a Pro/Max feature";
export const CROSS_REPO_NO_INSTALL = "Cross-repo impact skipped — no installation token";
export const CROSS_REPO_NO_TOPOLOGY = "Cross-repo impact — org map not built yet";
export const CROSS_REPO_NO_SURFACE = "Cross-repo impact — this change has no external surface";
export const CROSS_REPO_NO_SIBLINGS = "Cross-repo impact — no sibling repositories to check";
export const CROSS_REPO_VISIBILITY_FILTERED = "Cross-repo impact — private siblings withheld";

export const MAX_SIBLING_REPOS = 12;

// Visibility gate for everything this stage can publish.
//
// A finding names a sibling repo, a path and a verbatim source line, and it is
// rendered into a PR comment. When the reviewed repo is PUBLIC that comment is
// readable by anyone, so only PUBLIC siblings may be quoted — even though the
// installation token can read the private ones. Unknown visibility counts as
// private: a topology row written before this existed carries no flag, and
// failing open there would leak exactly what this guard exists to prevent.
export function visibleSiblings(args: {
  installId: string;
  selfPrivate: boolean;
  names: string[];
  topology: RepoTopology | null;
}): string[] {
  if (args.selfPrivate) return args.names;
  const topoByName = new Map((args.topology?.repos ?? []).map((r) => [r.fullName, r]));
  return args.names.filter((fullName) => {
    const owner = ownerOf(fullName);
    const name = repoNameOf(fullName);
    const row = db.find("repositories", (r) => r.owner === owner && r.name === name);
    if (row) return !row.private;
    const topo = topoByName.get(fullName);
    return topo?.private === false;
  });
}

type LogFn = (action: string, extra?: { detail?: string; meta?: Record<string, unknown> }) => void;

export async function runCrossRepoStage(args: {
  review: PRReview;
  repo: Repository;
  install: Installation;
  diff: string;
  extraInstructions?: string;
  log: LogFn;
}): Promise<CrossRepoResult> {
  const { repo, install, log } = args;
  const deadline = Date.now() + CROSS_REPO_BUDGET_MS;
  const selfFullName = `${repo.owner}/${repo.name}`;

  const candidates = scanContractCandidates(args.diff);
  if (!candidates.length) {
    log(CROSS_REPO_NO_SURFACE);
    return EMPTY_CROSS_REPO;
  }

  const topology = topologyFor(install.id);
  if (!topology || !topology.repos.length) {
    log(CROSS_REPO_NO_TOPOLOGY, {
      detail: "Falling back to the repositories DevAsign already has for this installation.",
    });
    enqueueCrossRepoTopology({ installationId: install.id, trigger: "cold" });
  }

  const allNames = topology?.repos.length
    ? topology.repos.map((r) => r.fullName)
    : db
        .filter("repositories", (r) => r.installationId === install.id)
        .map((r) => `${r.owner}/${r.name}`);
  const visible = visibleSiblings({
    installId: install.id,
    selfPrivate: Boolean(repo.private),
    names: allNames,
    topology,
  });
  if (visible.length < allNames.length) {
    log(CROSS_REPO_VISIBILITY_FILTERED, {
      detail:
        `${allNames.length - visible.length} sibling repo(s) withheld: this PR is public, so a ` +
        "private sibling's path and source cannot be quoted into the review.",
      meta: { considered: allNames.length, visible: visible.length },
    });
  }
  const siblingNames = rankSiblings(topology, selfFullName, visible, MAX_SIBLING_REPOS);
  if (!siblingNames.length) {
    log(CROSS_REPO_NO_SIBLINGS);
    return EMPTY_CROSS_REPO;
  }
  const allowedRepos = new Set(siblingNames);

  const delta = await extractContractDelta({ diff: args.diff, candidates });
  if (!delta.length) {
    log(CROSS_REPO_NO_SURFACE, { meta: { candidates: candidates.length } });
    return EMPTY_CROSS_REPO;
  }

  // Close before opening: a gap this repo owed is resolved by the very entries
  // that would otherwise be read as new capabilities.
  const addedNames = delta.filter((e) => e.change === "added").map((e) => e.name);
  if (addedNames.length) {
    const closed = closeParityGapsFor({
      installationId: install.id,
      repoFullName: selfFullName,
      addedNames,
      sha: args.review.headSha,
      prNumber: args.review.prNumber ?? null,
    });
    if (closed.length) {
      log(`Cross-repo: closed ${closed.length} parity gap(s)`, {
        detail: closed.map((c) => c.featureId).join(", "),
        meta: { closed: closed.map((c) => c.featureId) },
      });
    }
  }

  const needles = needlesForDelta(delta);
  const publishedName = topology?.repos.find((r) => r.fullName === selfFullName)?.publishedName;

  let snippets: Awaited<ReturnType<typeof discoverCandidates>>["snippets"] = [];
  let searchesRun = 0;
  if (needles.length && Date.now() < deadline) {
    const found = await discoverCandidates({
      install,
      topology,
      siblingNames,
      needles,
      publishedName,
      selfFullName,
      allowedRepos,
      deadline,
    });
    snippets = found.snippets;
    searchesRun = found.searchesRun;
  }

  const parityProbes = collectParityProbes({
    delta,
    topology,
    selfFullName,
    allowedRepos,
  });

  if (!snippets.length && !parityProbes.size) {
    log("Cross-repo impact — nothing to assess", {
      detail:
        `${delta.length} contract change(s), ${siblingNames.length} sibling(s) checked, ` +
        "no consuming code and no parity candidates found.",
      meta: { delta: delta.length, siblings: siblingNames.length, searches: searchesRun },
    });
    return EMPTY_CROSS_REPO;
  }

  const family = familyOf(topology, selfFullName);
  const result = await assessCrossRepoImpact({
    delta,
    snippets,
    parityProbes,
    // Filtered too: a repo we may not quote should not be named to the model at
    // all, or it can surface in the summary even though findings about it drop.
    familyMembers:
      family?.members.filter((m) => m !== selfFullName && allowedRepos.has(m)) ?? [],
    selfFullName,
    extraInstructions: args.extraInstructions,
  });

  log(
    result.impacts.length + result.parityNotes.length
      ? `Cross-repo: ${result.impacts.length} impact(s), ${result.parityNotes.length} parity note(s)`
      : "Cross-repo impact — no breakage found",
    {
      detail:
        result.summary ||
        `Checked ${siblingNames.length} sibling repo(s) against ${delta.length} contract change(s).`,
      meta: {
        delta: delta.length,
        siblings: siblingNames.length,
        snippets: snippets.length,
        searches: searchesRun,
        impacts: result.impacts.length,
        parity: result.parityNotes.length,
        codeSearch: topology?.codeSearch.status ?? "unknown",
        truncated: Boolean(topology?.truncated),
      },
    }
  );
  return { ...result, family: family?.name };
}

// Parity only speaks about repos we actually read. A truncated enumeration means
// there are siblings we never saw, so no absence claim is safe at all.
function collectParityProbes(args: {
  delta: Awaited<ReturnType<typeof extractContractDelta>>;
  topology: ReturnType<typeof topologyFor>;
  selfFullName: string;
  allowedRepos: Set<string>;
}): Map<string, ParityProbe[]> {
  const out = new Map<string, ParityProbe[]>();
  if (args.topology?.truncated) return out;
  // Family membership comes from the topology, not from the filtered list, so it
  // has to be intersected here too — a "Missing in: <private repo>" note leaks
  // the same name a breakage finding would.
  const family = familyOf(args.topology, args.selfFullName);
  const members = (family?.members ?? []).filter(
    (m) => m !== args.selfFullName && args.allowedRepos.has(m)
  );
  if (members.length < 1) return out;

  const added = args.delta.filter((e) => e.change === "added").slice(0, 3);
  for (const entry of added) {
    const slug = slugify(entry.name);
    if (!slug) continue;
    const probes = probeParity(members, entry.name);
    if (probes.some((p) => p.status === "absent")) out.set(slug, probes);
  }
  return out;
}

