// The db-touching companion to precedent.ts, which stays pure. Everything here
// is a small write that more than one caller needs, kept in one place so the
// rules about when a ruling stops being trusted live together.
import { db } from "../db.js";
import type { SecurityFinding, SecurityPrecedent } from "../types.js";

// A maintainer's ruling muted this finding — and then a human turned round and
// treated it as real (filed an issue, reopened it for triage). That is the loop
// correcting itself: the ruling stops auto-suppressing immediately and is
// surfaced for re-confirmation rather than deleted, because the maintainer
// still needs to see what it was and decide.
//
// This is the guardrail metric too. A ruling that keeps getting contradicted is
// the signal that the corpus is muting real work.
// Two findings can contradict a ruling, and they are not the same one:
//   - a finding the ruling MUTED (suppressedByPrecedentId), and
//   - the finding the ruling was MADE ON (originFindingId), which carries no
//     suppressedByPrecedentId because a human marked it by hand.
// The second is the stronger signal — the maintainer is overturning their own
// call — so missing it would leave the ruling that started this muting others.
export function contradictPrecedent(finding: Pick<SecurityFinding, "id" | "suppressedByPrecedentId">): void {
  const id = finding.suppressedByPrecedentId;
  // db.update patches the FIRST match only, so sweep — the two clauses can name
  // different rows, and one finding can have been ruled on more than once.
  const hits = db.filter(
    "securityPrecedents",
    (p) => p.status === "active" && (p.id === id || p.originFindingId === finding.id)
  );
  for (const p of hits) {
    db.update("securityPrecedents", (r) => r.id === p.id, {
      status: "needs_reconfirm",
      statusReason: "contradicted",
    });
  }
}

// Every ruling in scope for one installation — what an audit run honours, and
// what its maintainers see and can withdraw. Callers should do this once and
// reuse it: db.filter is a full linear scan with no indexes.
export function corpusForInstallations(installationIds: string[]): SecurityPrecedent[] {
  if (!installationIds.length) return [];
  const ids = new Set(installationIds);
  return db.filter("securityPrecedents", (p) => ids.has(p.installationId));
}

// Withdraw a ruling and un-mute everything it suppressed. The findings go back
// to open rather than to "new": they aren't fresh discoveries, they are things
// the maintainer had already decided about and is now reconsidering.
export function revokePrecedent(p: SecurityPrecedent, actorLogin: string, now: number): number {
  db.update("securityPrecedents", (r) => r.id === p.id, {
    status: "revoked",
    statusReason: "revoked",
    revokedAt: now,
    revokedBy: actorLogin,
  });
  // Everything the ruling muted, plus the finding it was made ON — the UI
  // promises "bring back everything it suppressed", and to the maintainer the
  // ruling and that first suppression were one action in one dialog. The origin
  // is only restored while it still sits in the state the ruling produced: if
  // it has since moved on (an issue was filed, someone reopened it), that later
  // decision wins.
  const muted = db.filter(
    "securityFindings",
    (f) =>
      f.suppressedByPrecedentId === p.id ||
      (f.id === p.originFindingId && (f.state === "false_positive" || f.state === "accepted"))
  );
  for (const f of muted) {
    db.update("securityFindings", (r) => r.id === f.id, {
      state: f.issueNumber != null ? "issue_created" : "open",
      stateReason: null,
      rulingCode: null,
      suppressedByPrecedentId: null,
      activity: [
        ...(f.activity ?? []),
        {
          at: now,
          kind: "reopened" as const,
          detail: "Restored — the ruling that suppressed this was withdrawn",
          actor: actorLogin,
        },
      ].slice(-50),
    });
  }
  return muted.length;
}
