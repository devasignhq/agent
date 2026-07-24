// Throwaway local server for frontend verification: boots the real app with an
// ephemeral in-memory DB (no Neon connection), mock LLM, Statsig disabled, and
// one seeded user so a minted devasign_session cookie can sign in.
//
//   npx tsx backend/scripts/ephemeral-dev.ts
//
// Env is pinned before the dynamic import below — dotenv inside config.ts
// never overrides keys that are already present in process.env, so the empty
// strings here win over backend/.env regardless of cwd.
process.env.DATABASE_URL = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.STATSIG_SECRET_KEY = "";
process.env.WEB_ORIGIN = "http://localhost:3001";
process.env.PORT ||= "8787"; // ||= so a caller can run a second instance elsewhere
// Dummy Stellar config so isStellarConfigured() passes and the bounty surfaces
// (create/list/links) are exercisable — nothing here reaches a chain until a
// funding tx is actually built, which will just error against the fake ids.
process.env.STELLAR_ESCROW_CONTRACT_ID ||= "C_EPHEMERAL_TEST";
process.env.STELLAR_USDC_SAC_ID ||= "C_EPHEMERAL_TEST";
// The admin secret, unlike the contract ids above, is decoded at boot: the
// server's listen banner logs the admin PUBLIC key via adminAddress() →
// Keypair.fromSecret(), which throws on a non-strkey placeholder. So this one
// must be a format-valid (funds-less, throwaway) ed25519 seed, not "S_…TEST".
const { Keypair } = await import("@stellar/stellar-sdk");
process.env.STELLAR_ADMIN_SECRET ||= Keypair.random().secret();

// Dynamic import so the assignments above run first (static imports hoist).
await import("../src/server.js");

const { db } = await import("../src/db.js");
db.insert("users", {
  id: "ephemeral-user-1",
  githubId: null,
  githubLogin: "ephemeral-tester",
  email: "ephemeral@example.com",
  plan: "free",
  createdAt: Date.now(),
});
// An installation row so the frontend routes past onboarding into the app shell.
db.insert("installations", {
  id: "ephemeral-install-1",
  userId: "ephemeral-user-1",
  accountId: 1,
  accountLogin: "ephemeral-tester",
  installationId: 1,
  repoIds: [],
});
// One awaiting-funding bounty on the seeded installation so the Bounties page
// (list, drawer, in-app Fund/Cancel links) renders with real data.
const { createBounty, recordFunding, applyTxnOutcome, patchBounty, recordSponsorRelease } =
  await import("../src/bounties/service.js");
createBounty({
  source: "github",
  installationId: 1,
  repo: "ephemeral-tester/demo",
  issueNumber: 1,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/1",
  title: "Demo bounty (ephemeral)",
  description: "Seeded by scripts/ephemeral-dev.ts for local verification.",
  amountUsdc: 100,
  deliveryDays: 5,
  sponsorUserId: "ephemeral-user-1",
});
// …and one FUNDED (OPEN) bounty so the contributor apply flow (the bot
// comment's Apply CTA → /bounties/:id/apply) is exercisable end-to-end.
const openBounty = createBounty({
  source: "github",
  installationId: 1,
  repo: "ephemeral-tester/demo",
  issueNumber: 2,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/2",
  title: "Funded demo bounty (ephemeral)",
  description: "Already escrowed — contributors can apply.",
  amountUsdc: 250,
  deliveryDays: 7,
  sponsorUserId: "ephemeral-user-1",
});
recordFunding(openBounty.id, "G".padEnd(56, "A"), { hash: "H_EPHEMERAL", status: "pending" });
const escrowTxn = db.find(
  "escrowTransactions",
  (t) => t.idempotencyKey === `escrow:${openBounty.taskId}`
)!;
applyTxnOutcome(escrowTxn.id, { status: "success", ledger: 1 });
// …and one PAID bounty carrying a CONFIRMED PAYOUT. Without this the
// transaction history only ever holds an `escrow` row, and payouts are the only
// kind that can be invoiced (see TxnRow in screen-bounties.tsx) — so the invoice
// preview/download would be unreachable locally. Content mirrors the invoice
// design so the seeded document matches the mock.
const paidBounty = createBounty({
  source: "github",
  installationId: 1,
  repo: "ephemeral-tester/demo",
  issueNumber: 8842,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/8842",
  title: "Add anti-fingerprinting capabilities to avoid bot detection",
  description: "Already paid out — exercises the invoice preview and PDF download.",
  amountUsdc: 450,
  deliveryDays: 7,
  sponsorUserId: "ephemeral-user-1",
});
recordFunding(paidBounty.id, "G".padEnd(56, "A"), { hash: "H_EPHEMERAL_PAID", status: "pending" });
await applyTxnOutcome(
  db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${paidBounty.taskId}`)!.id,
  { status: "success", ledger: 2 }
);
// Stands in for apply → approve → accept: the payout (and so the invoice) only
// reads the assignee snapshot, so seeding it directly beats driving four routes.
patchBounty(paidBounty.id, {
  status: "IN_REVIEW",
  assigneeGithubId: 424242,
  assigneeGithubLogin: "ephemeral-contributor",
  assigneeAddress: "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4TPPZAKQGZ3S4EFVXJT",
  prNumber: 12,
});
recordSponsorRelease(paidBounty.id, {
  status: "success",
  hash: "3ad9f0c1e2b4a5768899aabbccddeeff00112233445566778899aabbccddeeff",
});
await applyTxnOutcome(
  db.find("escrowTransactions", (t) => t.idempotencyKey === `release:${paidBounty.taskId}`)!.id,
  { status: "success", ledger: 3 }
);

// A contributor identity (GitHub id, NO installation) for the apply flow — also
// exercises the app's onboarding bypass on bounty deep links.
db.insert("users", {
  id: "ephemeral-contributor-1",
  githubId: 424242,
  githubLogin: "ephemeral-contributor",
  email: "contributor@example.com",
  plan: "free",
  createdAt: Date.now(),
});

// …and one DELEGATED (unsubmitted) bounty assigned to that contributor so the
// in-progress surfaces — submit CTA, timeline-extension request/approve — are
// exercisable from both apps without driving apply → approve → accept.
const delegatedBounty = createBounty({
  source: "github",
  installationId: 1,
  repo: "ephemeral-tester/demo",
  issueNumber: 3,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/3",
  title: "Delegated demo bounty (ephemeral)",
  description: "In progress — exercises the submission + extension CTAs.",
  amountUsdc: 300,
  deliveryDays: 5,
  sponsorUserId: "ephemeral-user-1",
});
recordFunding(delegatedBounty.id, "G".padEnd(56, "A"), { hash: "H_EPHEMERAL_DELEGATED", status: "pending" });
await applyTxnOutcome(
  db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${delegatedBounty.taskId}`)!.id,
  { status: "success", ledger: 4 }
);
patchBounty(delegatedBounty.id, {
  status: "DELEGATED",
  applications: [{ githubId: 424242, githubLogin: "ephemeral-contributor", appliedAt: Date.now(), status: "accepted" }],
  assigneeGithubId: 424242,
  assigneeGithubLogin: "ephemeral-contributor",
  assigneeAddress: "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4TPPZAKQGZ3S4EFVXJT",
  acceptedAt: Date.now(),
  // 12h out: inside the keeper's 24h warning window, so the first tick fires the
  // "due in Xh" bell — the extension CTA is still exercisable (and this is exactly
  // when a contributor would reach for it).
  deadlineAt: Date.now() + 12 * 60 * 60 * 1000,
});

