// Offline end-to-end for the thing the defect stage exists to do: a PR whose
// acceptance criteria are satisfied, but whose code contains a real bug, must
// NOT pass. Runs the REAL runReviewJob with the LLM mock (empty
// ANTHROPIC_API_KEY) and DEFECT_SAMPLE=1 (set in this file), which makes the mocked defect pass
// return one blocker-severity finding; global.fetch is stubbed so every GitHub
// call is answered locally and the pipeline sees a real diff.
//
// Before this stage existed the same seed produced status "passed" — the
// criteria pass was the only thing that could fail a PR.
//
// Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= STATSIG_SECRET_KEY= \
//     node --import tsx/esm --test src/review/defect-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { config } from "../config.js";
import { runReviewJob } from "./pipeline.js";

// appJWT() refuses to sign unless the App is configured; the signed JWT is never
// sent (fetch is stubbed), it only has to sign. Mirrors progress-comment-flow.
config.github.appId = "123456";
config.github.privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// The LLM mock only emits the sample defect under this flag. Set it here rather
// than requiring it on the command line: node --test runs each file in its own
// process, so this can't leak into the other pipeline suites (where a blocker
// defect on every run would fail them).
process.env.DEFECT_SAMPLE = "1";

// Deliberately free of TODO/stub markers so the deferral scan makes no LLM call.
const DIFF = [
  "diff --git a/src/handler.ts b/src/handler.ts",
  "index 1111111..2222222 100644",
  "--- a/src/handler.ts",
  "+++ b/src/handler.ts",
  "@@ -1,4 +1,7 @@",
  " export async function listHandler(req, res) {",
  "+  try {",
  "+    await store.write(req.body);",
  "+  } catch (err) {",
  "+    console.error(err);",
  "+  }",
  "   res.json([]);",
  " }",
].join("\n");

function ghResponse(body: any) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

function installFetchStub() {
  const original = globalThis.fetch;
  let nextCommentId = 5000;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    const accept = String(headers.Accept || headers.accept || "");
    if (u.includes("/access_tokens") && method === "POST")
      return ghResponse({ token: "tok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (/\/issues\/\d+\/comments$/.test(u) && method === "POST")
      return ghResponse({ id: nextCommentId++ });
    if (/\/issues\/comments\/\d+$/.test(u) && method === "PATCH") return ghResponse({});
    if (/\/pulls\/\d+\/commits/.test(u) && method === "GET")
      return ghResponse([{ sha: "abc1234", commit: { message: "Add list handler" } }]);
    if (/\/pulls\/\d+\/reviews$/.test(u) && method === "POST") return ghResponse({ id: 99 });
    if (/\/pulls\/\d+$/.test(u) && method === "GET") {
      if (accept.includes("diff")) return ghResponse(DIFF);
      return ghResponse({
        title: "Add list handler",
        body: "",
        head: { sha: "abc1234", ref: "feature" },
        base: { sha: "def5678" },
        additions: 5,
        deletions: 0,
        changed_files: 1,
        commits: 1,
      });
    }
    if (/\/git\/trees\//.test(u) && method === "GET") return ghResponse({ tree: [] });
    if (/\/check-runs$/.test(u) && method === "POST") return ghResponse({ id: 7 });
    return ghResponse({});
  }) as any;
  return { restore: () => { globalThis.fetch = original; } };
}

// A PUBLIC repo with indexState "none" — so the holistic pass is skipped and
// the only thing that can surface a bug is the defect stage. That is precisely
// the gap this stage closes.
//
// The criteria seed matters and is easy to get wrong: pass none and the pipeline
// SYNTHESIZES four, of which the mock marks two unmet, so the run fails on the
// criteria alone and any "the defect gated it" assertion passes for the wrong
// reason. Seeding a task WITH an endGoal plus exactly one criterion takes the
// reuse branch, and the review mock marks the single criterion met — so the
// criteria pass is clean and the verdict is decided by the defect stage alone.
function seedReview(criteria: any[]): string {
  const install = db.insert("installations", {
    id: uuid(),
    installationId: 12345,
    userId: "", // unlinked → no plan lookups
  } as any);
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: install.id,
    owner: "acme",
    name: "widgets",
    private: false,
    reviewsEnabled: true,
    defaultModel: "claude-haiku-4-5-20251001",
    modelOverrides: {},
    indexState: "none",
  } as any);
  const task = db.insert("tasks", {
    id: uuid(),
    source: "github",
    externalId: `pr:${repo.id}:1`,
    title: "Add list handler",
    endGoal: "Persist the submitted item and return the list.",
    attachments: [],
    createdAt: Date.now(),
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 1,
    prTitle: "Add list handler",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "queued",
    verdict: null,
    criteria,
    taskId: task.id,
    additions: null,
    deletions: null,
    changedFiles: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
  return review.id;
}

// One criterion the review mock will mark met — see the seedReview note.
const MET_CRITERION = [
  { id: "1", text: "The submitted item is persisted before the response.", met: null, evidence: null },
];

async function run(criteria: any[] = MET_CRITERION) {
  const id = seedReview(criteria);
  const { restore } = installFetchStub();
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }
  return {
    id,
    review: db.find("prReviews", (r) => r.id === id)!,
    defects: db.filter(
      "reviewLogs",
      (l) => l.reviewId === id && l.kind === "finding" && (l.meta as any)?.category === "defect"
    ),
  };
}

