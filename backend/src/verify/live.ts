// Verify-run / artifact row writes → a "verify-changed" live signal to the
// repo's installation members (same shape as security/live.ts).
import { db, onRowChange } from "../db.js";
import { installMembers } from "../github/installations.js";
import { hasClients, notifyAudience } from "../notifications-stream.js";
import { changedBeyond } from "../bounties/live.js";
import type { VerifyArtifact, VerifyRun } from "../types.js";

// updatedAt is stamped on every updateRun; a reaper touch that changes nothing
// else must not wake every open tab.
const INVISIBLE_RUN_FIELDS = new Set(["updatedAt", "version"]);

const dirtyRepoIds = new Set<string>();
let flushQueued = false;

function flush(): void {
  flushQueued = false;
  const repoIds = [...dirtyRepoIds];
  dirtyRepoIds.clear();
  for (const repoId of repoIds) {
    const repo = db.find("repositories", (r) => r.id === repoId);
    const install = repo ? db.find("installations", (i) => i.id === repo.installationId) : null;
    if (!install) continue;
    const userIds = installMembers(install);
    if (userIds.length > 0) notifyAudience({ userIds }, "verify-changed");
  }
}

export function verifyRowMatters(collection: string, row: unknown, prev: unknown): string | null {
  if (collection === "verifyRuns") {
    if (!changedBeyond(prev, row, INVISIBLE_RUN_FIELDS)) return null;
    return (row as VerifyRun).repoId;
  }
  if (collection === "verifyArtifacts") {
    const a = row as VerifyArtifact;
    const p = prev as VerifyArtifact | null;
    // Only state transitions are visible (uploaded, expired); a signing insert is not.
    if (p && p.state === a.state) return null;
    if (!p && a.state === "pending_upload") return null;
    return a.repoId;
  }
  return null;
}

let unsubscribe: (() => void) | null = null;

export function startVerifyLiveSignals(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onRowChange(({ collection, row, prev }) => {
    if (!hasClients()) return;
    const repoId = verifyRowMatters(collection, row, prev);
    if (!repoId) return;
    dirtyRepoIds.add(repoId);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
    dirtyRepoIds.clear();
  };
  return unsubscribe;
}
