// Maintainer-feedback behaviour, offline. Two guarantees:
//   1. The implementation-guide comment carries a copy-paste "Prompt for your AI
//      agent" block (Part 1).
//   2. A substantive comment flips status to changes_requested but does NOT
//      re-run the review — no review job is enqueued against the same commit
//      (Part 2). The real re-review only fires on the next `synchronize` push.
// Runs fully offline: no ANTHROPIC_API_KEY forces the LLM mock, and seeding no
// install row means the GitHub-posting tail is skipped (`if (!install) return`).
// Run:
//   ANTHROPIC_API_KEY= GEMINI_API_KEY= node --import tsx/esm --test src/review/maintainer-feedback.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { queueSnapshot } from "../queue.js";
import { formatImplementationGuide, runMaintainerFeedbackJob } from "./pipeline.js";

test("formatImplementationGuide embeds a copyable prompt with approach + new criteria", () => {
  const guide = {
    title: "Validate inputs before persistence",
    ask: "The maintainer wants an explicit validation step before we touch the database.",
    approach: "Add a schema, parse the body, and 400 on failure before the db.insert call.",
    code: "const Body = z.object({ name: z.string().min(1) });",
    references: ["https://example.com/spec"],
  };
  const comment = { author: "octocat", sourceUrl: "https://github.com/acme/widgets/pull/1#issuecomment-1" };
  const body = formatImplementationGuide(guide, comment, {
    prTitle: "Add create endpoint",
    repoFullName: "acme/widgets",
    newCriteria: [
      { id: "c3", text: "Inputs are validated before persistence.", met: null, evidence: null },
    ],
  });

  // The copy block GitHub renders with a one-click copy button.
  assert.ok(body.includes("**Prompt for your AI agent:**"), "missing the copyable-prompt header");
  // codeFence must widen the outer wrapper past 3 backticks because the prompt
  // embeds the guide's own ```-fenced snippet — otherwise the inner fence would
  // close the block early and leak the rest of the comment as broken markdown.
  assert.ok(body.includes("````"), "expected a 4+ backtick fence around the prompt");
  // Self-contained: the prompt carries the new acceptance criterion, the ask,
  // and the PR/repo it targets so the developer's agent can act without context.
  assert.ok(body.includes("Inputs are validated before persistence."), "prompt omits the new criterion");
  assert.ok(body.includes(guide.ask), "prompt omits the maintainer's ask");
  assert.ok(body.includes("acme/widgets") && body.includes("Add create endpoint"), "prompt omits PR/repo");
});

test("a substantive maintainer comment requests changes but does NOT re-run the review", async () => {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(), // no install row has this id → GitHub-posting tail is skipped
    owner: "acme",
    name: "widgets",
    private: false,
    reviewsEnabled: true,
    workflow: undefined,
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Add create endpoint",
    headSha: "abc1234",
    baseSha: "def5678",
    status: "passed", // the agent had already approved before the maintainer chimed in
    verdict: "All criteria met",
    criteria: [
      { id: "c1", text: "Create path is implemented.", met: true, evidence: "handler added" },
      { id: "c2", text: "No regressions.", met: true, evidence: "tests pass" },
    ],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);

  const before = queueSnapshot().reviews;

  await runMaintainerFeedbackJob(review.id, {
    body: "Please validate inputs before persisting them.",
    author: "maintainer",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
    sourceEvent: "issue_comment",
  });

  const updated = db.find("prReviews", (r) => r.id === review.id)!;
  // Bar moved → no longer reads as approved.
  assert.equal(updated.status, "changes_requested");
  // The comment's new acceptance criterion was appended (additive contract).
  assert.equal(updated.criteria.length, 3, "expected one new criterion appended");
  assert.ok(
    updated.criteria.some((c) => /validated before persistence/i.test(c.text)),
    "the maintainer's new criterion is missing"
  );
  // The core of the fix: NO review job was enqueued — re-reviewing the same
  // commit is exactly the noise we're eliminating.
  assert.equal(queueSnapshot().reviews, before, "no review should be enqueued without a new commit");
});

