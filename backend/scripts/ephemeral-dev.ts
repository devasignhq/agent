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
// ||= so a second, parallel instance can point at its own frontend port.
process.env.WEB_ORIGIN ||= "http://localhost:3001";
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

// ── Security page seed ───────────────────────────────────────────────────────
// A repository row + findings across severities/states + scan runs, so the
// Security page (dashboard, detail, merge gate terminal, policy) renders with
// real data. One finding sits on issue #2 — the FUNDED bounty above — which
// exercises the issue→bounty linkage end-to-end.
const now = Date.now();
const HOUR = 60 * 60 * 1000;
db.insert("repositories", {
  id: "ephemeral-repo-1",
  installationId: "ephemeral-install-1",
  owner: "ephemeral-tester",
  name: "demo",
  defaultBranch: "main",
  private: false,
  defaultModel: "",
  modelOverrides: {},
  reviewsEnabled: true,
  indexState: "ready",
  indexedAt: now - HOUR,
  indexedCommit: "8c1a2f0",
  indexedFileCount: 42,
});
// Index rows for every path the findings below sit on. The index IS the audit's
// file inventory — without it a full run has nothing to scan and can't tell a
// deleted file from an unbuilt index, so it (correctly) skips.
for (const [path, flags] of [
  ["api/routes/payouts.ts", ["handles-auth", "moves-funds"]],
  ["api/ledger/export.ts", ["raw-sql"]],
  ["web/app/invite/page.tsx", ["parses-user-input"]],
  ["api/auth/otp.ts", ["handles-auth"]],
  ["package-lock.json", []],
  ["api/middleware/error.ts", []],
  ["infra/s3.tf", []],
]) {
  db.insert("repoIndex", {
    id: `ephemeral-idx-${path.replace(/[^a-z0-9]/gi, "-")}`,
    repoId: "ephemeral-repo-1",
    path,
    sha: `sha-${path.length}`,
    size: 2048,
    language: path.split(".").pop(),
    summary: `Seeded index entry for ${path}.`,
    exports: [],
    imports: [],
    securityFlags: flags,
    securityScannedSha: `sha-${path.length}`, // already audited at this blob…
    securityEngine: "audit-v1", // …by THIS engine — a bare sha is a legacy stamp

    indexedAt: now - HOUR,
    model: "mock",
  });
}
const seedFinding = (over) => {
  const row = {
    id: `ephemeral-vln-${Math.random().toString(36).slice(2, 8)}`,
    fingerprint: Math.random().toString(16).slice(2, 18),
    repoId: "ephemeral-repo-1",
    path: "api/routes/payouts.ts",
    class: "missing-authz",
    surface: "api",
    severity: "critical",
    confidence: "confirmed",
    title: "finding",
    concern: "seeded",
    state: "open",
    firstDetectedAt: now - 26 * HOUR,
    lastSeenAt: now - HOUR,
    detectedSha: "8c1a2f0",
    model: "mock",
    activity: [
      { at: now - 26 * HOUR, kind: "detected", detail: "Detected by security audit after merge of PR #487", actor: "audit-agent" },
    ],
    ...over,
  };
  db.insert("securityFindings", row);
  return row;
};
seedFinding({
  line: 88,
  symbol: "registerRoutes",
  cwe: "CWE-306",
  severity: "critical",
  state: "new",
  title: "Payout route reachable without authentication",
  concern:
    "The route-registration rewrite dropped requireAuth and requireScope from the payouts group while every other group kept them. Any caller who can reach the edge can create a transfer to an arbitrary destination.",
  evidence: 'line 88: app.post("/v1/payouts", createPayout) — no auth middleware in the chain',
  dataflow: { source: "POST /v1/payouts (public edge)", sink: "stripe.transfers.create()", steps: ["idempotency() passes the body through untouched", "createPayout(req.body) reads destination and amount from the caller"] },
  exploitNarrative: [
    "Send POST /v1/payouts from any host — the route has no auth middleware",
    "Set destination to an attacker account and amount to the per-tx cap",
    "The handler calls stripe.transfers.create() and real funds move",
  ],
  blastRadius: "funds — up to the 25,000 USDC per-transaction cap",
  invariant: "every payout call is authenticated and scoped to payouts:write",
  remediation:
    'Fix: restore auth on the payouts group\n\nFile: api/routes/payouts.ts\nSymbol: registerRoutes\n\nIssue:\nThe consolidation removed requireAuth + requireScope("payouts:write").\n\nSuggested approach:\nRe-add app.use("/v1/payouts", requireAuth, requireScope("payouts:write")) before the idempotency middleware.',
  regressionTest: 'expect(await post("/v1/payouts", { noAuth: true })).toHaveStatus(401);',
  introducedByPr: 487,
  introducedSha: "8c1a2f0",
  introducedByAuthor: "dmitri",
  firstDetectedAt: now - 2 * HOUR,
  lastSeenAt: now - HOUR,
});
seedFinding({
  path: "api/ledger/export.ts",
  line: 203,
  class: "sql-injection",
  cwe: "CWE-89",
  severity: "high",
  state: "open",
  title: "Ledger export builds SQL by string interpolation",
  concern: "The rewrite swapped a parameterized query for a template string. Any future caller, or a compromised admin session, can inject arbitrary SQL.",
  evidence: "line 203: const q = `SELECT * FROM ledger WHERE date BETWEEN ${'${range.from}'} AND ${'${range.to}'}`",
  exploitNarrative: [
    "Authenticate as an admin (or compromise an admin session)",
    "Call GET /v1/ledger/export with range.from = \"1 UNION SELECT * FROM users --\"",
    "db.raw() executes the injected statement against Postgres",
  ],
  blastRadius: "ledger DB — read access to all tables",
  remediation: "Fix: parameterize the export query\n\nFile: api/ledger/export.ts",
  introducedByPr: 487,
  introducedSha: "8c1a2f0",
  introducedByAuthor: "dmitri",
});
seedFinding({
  path: "web/app/invite/page.tsx",
  line: 47,
  class: "xss",
  cwe: "CWE-79",
  surface: "frontend",
  severity: "high",
  state: "issue_created",
  issueNumber: 2,
  issueUrl: "https://github.com/ephemeral-tester/demo/issues/2",
  title: "Reflected XSS via ?ref on the invite page",
  concern: "The invited-by label switched from an escaped sanitize() call to dangerouslySetInnerHTML with no encoding.",
  exploitNarrative: [
    "Craft an invite link with ?ref=<script payload>",
    "Send the link to a victim (the page needs no auth)",
    "The payload executes in the visitor's session",
  ],
  blastRadius: "session — invite-page visitors",
  remediation: "Fix: restore sanitize() on the ref label\n\nFile: web/app/invite/page.tsx",
  introducedByPr: 401,
  introducedByAuthor: "priya",
  activity: [
    { at: now - 26 * HOUR, kind: "detected", detail: "Detected by security audit", actor: "audit-agent" },
    { at: now - 20 * HOUR, kind: "issue_created", detail: "GitHub issue #2 created", actor: "ephemeral-tester" },
  ],
});
seedFinding({
  path: "api/auth/otp.ts",
  line: 34,
  class: "missing-rate-limit",
  cwe: "CWE-307",
  severity: "medium",
  state: "snoozed",
  snoozeUntil: now + 5 * 24 * HOUR,
  title: "No rate limit on OTP verification endpoint",
  concern: "A scripted attacker can attempt all 10,000 OTP codes against a single session inside typical expiry windows.",
  exploitNarrative: ["Request an OTP for the victim account", "Script all 10,000 codes against /verify", "Session is taken over"],
  blastRadius: "account takeover — one account per attack",
})
seedFinding({
  path: "package-lock.json",
  class: "vulnerable-dependency",
  surface: "deps",
  severity: "medium",
  state: "fix_ready",
  stateReason: "Fix verified on PR #489",
  title: "axios 1.6.2 leaks auth header across redirects",
  concern: "Reachable where the app follows cross-origin redirects with an Authorization header attached — 2 call sites match.",
  exploitNarrative: ["Induce a request to an attacker-controlled redirecting endpoint", "axios forwards the Authorization header cross-origin", "Attacker replays the captured token"],
  blastRadius: "auth tokens on outbound requests",
});
seedFinding({
  path: "api/middleware/error.ts",
  line: 19,
  class: "info-disclosure",
  cwe: "CWE-209",
  severity: "low",
  state: "accepted",
  stateReason: "Accepted risk — guarded by NODE_ENV; reviewed quarterly.",
  title: "Stack traces returned on 500 in production",
  concern: "Guarded by an environment check that has held for 90+ days of scans; staging is occasionally misconfigured.",
  exploitNarrative: ["Trigger any unhandled exception", "Read the stack from the 500 body", "Use internals to aim further attacks"],
  blastRadius: "internal detail disclosure only",
});
seedFinding({
  path: "infra/s3.tf",
  line: 31,
  class: "misconfiguration",
  surface: "infra",
  severity: "high",
  state: "resolved",
  resolvedAt: now - 8 * HOUR,
  title: "Receipts bucket allowed public read",
  concern: "acl was flipped to public-read; receipt object keys are guessable.",
  exploitNarrative: ["Guess a {userId}/{txId}.pdf key", "GET the object unauthenticated", "Read customer receipts"],
  blastRadius: "customer receipts — read-only",
});
// Scan-run history: a running one streams the terminal; completed ones fill
// the introduced-vs-resolved chart.
const seedScan = (over) =>
  db.insert("securityScans", {
    id: `ephemeral-scan-${Math.random().toString(36).slice(2, 8)}`,
    repoId: "ephemeral-repo-1",
    trigger: "merge",
    full: false,
    status: "completed",
    startedAt: now - 2 * HOUR,
    finishedAt: now - 2 * HOUR + 38_000,
    filesScanned: 12,
    cacheHits: 30,
    introduced: 0,
    resolved: 0,
    stillOpen: 5,
    log: [],
    ...over,
  });
