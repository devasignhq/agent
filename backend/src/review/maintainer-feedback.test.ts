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