// Seed a review with a known criteria verdict mix. No install row means the
// GitHub-posting tail is skipped (`if (!install) return`), so we assert the
// in-db status/criteria the dispute path writes before any posting.
function seedDisputeReview(criteria: any[], status: string = "changes_requested") {
  const repo = db.insert("repositories", {
    id: uuid(),
    installationId: uuid(),
    owner: "acme",
    name: "widgets",
    private: false,
    reviewsEnabled: true,
    workflow: undefined,
  } as any);
  const review = db.insert("prReviews", {
    id: uuid(),
    repoId: repo.id,
    prNumber: 7,
    prTitle: "Surface encryption status in /api/health",
    headSha: "abc1234",
    baseSha: "def5678",
    status,
    verdict: null,
    criteria,
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
  return { repo, review };
}

const C1_MET = { id: "c1", text: "The /api/health response includes an encryption field.", met: true, evidence: "field added" };
const C2_UNMET = {
  id: "c2",
  text: "Encryption status is derived from the existing dbHealth tracking.",
  met: false,
  evidence: "the diff does not show how the value is derived",
};

test("a verified maintainer dispute clears the false positive and flips the verdict to passed", async () => {
  const { review } = seedDisputeReview([{ ...C1_MET }, { ...C2_UNMET }]);
  const before = queueSnapshot().reviews;

  await runMaintainerFeedbackJob(review.id, {
    body: "Those are false positives. c2 is already satisfied — write is dbHealth() in api.ts, two lines above the hunk.",
    author: "maintainer",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
    sourceEvent: "issue_comment",
  });

  const updated = db.find("prReviews", (r) => r.id === review.id)!;
  // A pure dispute adds nothing — it only re-scores existing criteria.
  assert.equal(updated.criteria.length, 2, "a pure dispute should not append a criterion");
  assert.equal(
    updated.criteria.find((c) => c.id === "c2")!.met,
    true,
    "the disputed criterion should be re-verified as met"
  );
  // All criteria now met → the verdict is corrected instead of left stale.
  assert.equal(updated.status, "passed", "all criteria met after the dispute → passed");
  assert.equal(queueSnapshot().reviews, before, "a dispute must not enqueue a fresh review job");
});

test("an unverifiable maintainer dispute leaves the finding in place", async () => {
  const { review } = seedDisputeReview([{ ...C1_MET }, { ...C2_UNMET }]);
  const before = queueSnapshot().reviews;

  await runMaintainerFeedbackJob(review.id, {
    body: "Those are false positives, trust me — I can't point you to the exact code.",
    author: "maintainer",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-10",
    sourceEvent: "issue_comment",
  });

  const updated = db.find("prReviews", (r) => r.id === review.id)!;
  // The guardrail: an unverifiable claim must NOT flip the verdict — evidence,
  // not the maintainer's authority, clears a finding.
  assert.equal(updated.criteria.find((c) => c.id === "c2")!.met, false, "unverifiable claim must not flip to met");
  assert.equal(updated.status, "changes_requested", "finding stands → merge stays blocked");
  assert.equal(queueSnapshot().reviews, before, "a dispute must not enqueue a fresh review job");
});

test("a comment that both disputes and adds clears the false positive and still requests changes", async () => {
  const { review } = seedDisputeReview([{ ...C1_MET }, { ...C2_UNMET }]);

  await runMaintainerFeedbackJob(review.id, {
    body: "c2 is a false positive — it's already handled. Also please add an audit-log entry on write.",
    author: "maintainer",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-11",
    sourceEvent: "issue_comment",
  });

  const updated = db.find("prReviews", (r) => r.id === review.id)!;
  // Additive path still runs: the new criterion is appended...
  assert.equal(updated.criteria.length, 3, "the new criterion should be appended");
  // ...the disputed one is cleared by the re-score...
  assert.equal(updated.criteria.find((c) => c.id === "c2")!.met, true, "the disputed criterion is cleared");
  // ...and the brand-new criterion starts unmet, so the merge stays blocked.
  const added = updated.criteria.find((c) => c.id !== "c1" && c.id !== "c2")!;
  assert.equal(added.met, null, "a brand-new criterion starts unmet");
  assert.equal(updated.status, "changes_requested", "a new unmet criterion keeps changes requested");
});

test("a maintainer can re-open a previously-passed criterion (honored, not verify-gated)", async () => {
  // The PR had been approved (all criteria met) before the maintainer chimed in.
  const { review } = seedDisputeReview(
    [
      { ...C1_MET },
      { id: "c2", text: "The empty-state path is handled.", met: true, evidence: "early return added" },
    ],
    "passed"
  );
  const before = queueSnapshot().reviews;

  await runMaintainerFeedbackJob(review.id, {
    body: "Re-open c1 — it isn't actually satisfied; the response is missing the encryption field on the error branch.",
    author: "maintainer",
    authorAssociation: "OWNER",
    sourceUrl: "https://github.com/acme/widgets/pull/7#issuecomment-12",
    sourceEvent: "issue_comment",
  });

  const updated = db.find("prReviews", (r) => r.id === review.id)!;
  // The named criterion flips met→unmet on the maintainer's word — no re-check.
  assert.equal(updated.criteria.find((c) => c.id === "c1")!.met, false, "the re-opened criterion is now unmet");
  // The evidence records who re-opened it and why.
  assert.match(
    updated.criteria.find((c) => c.id === "c1")!.evidence || "",
    /re-opened by/i,
    "the re-open reason should be recorded as evidence"
  );
  // The other passed criterion is untouched.
  assert.equal(updated.criteria.find((c) => c.id === "c2")!.met, true, "an un-named criterion stays met");
  assert.equal(updated.status, "changes_requested", "a re-opened criterion blocks the merge");
  assert.equal(queueSnapshot().reviews, before, "a re-open must not enqueue a fresh review job");
});