// …and one IN_REVIEW bounty. The /submit route verifies the PR against real
// GitHub, which ephemeral mode can't do, so the review stage was unreachable here
// and its surfaces went unexercised — which is how it shipped showing no delivery
// deadline at all. Seeded past-due on purpose: the window is absolute (it keeps
// running through review), so this is the state where the keeper sweeps a bounty
// whose work was actually delivered.
const reviewBounty = createBounty({
  source: "github",
  installationId: 1,
  repo: "ephemeral-tester/demo",
  issueNumber: 4,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/4",
  title: "In-review demo bounty (ephemeral)",
  description: "Submitted and awaiting the sponsor — exercises the review-stage deadline surfaces.",
  amountUsdc: 150,
  deliveryDays: 3,
  sponsorUserId: "ephemeral-user-1",
});
recordFunding(reviewBounty.id, "G".padEnd(56, "A"), { hash: "H_EPHEMERAL_REVIEW", status: "pending" });
await applyTxnOutcome(
  db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${reviewBounty.taskId}`)!.id,
  { status: "success", ledger: 5 }
);
patchBounty(reviewBounty.id, {
  status: "IN_REVIEW",
  applications: [{ githubId: 424242, githubLogin: "ephemeral-contributor", appliedAt: Date.now(), status: "accepted" }],
  assigneeGithubId: 424242,
  assigneeGithubLogin: "ephemeral-contributor",
  assigneeAddress: "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4TPPZAKQGZ3S4EFVXJT",
  acceptedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  submittedAt: Date.now() - 60 * 60 * 1000,
  prNumber: 21,
  // 6h out rather than past-due: a past-due one is swept within a tick and the
  // review-stage surfaces vanish, so this keeps the stage inspectable and fires
  // the warning bell's review-flavoured copy on the first tick.
  deadlineAt: Date.now() + 6 * 60 * 60 * 1000,
});

// Session cookies are now signed JWTs (HS256 over SESSION_SECRET), so mint the
// cookie through the same helper the server verifies — a hand-rolled value won't
// pass getSessionUser anymore. Print it ready to paste into a curl Cookie header.
const { signSession } = await import("../src/github/oauth.js");
console.log(
  `[ephemeral] seeded user ephemeral-user-1 — cookie: devasign_session=${signSession("ephemeral-user-1")}`
);
console.log(
  `[ephemeral] seeded contributor ephemeral-contributor-1 — cookie: devasign_session=${signSession("ephemeral-contributor-1")}`
);
console.log(`[ephemeral] funded bounty apply page: http://localhost:3001/bounties/${openBounty.id}/apply`);