test("the defect pass emits a finding carrying its failure scenario", async () => {
  const { defects } = await run();
  assert.equal(defects.length, 1, "expected one defect finding from the mocked pass");
  const meta = defects[0].meta as any;
  assert.equal(meta.severity, "blocker");
  assert.equal(meta.defectClass, "unhandled-error");
  assert.match(
    String(meta.failureScenario),
    /returns 200/,
    "the failure scenario must reach the log row — it's what the UI renders and what justifies the gate"
  );
  assert.ok(meta.fixPrompt, "every defect carries a copyable fix prompt");
});

test("a blocking defect flips the verdict to changes_requested", async () => {
  const { review } = await run();
  assert.equal(
    review.status,
    "changes_requested",
    "a blocker-severity defect must gate the merge on its own"
  );
});

test("bug detection runs with no repo index built — the gap it closes", async () => {
  // indexState "none" means the holistic pass is skipped entirely, so this
  // finding could only have come from the defect stage.
  const { defects } = await run();
  assert.equal(defects.length, 1, "bug detection must not depend on the repo index");
});

test("the defect section reaches the posted PR comment", async () => {
  const id = seedReview(MET_CRITERION);
  const bodies: string[] = [];
  const original = globalThis.fetch;
  const stub = installFetchStub();
  const wrapped = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (typeof init.body === "string" && /\/issues\/comments\/\d+$/.test(String(url))) {
      try {
        bodies.push(JSON.parse(init.body).body);
      } catch {
        /* not JSON — ignore */
      }
    }
    return wrapped(url, init);
  }) as any;
  try {
    await runReviewJob(id);
  } finally {
    globalThis.fetch = original;
    stub.restore();
  }
  const verdictBody = bodies.find((b) => /Bugs and correctness issues/.test(b));
  assert.ok(verdictBody, "the verdict comment should carry the defect section");
  assert.match(verdictBody!, /1 of these blocks the merge/);
  assert.match(verdictBody!, /\*\*How it fails:\*\*/);
});

test("control: with the stage off, the same PR passes — proving the gate is the defect pass", async () => {
  const id = seedReview(MET_CRITERION);
  const repoId = db.find("prReviews", (r) => r.id === id)!.repoId;
  db.update("repositories", (r) => r.id === repoId, {
    workflow: { version: 1, stages: { defects: false } },
  } as any);
  const { restore } = installFetchStub();
  try {
    await runReviewJob(id);
  } finally {
    restore();
  }
  assert.equal(
    db.find("prReviews", (r) => r.id === id)!.status,
    "passed",
    "this is the pre-change behavior: no criteria to fail and no other stage looking for bugs"
  );
});
