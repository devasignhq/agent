// The db-touching half of the precedent corpus: who a ruling belongs to, and
// the two ways a ruling stops being trusted. Both are places where getting the
// scope wrong is silent — a ruling that keeps muting after being overturned, or
// one the team can neither see nor withdraw. Uses the in-memory db, no network
// or LLM. Run:
//   node --import tsx/esm --test src/security/precedent-store.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { SecurityFinding, SecurityPrecedent } from "../types.js";
import { contradictPrecedent, corpusForInstallations, revokePrecedent } from "./precedent-store.js";

function precedent(over: Partial<SecurityPrecedent> = {}): SecurityPrecedent {
  const row: SecurityPrecedent = {
    id: uuid(),
    installationId: "inst-1",
    ownerUserId: "u1",
    repoId: "r1",
    scope: "repo",
    code: "control_exists",
    action: "false_positive",
    note: "auth is in requireAuth middleware",
    class: "missing-authz",
    slug: "s",
    path: "api/pay.ts",
    originFindingId: "origin-f",
    anchorSha: "sha-a",
    engineAtCreation: "audit-v1",
    createdAt: 1000,
    createdBy: "octocat",
    status: "active",
    statusReason: null,
    suppressedCount: 0,
    lastAppliedAt: null,
    ...over,
  };
  db.insert("securityPrecedents", row);
  return row;
}

function finding(over: Partial<SecurityFinding> = {}): SecurityFinding {
  const row = {
    id: uuid(),
    fingerprint: uuid(),
    repoId: "r1",
    path: "api/pay.ts",
    class: "missing-authz",
    surface: "api",
    severity: "critical",
    confidence: "confirmed",
    title: "t",
    concern: "c",
    state: "false_positive",
    firstDetectedAt: 1,
    lastSeenAt: 1,
    detectedSha: "sha-a",
    model: "m",
    activity: [],
    ...over,
  } as SecurityFinding;
  db.insert("securityFindings", row);
  return row;
}

const statusOf = (id: string) => db.find("securityPrecedents", (p) => p.id === id)?.status;
const stateOf = (id: string) => db.find("securityFindings", (f) => f.id === id)?.state;

// --- contradiction ---------------------------------------------------------

test("contradictPrecedent: retires the ruling made ON this finding", () => {
  // The origin finding carries NO suppressedByPrecedentId — a human marked it by
  // hand. Keying only on that field would leave the ruling that started all of
  // this muting other findings after its author overturned it.
  const origin = finding();
  const p = precedent({ originFindingId: origin.id });
  contradictPrecedent(origin);
  assert.equal(statusOf(p.id), "needs_reconfirm");
  assert.equal(
    db.find("securityPrecedents", (r) => r.id === p.id)?.statusReason,
    "contradicted"
  );
});

test("contradictPrecedent: retires the ruling that muted this finding", () => {
  const p = precedent();
  const muted = finding({ suppressedByPrecedentId: p.id });
  contradictPrecedent(muted);
  assert.equal(statusOf(p.id), "needs_reconfirm");
});

test("contradictPrecedent: retires every active ruling the finding contradicts", () => {
  // db.update patches the first match only, so a single call must sweep.
  const origin = finding();
  const a = precedent({ originFindingId: origin.id });
  const b = precedent({ originFindingId: origin.id });
  contradictPrecedent(origin);
  assert.equal(statusOf(a.id), "needs_reconfirm");
  assert.equal(statusOf(b.id), "needs_reconfirm");
});

test("contradictPrecedent: leaves an already-revoked ruling alone", () => {
  const origin = finding();
  const p = precedent({ originFindingId: origin.id, status: "revoked" });
  contradictPrecedent(origin);
  assert.equal(statusOf(p.id), "revoked");
});

test("contradictPrecedent: a finding with no ruling behind it is a no-op", () => {
  const p = precedent({ originFindingId: "someone-else" });
  contradictPrecedent(finding());
  assert.equal(statusOf(p.id), "active");
});

// --- revocation ------------------------------------------------------------

test("revokePrecedent: restores both the auto-suppressed findings and the origin", () => {
  // The UI promises "bring back everything it suppressed"; to the maintainer the
  // ruling and that first suppression were one action in one dialog.
  const origin = finding({ state: "false_positive", rulingCode: "control_exists" });
  const p = precedent({ originFindingId: origin.id });
  const muted = finding({ state: "false_positive", suppressedByPrecedentId: p.id });

  const restored = revokePrecedent(p, "octocat", 5000);

  assert.equal(restored, 2);
  assert.equal(statusOf(p.id), "revoked");
  assert.equal(stateOf(origin.id), "open");
  assert.equal(stateOf(muted.id), "open");
  const back = db.find("securityFindings", (f) => f.id === origin.id)!;
  assert.equal(back.stateReason, null);
  assert.equal(back.rulingCode, null);
  assert.equal(back.suppressedByPrecedentId, null);
  assert.ok(back.activity.some((e) => /ruling that suppressed this was withdrawn/.test(e.detail)));
});

test("revokePrecedent: a finding that moved on keeps its later state", () => {
  // Someone filed an issue from the origin after ruling on it. That decision is
  // newer than the ruling and must win over the restore.
  const origin = finding({ state: "issue_created", issueNumber: 7 });
  const p = precedent({ originFindingId: origin.id });
  assert.equal(revokePrecedent(p, "octocat", 5000), 0);
  assert.equal(stateOf(origin.id), "issue_created");
});

test("revokePrecedent: a restored finding with an issue returns to issue_created", () => {
  const p = precedent();
  const muted = finding({ state: "accepted", suppressedByPrecedentId: p.id, issueNumber: 3 });
  revokePrecedent(p, "octocat", 5000);
  assert.equal(stateOf(muted.id), "issue_created");
});

// --- scoping ---------------------------------------------------------------

test("corpusForInstallations: a ruling belongs to the install, not its author", () => {
  // The audit runs under the primary owner while any co-maintainer can triage,
  // so scoping on the author would hide a team member's rulings from the scan
  // that should honour them.
  const mine = precedent({ installationId: "inst-scope-a", ownerUserId: "owner" });
  const teammate = precedent({ installationId: "inst-scope-a", ownerUserId: "member" });
  const other = precedent({ installationId: "inst-scope-b", ownerUserId: "owner" });

  const ids = corpusForInstallations(["inst-scope-a"]).map((p) => p.id);
  assert.ok(ids.includes(mine.id));
  assert.ok(ids.includes(teammate.id), "a co-maintainer's ruling must be in scope");
  assert.ok(!ids.includes(other.id), "another installation's rulings must not leak");
});

test("corpusForInstallations: no installations means no corpus, not everything", () => {
  precedent({ installationId: "inst-scope-c" });
  assert.deepEqual(corpusForInstallations([]), []);
});
