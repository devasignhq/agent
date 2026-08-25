// Worker entry + hourly sweep for the org topology map.
import { db } from "../../db.js";
import { crossRepoBlocked } from "../../billing/plans.js";
import { enqueueCrossRepoTopology, type CrossRepoTopologyJobPayload } from "../../queue.js";
import { buildTopology, topologyFor, topologyStale } from "./topology.js";

export async function runCrossRepoTopologyJob(payload: CrossRepoTopologyJobPayload): Promise<void> {
  const install = db.find("installations", (i) => i.id === payload.installationId);
  if (!install) return;
  if (crossRepoBlocked(install.userId)) return;
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
export function startTopologyRefresh(): void {
  const HOUR = 60 * 60 * 1000;
  const tick = () => {
    const now = Date.now();
    for (const install of db.table("installations")) {
      if (!install.userId) continue;
      if (crossRepoBlocked(install.userId)) continue;
      if (!topologyStale(topologyFor(install.id), install, now)) continue;
      enqueueCrossRepoTopology({ installationId: install.id, trigger: "stale" });
    }
  };
  setInterval(tick, HOUR);
}
