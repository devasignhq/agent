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
export function contradictPrecedent(finding: Pick<SecurityFinding, "suppressedByPrecedentId">): void {
  const id = finding.suppressedByPrecedentId;
  if (!id) return;
  db.update(
    "securityPrecedents",
    (p) => p.id === id && p.status === "active",
    { status: "needs_reconfirm", statusReason: "contradicted" }
  );
}

// Every ruling in scope for an account. Callers should do this once and reuse
// it: db.filter is a full linear scan with no indexes.
export function corpusForUser(ownerUserId: string | null | undefined): SecurityPrecedent[] {
  if (!ownerUserId) return [];
  return db.filter("securityPrecedents", (p) => p.ownerUserId === ownerUserId);
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
  const muted = db.filter("securityFindings", (f) => f.suppressedByPrecedentId === p.id);
  for (const f of muted) {
    db.update("securityFindings", (r) => r.id === f.id, {
      state: f.issueNumber != null ? "issue_created" : "open",
      stateReason: null,
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
