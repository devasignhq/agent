// Offline: runner auth on /v1 — token failures map to 401, an unknown or
// disallowed repo to 403, and a good token resolves the repo + plan tier.
//   DATABASE_URL= node --import tsx/esm --test src/routes/v1-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { makeRunnerAuth, repoForClaims } from "./v1.js";
import type { OidcResult } from "../verify/oidc.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: "x", aud: "devasign", sub: "s", exp: 0, iat: 0,
  repository: "acme/widgets", repository_id: "555", sha: "abc", ref: "refs/pull/1/merge",
  event_name: "pull_request", run_id: "1", ...over,
});

test("token failures → 401 with a stable error code; no repo lookup", async () => {
  for (const [reason, code] of [["expired", "token_expired"], ["bad_signature", "token_bad_signature"], ["wrong_audience", "token_wrong_audience"]] as const) {
    const auth = makeRunnerAuth({ verify: async () => ({ ok: false, reason }) as OidcResult });
    const res = fakeRes();
    let nexted = false;
    await auth({ headers: { authorization: "Bearer t" } } as any, res, () => { nexted = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, code);
    assert.equal(nexted, false);
  }
  const auth = makeRunnerAuth({ verify: async () => { throw new Error("must not be called"); } });
  const res = fakeRes();
  await auth({ headers: {} } as any, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "missing_bearer_token");
});

test("a valid token for a repo we don't have → 403 unknown_repository", async () => {
  const auth = makeRunnerAuth({ verify: async () => ({ ok: true, claims: claims({ repository: "nobody/nothing", repository_id: "1" }) }) as OidcResult });
  const res = fakeRes();
  await auth({ headers: { authorization: "Bearer t" } } as any, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "unknown_repository");
});

test("a valid token for a known repo resolves by numeric id, learns it by name, and sets the plan", async () => {
  const installId = uuid();
  db.insert("installations", { id: installId, userId: uuid(), accountId: 1, accountLogin: "acme", installationId: 77, repoIds: [] } as any);
  const repo = db.insert("repositories", {
    id: uuid(), installationId: installId, owner: "Acme", name: "Widgets", defaultBranch: "main",
    private: false, defaultModel: "m", modelOverrides: {}, reviewsEnabled: true,
  } as any);
  try {
    // No githubRepoId stored yet: matched by owner/name (case-insensitive), then learned.
    const byName = repoForClaims({ repository: "acme/widgets", repository_id: "555" });
    assert.equal(byName?.id, repo.id);
    assert.equal(db.find("repositories", (r) => r.id === repo.id)?.githubRepoId, 555);
    // Renamed on GitHub: still found by id.
    assert.equal(repoForClaims({ repository: "acme/renamed", repository_id: "555" })?.id, repo.id);

    const auth = makeRunnerAuth({ verify: async () => ({ ok: true, claims: claims() }) as OidcResult });
    const req: any = { headers: { authorization: "Bearer t" } };
    const res = fakeRes();
    let nexted = false;
    await auth(req, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.runner.repo.id, repo.id);
    assert.equal(req.runner.install.id, installId);
    assert.equal(req.runner.plan, "free");

    const push = makeRunnerAuth({ verify: async () => ({ ok: true, claims: claims({ event_name: "push" }) }) as OidcResult });
    const res2 = fakeRes();
    await push({ headers: { authorization: "Bearer t" } } as any, res2, () => {});
    assert.equal(res2.statusCode, 403);
    assert.equal(res2.body.error, "event_not_allowed");
  } finally {
    db.remove("repositories", (r) => r.id === repo.id);
    db.remove("installations", (i) => i.id === installId);
  }
});
