// The "Adopt tests" button carries only a run-id prefix. Resolving it with a
// global scan would open a PR in whatever repo the first matching run belongs
// to, and an empty prefix would match the first run in the collection. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/github/adopt-scope.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { ADOPT_PREFIX_LEN } from "../verify/report.js";
import { adoptTargetFor } from "./webhooks.js";

let seq = 0;
function seedRepoWithRun() {
  const installationId = 95000 + seq++;
  const install = db.insert("installations", {
    id: uuid(), userId: uuid(), userIds: [], accountId: 1, accountLogin: "acme",
    accountType: "Organization", installationId, repoIds: [],
  } as any);
  const name = `adopt-${uuid().slice(0, 6)}`;
  const repo = db.insert("repositories", {
    id: uuid(), installationId: install.id, owner: "acme", name,
    defaultBranch: "main", private: true,
  } as any);
  const run = db.insert("verifyRuns", {
    id: uuid(), repoId: repo.id, reviewId: uuid(), prNumber: 1, sha: "abc",
    status: "reported", timings: {},
  } as any);
  return { install, repo, run };
}

const fullName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

const event = (o: { installationId: number; fullName: string; identifier: string }) => ({
  action: "requested_action",
  installation: { id: o.installationId },
  repository: { full_name: o.fullName },
  requested_action: { identifier: o.identifier },
});

test("an adopt press resolves only a run in the event's own repository", () => {
  const a = seedRepoWithRun();
  const b = seedRepoWithRun();
  const prefix = a.run.id.slice(0, ADOPT_PREFIX_LEN);

  assert.equal(
    adoptTargetFor(event({ installationId: a.install.installationId, fullName: fullName(a.repo), identifier: `adopt:${prefix}` })),
    a.run.id,
    "the repo that owns the run resolves it"
  );
  assert.equal(
    adoptTargetFor(event({ installationId: b.install.installationId, fullName: fullName(b.repo), identifier: `adopt:${prefix}` })),
    null,
    "another repo cannot adopt into itself with a foreign run's prefix"
  );
});

test("an empty or short prefix matches nothing", () => {
  const a = seedRepoWithRun();
  const from = (identifier: string) =>
    adoptTargetFor(event({ installationId: a.install.installationId, fullName: fullName(a.repo), identifier }));

  assert.equal(from("adopt:"), null, "a bare 'adopt:' does not match the first run in the collection");
  assert.equal(from(`adopt:${a.run.id.slice(0, ADOPT_PREFIX_LEN - 1)}`), null, "a truncated prefix is refused");
  assert.equal(from(`adopt:${a.run.id.slice(0, ADOPT_PREFIX_LEN)}`), a.run.id, "the full-length prefix still works");
});

test("an unknown installation or repository resolves nothing", () => {
  const a = seedRepoWithRun();
  const id = `adopt:${a.run.id.slice(0, ADOPT_PREFIX_LEN)}`;
  assert.equal(adoptTargetFor(event({ installationId: 1, fullName: fullName(a.repo), identifier: id })), null);
  assert.equal(adoptTargetFor(event({ installationId: a.install.installationId, fullName: "acme/nope", identifier: id })), null);
  assert.equal(adoptTargetFor(event({ installationId: a.install.installationId, fullName: "", identifier: id })), null);
});
