// Stage-machine + validation tests for the contributor app's pure model.
// Run: node --test 'src/**/*.test.ts' (from contributor/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceRate,
  bountyStage,
  deleteConfirmOk,
  extensionState,
  isValidExtensionDays,
  groupBounties,
  isStellarAddr,
  isValidMemo,
  parsePrUrl,
  mergedCriteria,
  reviewHeadline,
  allCriteriaMet,
  timeLeft,
  timelineFromEvents,
  cmoney,
  shortAddr,
} from "./model.ts";
import type { BountyEvent, BountyReview, ContributorBounty, ReviewProjection } from "./api.ts";

// Minimal ContributorBounty factory — only the fields the model reads.
function b(patch: Partial<ContributorBounty>): ContributorBounty {
  return {
    id: "x", code: "BNTY-1", source: "github", repo: "acme/pay", issueNumber: 1,
    issueUrl: "", title: "t", description: "", acceptance: ["a", "b"],
    amountUsdc: 500, deliveryDays: 7, status: "OPEN", createdAt: 0, updatedAt: 0,
    applicantCount: 1, myApplication: null, isAssignee: false,
    assigneeGithubLogin: null, assigneeAddress: null, assigneeMemo: null,
    acceptedAt: null, deadlineAt: null, prNumber: null, submittedAt: null,
    supportingLinks: [], payoutRequestedAt: null, rejection: null, extension: null,
    cancelReason: null, escrowTxHash: null, payoutTxHash: null,
    escrowContract: null, sponsorLogin: null, events: [],
    fundedAt: null, awardedAt: null, paidAt: null, refundedAt: null, review: null,
    ...patch,
  };
}

const proj = (met: number, total: number): ReviewProjection => ({
  prTitle: "feat: things",
  summary: "Looks solid.",
  counts: { met, unmet: total - met, pending: 0, total },
});
const myApp = (status: "pending" | "approved" | "accepted" | "rejected") =>
  ({ githubId: 1, githubLogin: "me", appliedAt: 0, status });

test("stage derivation covers every design state", () => {
  // Application lifecycle (not yet assignee). A pending application — or a
  // legacy "approved" one — reads as "applied" while the bounty is open.
  assert.equal(bountyStage(b({ myApplication: myApp("pending") })), "applied");
  assert.equal(bountyStage(b({ myApplication: myApp("approved") })), "applied");
  assert.equal(bountyStage(b({ myApplication: myApp("rejected") })), "closed");
  // Someone else won it.
  assert.equal(bountyStage(b({ status: "DELEGATED", myApplication: myApp("pending") })), "lost");
  assert.equal(bountyStage(b({ status: "PAID", myApplication: myApp("approved") })), "lost");

  // Assignee lifecycle.
  const mine = { isAssignee: true, myApplication: myApp("accepted") };
  assert.equal(bountyStage(b({ ...mine, status: "DELEGATED" })), "progress");
  assert.equal(bountyStage(b({ ...mine, status: "DELEGATED", submittedAt: 5 })), "review");
  assert.equal(bountyStage(b({ ...mine, status: "IN_REVIEW" })), "review");
  assert.equal(
    bountyStage(b({ ...mine, status: "IN_REVIEW", rejection: { reason: "r", byLogin: "s", at: 1 } })),
    "rejected"
  );
  assert.equal(bountyStage(b({ ...mine, status: "PAID" })), "paid");
  assert.equal(bountyStage(b({ ...mine, status: "CANCELLED", cancelReason: "rejected" })), "closed");
});

test("ready stage: all criteria met on a live review → ready for payout", () => {
  const mine = { isAssignee: true, myApplication: myApp("accepted") };
  assert.equal(bountyStage(b({ ...mine, status: "IN_REVIEW", review: proj(3, 3) })), "ready");
  assert.equal(bountyStage(b({ ...mine, status: "IN_REVIEW", review: proj(2, 3) })), "review");
  // Rejection still outranks a green review.
  assert.equal(
    bountyStage(b({ ...mine, status: "IN_REVIEW", review: proj(3, 3), rejection: { reason: "r", byLogin: "s", at: 1 } })),
    "rejected"
  );
});

