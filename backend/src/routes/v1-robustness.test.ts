// Offline: the /v1 runner API must survive a malformed but authenticated
// payload. Express 4 lets a rejected handler promise escape as an unhandled
// rejection, which exits the process and drops every in-memory queued job, and
// the runner's DetectedSetup is stored and later read field by field by the
// planner. Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= DATABASE_URL= \
//     node --import tsx/esm --test src/routes/v1-robustness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { setArtifactStorageForTests, type ArtifactStorage } from "../verify/storage.js";
import { artifactsHandler, guard, normalizeDetectedSetup } from "./v1.js";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), (res.headersSent = true), res);
  return res;
}

const settle = () => new Promise((r) => setImmediate(r));

test("guard turns a rejected handler into a 500 instead of an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    guard(async () => {
      throw new TypeError("Cannot read properties of undefined (reading '0')");
    })({ path: "/runs/x/artifacts" } as any, res, () => {});
    await settle();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { ok: false, error: "internal_error" });

    // A synchronous throw is caught too.
    const sync = fakeRes();
    guard(() => {
      throw new Error("boom");
    })({ path: "/runs/resolve" } as any, sync, () => {});
    await settle();
    assert.equal(sync.statusCode, 500);

    // A handler that already answered is not double-written.
    const answered = fakeRes();
    guard(async (_req, r) => {
      r.status(200).json({ ok: true });
      throw new Error("late");
    })({ path: "/runs/x" } as any, answered, () => {});
    await settle();
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(answered.body, { ok: true });

    assert.deepEqual(rejections, [], "nothing escaped to the process");
  } finally {
    console.error = originalError;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a partial or hostile DetectedSetup is filled in, not stored as-is", () => {
  // The shape the planner dereferences: every array present, enums validated.
  const partial = normalizeDetectedSetup({ frameworks: [] });
  assert.deepEqual(partial, {
    languages: [],
    packageManager: null,
    monorepo: null,
    frameworks: [],
    testCommands: [],
    envExampleVars: [],
    existingWorkflows: [],
    services: [],
  });
  for (const key of ["languages", "testCommands", "envExampleVars", "existingWorkflows", "services"] as const) {
    assert.ok(Array.isArray(partial![key]), `${key} must be an array the planner can join()`);
  }

  const hostile = normalizeDetectedSetup({
    languages: ["ts", 42, null],
    packageManager: "curl | sh",
    monorepo: { tool: "evil", packages: ["a", 1] },
    frameworks: [{ name: "vitest", version: "1.0" }, { name: "not-a-framework" }, null, "x"],
    testCommands: "rm -rf /",
    services: ["postgres", "mongodb"],
    nodeVersion: 22,
  })!;
  assert.deepEqual(hostile.languages, ["ts"]);
  assert.equal(hostile.packageManager, null);
  assert.deepEqual(hostile.monorepo, { tool: null, packages: ["a"] });
  assert.deepEqual(hostile.frameworks.map((f) => f.name), ["vitest"]);
  assert.deepEqual(hostile.testCommands, [], "a non-array is not trusted");
  assert.deepEqual(hostile.services, ["postgres"]);
  assert.equal(hostile.nodeVersion, undefined, "a non-string version is dropped");

  // No frameworks array at all is not a setup report.
  assert.equal(normalizeDetectedSetup({ languages: ["ts"] }), null);
  assert.equal(normalizeDetectedSetup(null), null);
  assert.equal(normalizeDetectedSetup("nope"), null);
});

// The concrete crash the guard exists for: two files sharing a clientRef used to
// hit a non-null assertion on a reverse lookup and take the process down after
// the first row had already been inserted.
test("two artifact files sharing a clientRef are rejected, not fatal", async () => {
  const repoId = uuid(), runId = uuid();
  const fake: ArtifactStorage = {
    signPut: async (key) => ({ url: `https://bucket.test/${key}`, headers: {} }),
    signGet: async (key) => `https://bucket.test/${key}`,
    head: async () => null,
    remove: async () => {},
  };
  db.insert("verifyRuns", { id: runId, schemaVersion: 1, reviewId: uuid(), repoId, installationId: uuid(), prNumber: 3, sha: "abc", attempt: 1, status: "running", criteriaRevision: 1, planTier: "pro", verdicts: [], timings: { forkedAt: Date.now() }, tokenUsage: {}, artifactBytes: 0, triggeredBy: { kind: "pr_event" }, createdAt: Date.now(), updatedAt: Date.now() } as any);
  setArtifactStorageForTests(fake);
  try {
    const res = fakeRes();
    const file = (clientRef: string, path: string) => ({ clientRef, kind: "log", path, bytes: 10, contentType: "text/plain" });
    await artifactsHandler(
      {
        runner: { repo: { id: repoId }, plan: "pro" },
        params: { runId },
        body: { files: [file("a", "one.log"), file("a", "two.log"), file("b", "three.log")] },
      } as any,
      res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.uploads.map((u: any) => u.clientRef), ["a", "b"], "each upload keeps its own ref");
    assert.deepEqual(res.body.rejected, [{ clientRef: "a", reason: "invalid" }]);
    assert.equal(db.filter("verifyArtifacts", (a) => a.runId === runId).length, 2, "one row per accepted file");
  } finally {
    setArtifactStorageForTests(undefined);
    db.remove("verifyArtifacts", (a) => a.runId === runId);
    db.remove("verifyRuns", (r) => r.id === runId);
  }
});
