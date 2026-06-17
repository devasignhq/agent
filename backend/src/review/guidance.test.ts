// Offline tests for guidance ingestion + buildGuidanceSection. Mock LLM (no
// API keys), in-memory db, no network. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/guidance.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import type { RepoGuidanceItem } from "../types.js";
import {
  __setDocTransportForTests,
  buildGuidanceSection,
  pinnedLookup,
  resolvePublicUrl,
  runGuidanceIngestJob,
} from "./guidance.js";

function seedRepo(guidance: RepoGuidanceItem[]): string {
  const id = uuid();
  db.insert("repositories", {
    id,
    installationId: uuid(),
    owner: "acme",
    name: "widget",
    defaultBranch: "main",
    private: false,
    defaultModel: "claude-haiku-4-5",
    modelOverrides: {},
    reviewsEnabled: true,
    guidance,
  });
  return id;
}

function item(kind: RepoGuidanceItem["kind"], url?: string): RepoGuidanceItem {
  return { id: uuid(), kind, title: url || `${kind}.pdf`, url, status: "indexing", addedAt: Date.now() };
}

const repoOf = (id: string) => db.find("repositories", (r) => r.id === id)!;
const itemOf = (id: string, itemId: string) =>
  (repoOf(id).guidance ?? []).find((g) => g.id === itemId)!;

test("video ingest → ready with a summary (mock Gemini)", async () => {
  const v = item("video", "https://youtube.com/watch?v=abc");
  const repoId = seedRepo([v]);
  await runGuidanceIngestJob({ repoId, itemId: v.id });
  const after = itemOf(repoId, v.id);
  assert.equal(after.status, "ready");
  assert.ok(after.summary && after.summary.trim().length > 0);
  assert.ok(typeof after.indexedAt === "number");
});

test("pdf ingest → ready with a summary (mock Claude)", async () => {
  const p = item("pdf");
  const repoId = seedRepo([p]);
  await runGuidanceIngestJob({ repoId, itemId: p.id, pdfBase64: "JVBERi0xLjQK", pdfMediaType: "application/pdf" });
  const after = itemOf(repoId, p.id);
  assert.equal(after.status, "ready");
  assert.ok(after.summary && after.summary.trim().length > 0);
});

test("doc pointing at a private host → errored (SSRF guard)", async () => {
  const d = item("doc", "http://127.0.0.1/internal");
  const repoId = seedRepo([d]);
  await runGuidanceIngestJob({ repoId, itemId: d.id });
  const after = itemOf(repoId, d.id);
  assert.equal(after.status, "errored");
  assert.match(after.error || "", /private/i);
});

test("doc with an invalid URL → errored", async () => {
  const d = item("doc", "not-a-real-url");
  const repoId = seedRepo([d]);
  await runGuidanceIngestJob({ repoId, itemId: d.id });
  assert.equal(itemOf(repoId, d.id).status, "errored");
});

test("buildGuidanceSection includes only ready items, with binding framing", async () => {
  const v = item("video", "https://youtube.com/watch?v=ready");
  const bad = item("doc", "http://10.0.0.1/x");
  const repoId = seedRepo([v, bad]);
  await runGuidanceIngestJob({ repoId, itemId: v.id });
  await runGuidanceIngestJob({ repoId, itemId: bad.id });

  const section = buildGuidanceSection(repoOf(repoId));
  assert.match(section, /binding/i);
  assert.ok(section.includes(v.title)); // ready item present
  assert.ok(!section.includes(bad.title)); // errored item excluded
});

test("buildGuidanceSection is empty when nothing is ready", () => {
  const repoId = seedRepo([{ ...item("video", "https://youtube.com/x"), status: "indexing" }]);
  assert.equal(buildGuidanceSection(repoOf(repoId)), "");
});

// resolvePublicUrl is the SSRF gate run on the initial URL AND every redirect
// hop. Prove it rejects the addresses an SSRF would target, and accepts public.
test("resolvePublicUrl rejects private, loopback, metadata, schemes; allows public", async () => {
  const blocked = [
    "http://127.0.0.1/",            // loopback
    "http://169.254.169.254/latest", // cloud metadata
    "http://10.1.2.3/",             // private
    "http://192.168.0.1/",          // private
    "http://[::1]/",                // ipv6 loopback
    "http://localhost/",            // internal name
    "file:///etc/passwd",           // non-http scheme
    "not-a-url",                    // unparseable
  ];
  for (const u of blocked) {
    await assert.rejects(resolvePublicUrl(u), new RegExp("."), `expected ${u} to be rejected`);
  }
  // A public IP literal resolves without DNS and is pinned to itself.
  const ok = await resolvePublicUrl("http://93.184.216.34/");
  assert.deepEqual(ok.addrs, [{ address: "93.184.216.34", family: 4 }]);
});

// The pin: whatever hostname the connector asks to resolve, it gets back ONLY
// the pre-validated address — so the socket can't be rebound to another IP.
test("pinnedLookup returns the validated address regardless of hostname", () => {
  const addrs = [{ address: "93.184.216.34", family: 4 }];
  const lookupFn = pinnedLookup(addrs);
  // all:true → array form
  lookupFn("attacker-controlled.example", { all: true }, (err: any, res: any) => {
    assert.equal(err, null);
    assert.deepEqual(res, addrs);
  });
  // single form
  lookupFn("attacker-controlled.example", {}, (err: any, addr: any, family: any) => {
    assert.equal(err, null);
    assert.equal(addr, "93.184.216.34");
    assert.equal(family, 4);
  });
});

// A public host that 3xx-redirects to a private/metadata address must NOT be
// followed: the loop re-validates the Location before requesting it. The start
// is a public IP literal (no DNS); the transport is stubbed to redirect.
test("doc redirecting to a metadata/private address is blocked", async () => {
  __setDocTransportForTests(async () => ({
    status: 302,
    location: "http://169.254.169.254/latest/meta-data/",
    contentType: "",
    body: Buffer.alloc(0),
  }));
  try {
    const d = item("doc", "http://93.184.216.34/"); // public IP literal
    const repoId = seedRepo([d]);
    await runGuidanceIngestJob({ repoId, itemId: d.id });
    const after = itemOf(repoId, d.id);
    assert.equal(after.status, "errored");
    assert.match(after.error || "", /private/i);
  } finally {
    __setDocTransportForTests(null);
  }
});

test("doc returning 200 indexes to ready", async () => {
  __setDocTransportForTests(async () => ({
    status: 200,
    location: null,
    contentType: "text/html",
    body: Buffer.from("<html><body><h1>Style</h1><p>- Use camelCase for exports.</p></body></html>"),
  }));
  try {
    const d = item("doc", "http://93.184.216.34/");
    const repoId = seedRepo([d]);
    await runGuidanceIngestJob({ repoId, itemId: d.id });
    assert.equal(itemOf(repoId, d.id).status, "ready");
  } finally {
    __setDocTransportForTests(null);
  }
});