test("acceptanceRate: paid vs rejected-closed; null with no finished work", () => {
  const paid = b({ id: "p", isAssignee: true, status: "PAID" });
  const rejectedClosed = b({ id: "r", isAssignee: true, status: "CANCELLED", cancelReason: "rejected" });
  const expiredClosed = b({ id: "e", isAssignee: true, status: "CANCELLED", cancelReason: "expired" });
  assert.equal(acceptanceRate([paid, paid, rejectedClosed]), 67);
  assert.equal(acceptanceRate([paid]), 100);
  // Expiry isn't a quality signal — excluded from the denominator.
  assert.equal(acceptanceRate([paid, expiredClosed]), 100);
  assert.equal(acceptanceRate([b({ myApplication: myApp("pending") })]), null);
});

test("timelineFromEvents maps every captured activity to a dated entry", () => {
  const events: BountyEvent[] = [
    { at: 1000, kind: "created", actor: "maya" },
    { at: 2000, kind: "funded", actor: "system" },
    { at: 3000, kind: "applied", actor: "devon", subject: "devon" },
    { at: 4000, kind: "application_approved", actor: "maya", subject: "devon" },
    { at: 5000, kind: "accepted", actor: "devon" },
    { at: 6000, kind: "pr_opened", actor: "devon", detail: "PR #7" },
    { at: 7000, kind: "review_completed", actor: "system", detail: "3 of 4 criteria met" },
    { at: 8000, kind: "payout_requested", actor: "devon" },
    { at: 9000, kind: "submission_rejected", actor: "maya", detail: "Criterion 3 regressed." },
    { at: 9500, kind: "rejection_accepted", actor: "devon" },
    { at: 9700, kind: "refund_submitted", actor: "system", detail: "rejected" },
    { at: 9900, kind: "refunded", actor: "system", detail: "rejected" },
  ];
  const tl = timelineFromEvents(
    b({ isAssignee: true, status: "CANCELLED", cancelReason: "rejected", events })
  );
  assert.equal(tl.length, events.length, "every event renders");
  tl.forEach((e, i) => assert.equal(e.at, events[i].at, `entry ${i} keeps its real timestamp`));
  assert.equal(tl[1].action, "Bounty funded");
  assert.equal(tl[3].action, "You were picked by @maya");
  assert.equal(tl[6].action, "DevAsign review");
  assert.equal(tl[6].detail, "3 of 4 criteria met");
  assert.equal(tl[8].cls, "danger");
  assert.match(tl[8].action, /maya rejected/);
});

test("timelineFromEvents appends the live 'now' tail per stage", () => {
  const appliedTl = timelineFromEvents(
    b({ myApplication: myApp("pending"), events: [{ at: 1, kind: "applied", actor: "me", subject: "me" }] })
  );
  const tail = appliedTl[appliedTl.length - 1];
  assert.equal(tail.at, null);
  assert.equal(tail.timeLabel, "now");
  assert.match(tail.action, /Awaiting the maintainer/);
});

test("timelineFromEvents legacy fallback synthesizes from timestamps", () => {
  const tl = timelineFromEvents(
    b({
      isAssignee: true, status: "PAID", events: [],
      fundedAt: 10, myApplication: myApp("accepted"), acceptedAt: 20,
      submittedAt: 30, prNumber: 7, paidAt: 40,
    })
  );
  assert.equal(tl[0].action, "Bounty funded");
  assert.equal(tl[0].at, 10, "prefers real fundedAt over createdAt");
  assert.equal(tl[tl.length - 1].action, "Escrow released");
  assert.equal(tl[tl.length - 1].at, 40);
});

