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
console.log("[ephemeral] seeded user ephemeral-user-1 — cookie: base64url('ephemeral-user-1:<ts>')");
