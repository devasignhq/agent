// Offline tests for the Linear integration. Run in mock mode (no network):
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/linear/linear.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  extractLinkedLinearIssues,
  linearSourcesFromIssue,
  synthesizeCriteriaCore,
} from "../review/pipeline.js";
import { handleLinearWebhook } from "./webhooks.js";
import type { LinearIssueContext } from "./client.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { queueSnapshot } from "../queue.js";

// Public OAuth apps verify every webhook against ONE app-level secret.
const WH_SECRET = "lin_wh_test_secret";
config.linear.webhookSigningSecret = WH_SECRET;

function issueFixture(overrides: Partial<LinearIssueContext> = {}): LinearIssueContext {
  return {
    id: "iss_1",
    identifier: "ENG-9",
    title: "Add retry on 5xx",
    url: "https://linear.app/acme/issue/ENG-9",
    description: "Uploads should retry on 5xx responses.",
    stateType: "started",
    labels: ["bug"],
    parent: null,
    project: { id: "proj_1", name: "Reliability" },
    comments: [{ body: "Cap retries at 3", user: "Dana" }],
    children: [
      { id: "c1", identifier: "ENG-10", title: "Backoff", description: "exp backoff", stateType: "started" },
    ],
    attachments: [{ url: "https://figma.com/file/x", title: "Mock", subtitle: "Figma design" }],
    ...overrides,
  };
}

test("extractLinkedLinearIssues: explicit body refs are uppercase-only", () => {
  assert.deepEqual(extractLinkedLinearIssues("Fixes ENG-123 and closes ENG-7"), ["ENG-123", "ENG-7"]);
  assert.deepEqual(extractLinkedLinearIssues("decode utf-8 with sha-256"), []);
  assert.deepEqual(extractLinkedLinearIssues("ENG-1 ENG-1 ENG-1"), ["ENG-1"]);
});

test("extractLinkedLinearIssues: branch names (Linear slug convention)", () => {
  assert.deepEqual(extractLinkedLinearIssues("", "bishop/eng-42-fix-thing"), ["ENG-42"]);
  assert.deepEqual(extractLinkedLinearIssues("Fixes ENG-42", "user/eng-42-x"), ["ENG-42"]);
});

test("linearSourcesFromIssue: issue, sub-issue, comment, attachment, project-update", () => {
  db.insert("linearProjectUpdates", {
    id: "pu_1", projectId: "proj_1", projectName: "Reliability",
    body: "On track; retries shipping this week.", health: "onTrack",
    userId: "u", createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  const kinds = new Set(linearSourcesFromIssue(issueFixture()).map((s) => s.kind));
  for (const k of [
    "linear_issue_primary", "linear_subissue", "linear_comment",
    "linear_attachment", "linear_project_update",
  ]) {
    assert.ok(kinds.has(k), `missing source kind ${k}`);
  }
  db.remove("linearProjectUpdates", (u) => u.id === "pu_1");
});

test("synthesizeCriteriaCore (mock LLM) yields criteria from a Linear ticket", async () => {
  const { criteria } = await synthesizeCriteriaCore({
    title: "Linear ENG-9: Add retry on 5xx",
    sources: linearSourcesFromIssue(issueFixture()),
    hasAuthoritativeSpec: true,
  });
  assert.ok(criteria.length > 0);
});

// ── Webhook handler ──────────────────────────────────────────────────────────
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
function fakeReq(raw: Buffer, sig: string | undefined) {
  return { body: raw, header: (h: string) => (h === "Linear-Signature" ? sig : undefined) } as any;
}
function deliver(payloadObj: any, secret = WH_SECRET) {
  const raw = Buffer.from(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const res = fakeRes();
  handleLinearWebhook(fakeReq(raw, sig), res);
  return res;
}

test("handleLinearWebhook: app-level signature; Issue enqueues; bad sig 401; unknown org acknowledged", () => {
  const orgId = "org_" + crypto.randomUUID();
  db.insert("integrations", {
    id: "int_test", userId: "u_test", type: "linear",
    tokens: { accessToken: "tok" }, workspaceMeta: { organizationId: orgId },
    createdAt: Date.now(),
  } as any);

  const before = queueSnapshot().reviews;
  const issueEvent = { type: "Issue", action: "create", organizationId: orgId, webhookTimestamp: Date.now(), data: { id: "issue_1" } };

  assert.equal(deliver(issueEvent).statusCode, 200);
  assert.equal(queueSnapshot().reviews, before + 1, "Issue create enqueues ingest");

  // wrong secret → 401, no enqueue
  const bad = deliver(issueEvent, "wrong_secret");
  assert.equal(bad.statusCode, 401);
  assert.equal(queueSnapshot().reviews, before + 1);

  // valid app signature but a workspace we don't track → acknowledged, no action
  const unknown = deliver({ type: "Issue", action: "create", organizationId: "org_unknown", webhookTimestamp: Date.now(), data: { id: "x" } });
  assert.equal(unknown.statusCode, 200);
  assert.equal(queueSnapshot().reviews, before + 1);

  db.remove("integrations", (i) => i.id === "int_test");
});

test("handleLinearWebhook: IssueAttachment re-ingests; ProjectUpdate stores (no ingest)", () => {
  const orgId = "org_" + crypto.randomUUID();
  db.insert("integrations", {
    id: "int_pa", userId: "u_pa", type: "linear",
    tokens: { accessToken: "tok" }, workspaceMeta: { organizationId: orgId },
    createdAt: Date.now(),
  } as any);

  const before = queueSnapshot().reviews;
  assert.equal(deliver({ type: "IssueAttachment", action: "create", organizationId: orgId, webhookTimestamp: Date.now(), data: { issueId: "issue_5" } }).statusCode, 200);
  assert.equal(queueSnapshot().reviews, before + 1, "attachment re-ingests parent issue");

  assert.equal(deliver({ type: "ProjectUpdate", action: "create", organizationId: orgId, webhookTimestamp: Date.now(), data: { id: "pu_x", body: "Shipping", health: "onTrack", project: { id: "proj_x", name: "P" } } }).statusCode, 200);
  assert.ok(db.find("linearProjectUpdates", (u) => u.id === "pu_x"), "project update stored");
  assert.equal(queueSnapshot().reviews, before + 1, "project update does not enqueue ingest");

  db.remove("integrations", (i) => i.id === "int_pa");
  db.remove("linearProjectUpdates", (u) => u.id === "pu_x");
});

test("handleLinearWebhook: stale timestamp rejected", () => {
  const orgId = "org_stale";
  db.insert("integrations", {
    id: "int_stale", userId: "u", type: "linear",
    tokens: { accessToken: "tok" }, workspaceMeta: { organizationId: orgId },
    createdAt: Date.now(),
  } as any);
  assert.equal(deliver({ type: "Issue", action: "create", organizationId: orgId, webhookTimestamp: Date.now() - 10 * 60 * 1000, data: { id: "y" } }).statusCode, 401);
  db.remove("integrations", (i) => i.id === "int_stale");
});