test("groupBounties routes stages into dashboard buckets", () => {
  const list = [
    b({ id: "aw", myApplication: myApp("approved") }), // legacy approved → applied bucket now
    b({ id: "pr", isAssignee: true, status: "DELEGATED" }),
    b({ id: "rv", isAssignee: true, status: "IN_REVIEW" }),
    b({ id: "rj", isAssignee: true, status: "IN_REVIEW", rejection: { reason: "r", byLogin: "s", at: 1 } }),
    b({ id: "ap", myApplication: myApp("pending") }),
    b({ id: "pd", isAssignee: true, status: "PAID" }),
    b({ id: "cl", status: "CANCELLED" }),
  ];
  const g = groupBounties(list);
  assert.deepEqual(g.active.map((x) => x.id), ["pr", "rv", "rj"]);
  assert.deepEqual(g.applied.map((x) => x.id), ["aw", "ap"]);
  assert.deepEqual(g.completed.map((x) => x.id), ["pd"]);
  assert.deepEqual(g.closed.map((x) => x.id), ["cl"]);
});

test("isStellarAddr: 56-char base32 G-addresses only", () => {
  assert.equal(isStellarAddr("G" + "A".repeat(55)), true);
  assert.equal(isStellarAddr("  G" + "A".repeat(55) + " "), true); // trims
  assert.equal(isStellarAddr("G" + "A".repeat(54)), false); // too short
  assert.equal(isStellarAddr("G" + "A".repeat(56)), false); // too long
  assert.equal(isStellarAddr("S" + "A".repeat(55)), false); // seed, not address
  assert.equal(isStellarAddr("G" + "a".repeat(55)), false); // lowercase
  assert.equal(isStellarAddr("G" + "A".repeat(54) + "1"), false); // 1 not in base32
  assert.equal(isStellarAddr(""), false);
});

test("isValidMemo measures bytes, not characters", () => {
  assert.equal(isValidMemo(""), true);
  assert.equal(isValidMemo("x".repeat(28)), true);
  assert.equal(isValidMemo("x".repeat(29)), false);
  assert.equal(isValidMemo("€".repeat(9)), true);   // 27 bytes
  assert.equal(isValidMemo("€".repeat(10)), false); // 30 bytes
});

test("parsePrUrl mirrors the backend's canonical-URL rule", () => {
  assert.deepEqual(parsePrUrl("https://github.com/acme/pay/pull/318"), { repo: "acme/pay", prNumber: 318 });
  assert.equal(parsePrUrl("https://github.com/acme/pay/issues/318"), null);
  assert.equal(parsePrUrl("https://gitlab.com/acme/pay/pull/318"), null);
});

const review = (met: number, unmet: number, pending: number): BountyReview => ({
  status: "completed", headSha: "abc", prNumber: 1, additions: 1, deletions: 1,
  changedFiles: 1, updatedAt: 0,
  counts: { met, unmet, pending, total: met + unmet + pending },
  criteria: Array.from({ length: met + unmet + pending }, (_, i) => ({
    n: i + 1, text: `c${i + 1}`,
    status: i < met ? ("met" as const) : i < met + unmet ? ("unmet" as const) : ("pending" as const),
    finding: null,
  })),
  extraCriteria: [],
});

test("criteria merge + headline + payout gate", () => {
  // No review yet: acceptance renders as pending rows.
  const merged = mergedCriteria(["one", "two"], null);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].status, "pending");
  assert.equal(reviewHeadline(null), null);

  const r = review(2, 1, 0);
  assert.equal(mergedCriteria(["one"], r), r.criteria);
  assert.equal(reviewHeadline(r), "2 of 3 criteria met — 1 outstanding");
  assert.equal(reviewHeadline(review(3, 0, 0)), "All 3 criteria met");
  assert.equal(reviewHeadline(review(0, 0, 4)), "Review queued — no verdicts yet");
  assert.equal(allCriteriaMet(review(3, 0, 0)), true);
  assert.equal(allCriteriaMet(r), false);
  assert.equal(allCriteriaMet(null), false);
});

