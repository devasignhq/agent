// A repo flipping public<->private changes what a cross-repo review may quote
// into a world-readable PR comment. Drives the REAL handleWebhook against the
// in-memory db, HMAC-signed like the other webhook tests. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/github/repository-visibility.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { handleWebhook } from "./webhooks.js";
import type { RepoTopology } from "../types.js";

config.github.appId = "";
config.github.privateKey = "";

function deliver(event: any) {
  const raw = Buffer.from(JSON.stringify(event));
  const headers: Record<string, string> = {
    "X-GitHub-Event": "repository",
    "X-GitHub-Delivery": uuid(),
  };
  if (config.github.webhookSecret) {
    headers["X-Hub-Signature-256"] =
      "sha256=" + crypto.createHmac("sha256", config.github.webhookSecret).update(raw).digest("hex");
  }
  const req = { header: (n: string) => headers[n], body: raw } as any;
  const res = {
    status() {
      return this;
    },
    send() {
      return this;
    },
    json() {
      return this;
    },
  } as any;
  handleWebhook(req, res);
}

let seq = 0;
function seed() {
  const installationId = 90000 + seq++;
  const install = db.insert("installations", {
    id: uuid(),
    userId: uuid(),
    userIds: [],
    accountId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    installationId,
    repoIds: [],
  } as any);
  const name = `vis-${uuid().slice(0, 6)}`;
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);
  return { install, repo, installationId, fullName: `acme/${name}` };
}

function event(action: string, fullName: string, installationId: number) {
  return { action, repository: { full_name: fullName }, installation: { id: installationId } };
}

test("privatized flips the stored flag so a public review stops quoting it", () => {
  const { repo, installationId, fullName } = seed();
  deliver(event("privatized", fullName, installationId));
  assert.equal(db.find("repositories", (r) => r.id === repo.id)!.private, true);
});

test("publicized flips it back", () => {
  const { repo, installationId, fullName } = seed();
  db.update("repositories", (r) => r.id === repo.id, { private: true });
  deliver(event("publicized", fullName, installationId));
  assert.equal(db.find("repositories", (r) => r.id === repo.id)!.private, false);
});

test("the topology's cached copy is updated too, so it cannot outvote the row", () => {
  const { install, installationId, fullName } = seed();
  const topo: RepoTopology = {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    isOrg: true,
    generatedAt: 1,
    buildMs: 1,
    repoCount: 1,
    repoIdsAtBuild: 1,
    totalCount: 1,
    truncated: false,
    repos: [
      {
        fullName,
        kind: "unknown",
        declaredDeps: [],
        archived: false,
        private: false,
        pushedAt: 0,
        defaultBranch: "main",
      },
    ],
    families: [],
    edges: [],
    codeSearch: { status: "ok", probedAt: 1 },
    error: null,
  };
  db.insert("repoTopologies", topo);
  deliver(event("privatized", fullName, installationId));
  const after = db.find("repoTopologies", (t) => t.id === topo.id)!;
  assert.equal(after.repos[0].private, true);
});

test("an unrelated action changes nothing", () => {
  const { repo, installationId, fullName } = seed();
  deliver(event("edited", fullName, installationId));
  assert.equal(db.find("repositories", (r) => r.id === repo.id)!.private, false);
});

test("an event for an unknown installation writes nothing at all", () => {
  // Resolve first, then mutate: an event we cannot attribute identifies no row
  // we have any business touching.
  const { repo, fullName } = seed();
  deliver(event("privatized", fullName, 424242));
  assert.equal(db.find("repositories", (r) => r.id === repo.id)!.private, false);
});

test("a same-named repo under another installation is left alone", () => {
  // The twin is inserted FIRST on purpose: db.update patches the first match, so
  // an unscoped predicate would flip the twin and miss the target entirely.
  const name = `twin-${uuid().slice(0, 6)}`;
  const other = db.insert("installations", {
    id: uuid(),
    userId: uuid(),
    userIds: [],
    accountId: 2,
    accountLogin: "acme",
    accountType: "Organization",
    installationId: 95999,
    repoIds: [],
  } as any);
  const twin = db.insert("repositories", {
    id: uuid(),
    installationId: other.id,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);

  const installationId = 96500;
  const mine = db.insert("installations", {
    id: uuid(),
    userId: uuid(),
    userIds: [],
    accountId: 3,
    accountLogin: "acme",
    accountType: "Organization",
    installationId,
    repoIds: [],
  } as any);
  const target = db.insert("repositories", {
    id: uuid(),
    installationId: mine.id,
    owner: "acme",
    name,
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "none",
  } as any);

  deliver(event("privatized", `acme/${name}`, installationId));
  assert.equal(db.find("repositories", (r) => r.id === target.id)!.private, true);
  assert.equal(
    db.find("repositories", (r) => r.id === twin.id)!.private,
    false,
    "another installation's row must not be touched"
  );
});
