// Worker entry + hourly sweep for the org topology map.
import { db } from "../../db.js";
import { crossRepoBlocked } from "../../billing/plans.js";
import { enqueueCrossRepoTopology, type CrossRepoTopologyJobPayload } from "../../queue.js";
import { buildTopology, topologyFor, topologyStale } from "./topology.js";
import { effectiveWorkflow } from "../workflow.js";

// The stage is opt-in and off by default, so an unguarded build spends ~3 GitHub
// calls per repo (plus a search probe) drawing a map nobody will read. Every
// trigger checks this; a repo turning the stage on gets its map from the cold
// enqueue on that repo's first review.
export function installationWantsCrossRepo(installationId: string): boolean {
  return db
    .filter("repositories", (r) => r.installationId === installationId)
    .some((r) => effectiveWorkflow(r).stages.crossRepo);
}

export async function runCrossRepoTopologyJob(payload: CrossRepoTopologyJobPayload): Promise<void> {
  const install = db.find("installations", (i) => i.id === payload.installationId);
  if (!install) return;
  if (crossRepoBlocked(install.userId)) return;
  if (!installationWantsCrossRepo(install.id)) return;
  try {
    const row = await buildTopology(install);
    console.log(
      `[cross-repo] topology ${install.accountLogin}: ${row.repoCount} repos, ` +
        `${row.families.length} families, ${row.edges.length} edges, ` +
        `code-search ${row.codeSearch.status}${row.truncated ? ", TRUNCATED" : ""}`
    );
  } catch (err) {
    console.warn(`[cross-repo] topology failed for ${install.accountLogin}: ${err}`);
    const prior = topologyFor(install.id);
    if (prior) {
      db.update("repoTopologies", (t) => t.id === prior.id, { error: String(err).slice(0, 400) });
    }
  }
}

// The retry for a dropped in-memory job, and the only rebuild trigger that needs
// no webhook. Cheap: staleness is decided from rows already in memory.
// Exported so the sweep's decision logic is reachable from a test; startTopologyRefresh
// only wires it to a timer. Returns how many builds it enqueued.
export function sweepStaleTopologies(now = Date.now()): number {
  let enqueued = 0;
  for (const install of db.table("installations")) {
    if (!install.userId) continue;
    if (crossRepoBlocked(install.userId)) continue;
    if (!installationWantsCrossRepo(install.id)) continue;
    if (!topologyStale(topologyFor(install.id), install, now)) continue;
    enqueueCrossRepoTopology({ installationId: install.id, trigger: "stale" });
    enqueued += 1;
  }
  return enqueued;
}

export function startTopologyRefresh(): void {
  const HOUR = 60 * 60 * 1000;
  // Wrapped: a throw inside a setInterval callback is an uncaught exception that
  // takes the process down, and this one would first fire an hour into production.
  setInterval(() => {
    try {
      sweepStaleTopologies();
    } catch (err) {
      console.warn(`[cross-repo] topology sweep failed: ${err}`);
    }
  }, HOUR);
}
