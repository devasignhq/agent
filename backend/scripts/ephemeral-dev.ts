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
process.env.PORT = "8787";
// Dummy Stellar config so isStellarConfigured() passes and the bounty surfaces
// (create/list/links) are exercisable — nothing here reaches a chain until a
// funding tx is actually built, which will just error against the fake ids.
process.env.STELLAR_ESCROW_CONTRACT_ID ||= "C_EPHEMERAL_TEST";
process.env.STELLAR_USDC_SAC_ID ||= "C_EPHEMERAL_TEST";
process.env.STELLAR_ADMIN_SECRET ||= "S_EPHEMERAL_TEST";

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
const { createBounty } = await import("../src/bounties/service.js");
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

// Session cookies are now signed JWTs (HS256 over SESSION_SECRET), so mint the
// cookie through the same helper the server verifies — a hand-rolled value won't
// pass getSessionUser anymore. Print it ready to paste into a curl Cookie header.
const { signSession } = await import("../src/github/oauth.js");
console.log(
  `[ephemeral] seeded user ephemeral-user-1 — cookie: devasign_session=${signSession("ephemeral-user-1")}`
);
