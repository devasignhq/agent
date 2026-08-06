// Turns security-finding / scan-run row writes into live-refresh signals for
// the sponsor app's Security page — same shape as bounties/live.ts: db.ts
// reports "this row was written"; which writes matter and who cares lives here.
//
// Audience: the repo's installation members, resolved by userId (sponsors are
// DevAsign accounts). NOTE the join: Repository.installationId is a UUID
// joining Installation.id — NOT the numeric GitHub id bounties use.
//
// This module also owns the bounty→finding linkage: when a bounty appears (or
// changes) whose repo+issueNumber matches a finding in state "issue_created",
// the finding flips to state "bounty" — closing the "issue first, then bounty"
// loop without the Bounties flow knowing findings exist.
import { db, onRowChange } from "../db.js";
import { installMembers } from "../github/installations.js";
import { hasClients, notifyAudience } from "../notifications-stream.js";
import type { Bounty, Repository, SecurityFinding } from "../types.js";

// Scan-run log appends rewrite `log` (and nothing else visible) constantly
// while a run streams — those SHOULD notify (the terminal view is live), so
// unlike bounties there is no invisible-field filter on securityScans. For
// findings, version/updatedAt-ish stamps are the only noise and every patch we
// write is user-visible, so no filter there either.

const dirtyRepoIds = new Set<string>();
let flushQueued = false;

function queueFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

function flush(): void {
  flushQueued = false;
  const repoIds = [...dirtyRepoIds];
  dirtyRepoIds.clear();
  for (const repoId of repoIds) {
    const repo = db.find("repositories", (r) => r.id === repoId);
    if (!repo) continue;
    const install = db.find("installations", (i) => i.id === repo.installationId);
    if (!install) continue;
    const userIds = installMembers(install);
    if (userIds.length > 0) notifyAudience({ userIds }, "security-changed");
  }
}

// Match a bounty to the finding whose GitHub issue it funds. Bounty.repo is
// "owner/name"; findings hang off a Repository row.
function findingForBounty(b: Bounty): SecurityFinding | null {
  if (!b.issueNumber || !b.repo) return null;
  const [owner, name] = String(b.repo).split("/");
  if (!owner || !name) return null;
  const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (!repo) return null;
  return db.find(
    "securityFindings",
    (f) => f.repoId === repo.id && f.issueNumber === b.issueNumber && (f.state === "issue_created" || f.state === "bounty")
  );
}

let unsubscribe: (() => void) | null = null;

export function startSecurityLiveSignals(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onRowChange(({ collection, row, prev }) => {
    if (
      collection === "securityFindings" ||
      collection === "securityScans" ||
      // A ruling written, revoked, or retired changes the rulings ledger and
      // what the findings list shows as suppressed — both live on the same page.
      collection === "securityPrecedents"
    ) {
      if (!hasClients()) return;
      dirtyRepoIds.add((row as { repoId: string }).repoId);
      queueFlush();
      return;
    }

    if (collection === "repositories") {
      // Policy saves change the gate view for everyone looking at the repo.
      if (!hasClients()) return;
      const before = (prev as Repository | null)?.securityPolicy;
      const after = (row as Repository).securityPolicy;
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      dirtyRepoIds.add((row as Repository).id);
      queueFlush();
      return;
    }

    if (collection === "bounties") {
      // Bounty→finding linkage runs even with no client connected — it is a
      // state transition, not just a wake-up. Cheap: two indexed-ish finds,
      // only for bounties that reference an issue.
      const b = row as Bounty;
      const finding = findingForBounty(b);
      if (!finding) return;
      if (finding.state === "issue_created") {
        const now = Date.now();
        db.update("securityFindings", (f) => f.id === finding.id, {
          state: "bounty",
          bountyId: b.id,
          activity: [
            ...(finding.activity ?? []),
            {
              at: now,
              kind: "state_change" as const,
              detail: `Bounty posted on issue #${finding.issueNumber}`,
              actor: "audit-agent",
            },
          ].slice(-50),
        });
        // That update re-enters this listener via securityFindings and queues
        // the notify — nothing more to do here.
      }
    }
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
    dirtyRepoIds.clear();
  };
  return unsubscribe;
}
