// Orchestrates the four cross-repo phases inside a PR review.
//
// Every exit is a log line and an empty result — never a throw and never a
// verdict change. The stage is last in the pipeline precisely so that an abort
// costs nothing already computed.
import { db } from "../../db.js";
import { enqueueCrossRepoTopology } from "../../queue.js";
import { discoverCandidates, probeParity, type ParityProbe } from "./discovery.js";
import { familyOf, rankSiblings, topologyFor } from "./topology.js";
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
import type { Installation, PRReview, RepoIndexEntry, Repository } from "../../types.js";

export const CROSS_REPO_STAGE_DISABLED = "Cross-repo impact disabled by workflow";
export const CROSS_REPO_PLAN_LOCKED = "Cross-repo impact is a Pro/Max feature";
export const CROSS_REPO_NO_INSTALL = "Cross-repo impact skipped — no installation token";
export const CROSS_REPO_NO_TOPOLOGY = "Cross-repo impact — org map not built yet";
export const CROSS_REPO_NO_SURFACE = "Cross-repo impact — this change has no external surface";
export const CROSS_REPO_NO_SIBLINGS = "Cross-repo impact — no sibling repositories to check";

export const MAX_SIBLING_REPOS = 12;

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
  const siblingNames = rankSiblings(topology, selfFullName, allNames, MAX_SIBLING_REPOS);
  if (!siblingNames.length) {
    log(CROSS_REPO_NO_SIBLINGS);
    return EMPTY_CROSS_REPO;
  }

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
      deadline,
    });
    snippets = found.snippets;
    searchesRun = found.searchesRun;
  }

  const parityProbes = collectParityProbes({
    delta,
    topology,
    selfFullName,
    siblingNames,
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
    familyMembers: family?.members.filter((m) => m !== selfFullName) ?? [],
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
  siblingNames: string[];
}): Map<string, ParityProbe[]> {
  const out = new Map<string, ParityProbe[]>();
  if (args.topology?.truncated) return out;
  const family = familyOf(args.topology, args.selfFullName);
  const members = (family?.members ?? []).filter((m) => m !== args.selfFullName);
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

export type { RepoIndexEntry };