// Per-severity splits so the chart's stacked bars have every colour to show.
const SPLITS = [
  { high: 1 },
  {},
  { high: 1, medium: 1 },
  { medium: 1 },
  {},
  { low: 1 },
  { critical: 1, high: 1, medium: 1 },
  {},
  { medium: 1, low: 1 },
  { high: 1 },
  {},
];
for (let i = 0; i < SPLITS.length; i++) {
  const split = SPLITS[i];
  seedScan({
    prNumber: 476 + i,
    prTitle: `Merge #${476 + i}`,
    mergeSha: `a${i}f00${i}`,
    prAuthor: i % 2 ? "dmitri" : "priya",
    startedAt: now - (13 - i) * 24 * HOUR,
    finishedAt: now - (13 - i) * 24 * HOUR + 40_000,
    introduced: Object.values(split).reduce((n, v) => n + v, 0),
    introducedBySeverity: split,
    resolved: [0, 2, 1, 0, 4, 1, 2, 3, 1, 5, 2][i],
  });
}
// The two kinds of bar-less column, which the chart has to tell apart: a scan
// that ran and found no change, and one that never ran at all. Seeded because
// they look identical without the tooltip/hatch — which is how an audit that
// silently scanned nothing read as a working chart full of empty columns.
seedScan({
  trigger: "manual",
  prNumber: null,
  startedAt: now - 6 * HOUR,
  finishedAt: now - 6 * HOUR + 9_000,
  filesScanned: 3,
  stillOpen: 5,
});
seedScan({
  trigger: "nightly",
  full: true,
  prNumber: null,
  startedAt: now - 4 * HOUR,
  finishedAt: now - 4 * HOUR,
  filesScanned: 0,
  cacheHits: 0,
  skipped: "plan_locked",
  stillOpen: 5,
  log: [{ at: now - 4 * HOUR, line: "skipped — security audits are a Pro/Max feature" }],
});
seedScan({
  prNumber: 487,
  prTitle: "Add instant payout rail",
  mergeSha: "8c1a2f0",
  prAuthor: "dmitri",
  startedAt: now - 2 * HOUR,
  finishedAt: now - 2 * HOUR + 38_000,
  introduced: 2,
  introducedBySeverity: { critical: 1, high: 1 },
  resolved: 1,
  stillOpen: 5,
  log: [
    "$ devasign security-audit ephemeral-tester/demo --trigger merge --merge #487",
    "scope differential · 42 indexed · 12 to scan · 30 cache hits",
    "✗ CRITICAL api/routes/payouts.ts:88 — Payout route reachable without authentication",
    "✗ HIGH     api/ledger/export.ts:203 — Ledger export builds SQL by string interpolation",
    "✓ 1 finding(s) resolved in infra/s3.tf",
    "done in 38.0s · 2 new · 1 resolved · 5 open",
  ].map((line, i) => ({ at: now - 2 * HOUR + i * 4000, line })),
});
console.log("[ephemeral] seeded security findings + scan runs for ephemeral-repo-1");