test("display helpers", () => {
  assert.equal(cmoney(750), "$750");
  assert.equal(cmoney(1250.4), "$1,250");
  assert.equal(shortAddr("GDEV7NK4XZQP2H5KFPA9LMN8C4VWZ7TQH3RJ6BPA9LMN8C4VWZ7TQH3R"), "GDEV7N…7TQH3R");
  assert.equal(shortAddr("GSHORT"), "GSHORT");
  const now = 1_000_000_000_000;
  assert.equal(timeLeft(now + 3 * 24 * 3600_000 + 1000, now), "3 days left");
  assert.equal(timeLeft(now + 5 * 3600_000, now), "5h left");
  assert.equal(timeLeft(now - 1, now), "past due");
});

test("deleteConfirmOk: both factors must match", () => {
  // happy path — exact, case-insensitive, whitespace-tolerant
  assert.equal(deleteConfirmOk("octocat", "octocat", "delete my account"), true);
  assert.equal(deleteConfirmOk("Octocat", "  octocat ", " Delete My Account "), true);
  // one factor alone is never enough
  assert.equal(deleteConfirmOk("octocat", "octocat", ""), false);
  assert.equal(deleteConfirmOk("octocat", "", "delete my account"), false);
  assert.equal(deleteConfirmOk("octocat", "someone-else", "delete my account"), false);
  assert.equal(deleteConfirmOk("octocat", "octocat", "delete my acct"), false);
  // missing login keeps the gate shut even with blank inputs
  assert.equal(deleteConfirmOk(undefined, "", ""), false);
  assert.equal(deleteConfirmOk("", "", "delete my account"), false);
});

// ── timeline extension ───────────────────────────────────────────────────────

test("isValidExtensionDays: integer 1..7 only", () => {
  assert.equal(isValidExtensionDays(1), true);
  assert.equal(isValidExtensionDays(3), true);
  assert.equal(isValidExtensionDays(7), true);
  assert.equal(isValidExtensionDays(0), false);
  assert.equal(isValidExtensionDays(8), false);
  assert.equal(isValidExtensionDays(2.5), false);
  assert.equal(isValidExtensionDays(NaN), false);
});

test("extensionState: keyed off stage and the extension subdocument", () => {
  const ext = (status: "pending" | "approved" | "declined") => ({
    days: 2, reason: "r", requestedBy: "dev", requestedAt: 1, status,
  });
  const progress = { status: "DELEGATED" as const, isAssignee: true, acceptedAt: 1 };

  assert.equal(extensionState(b({ ...progress })), "can_request");
  assert.equal(extensionState(b({ ...progress, extension: ext("declined") })), "can_request");
  assert.equal(extensionState(b({ ...progress, extension: ext("pending") })), "pending");
  assert.equal(extensionState(b({ ...progress, extension: ext("approved") })), "approved");
  // Outside the in-progress window it's never offered.
  assert.equal(extensionState(b({ status: "OPEN" })), "unavailable");
  assert.equal(extensionState(b({ ...progress, submittedAt: 5, prNumber: 9 })), "unavailable");
  assert.equal(extensionState(b({ status: "CANCELLED", isAssignee: true })), "unavailable");
});

test("timelineFromEvents renders the three extension kinds", () => {
  const events: BountyEvent[] = [
    { at: 1, kind: "extension_requested", actor: "dev", detail: "3 days — sick" },
    { at: 2, kind: "extension_declined", actor: "sponsor" },
    { at: 3, kind: "extension_approved", actor: "sponsor", detail: "+2 days — due 2026-07-30" },
  ];
  const entries = timelineFromEvents(b({ status: "DELEGATED", isAssignee: true, acceptedAt: 1, events }));
  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes("You requested a timeline extension"));
  assert.ok(actions.includes("@sponsor declined your extension request"));
  assert.ok(actions.includes("@sponsor approved your extension"));
});
