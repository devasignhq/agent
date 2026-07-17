import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { securityHeaders } from "./security.js";

import {
  allowedWebOrigins,
  config,
  isDiscordEnvConfigured,
  isGithubAppConfigured,
  isGithubWebhookConfigured,
  isLLMLive,
  isProductionLike,
  isSessionSecretShort,
  isSlackEnvConfigured,
  isStatsigConfigured,
  sessionSecretLength,
  sessionSecretProblem,
} from "./config.js";
import { initStatsig, shutdownStatsig } from "./statsig.js";
import { startOAuth, finishOAuth, signOut } from "./github/oauth.js";
import { enforceSameOrigin } from "./csrf.js";
import { handleWebhook } from "./github/webhooks.js";
import { startLinearOAuth, finishLinearOAuth } from "./linear/oauth.js";
import { handleLinearWebhook } from "./linear/webhooks.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { api } from "./routes/api.js";
import { bounties } from "./routes/bounties.js";
import { contributor } from "./routes/contributor.js";
import { closeAllStreams } from "./notifications-stream.js";
import { dedupePRReviews } from "./review/dedupe.js";
import { startWorker } from "./worker.js";
import { startBountyKeeper } from "./bounties/keeper.js";
import { db, initDb, shutdownDb } from "./db.js";
import { durabilityBarrier } from "./durability.js";
import { enqueueIndex } from "./queue.js";
import { authLimiter, globalLimiter } from "./rate-limit.js";

// Session cookies are JWTs signed with SESSION_SECRET, as are the bounty
// fund/cancel/approve links in bounties/links.ts. A secret that is public (either
// committed placeholder) or short enough to grind offline lets anyone mint a
// cookie for any user id, so refuse to boot rather than serve forgeable sessions.
// Local/ephemeral dev and `npm test` trip neither prod signal, so they keep using
// the dev fallback untouched.
const HOW_TO_GENERATE =
  'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

if (isProductionLike()) {
  const problem = sessionSecretProblem(config.sessionSecret);
  if (problem) {
    throw new Error(
      `SESSION_SECRET is unusable in production: ${problem}. ` +
        `Refusing to boot — sessions signed with it are forgeable by anyone. ${HOW_TO_GENERATE}`
    );
  }
  // SESSION_SECRET_PREVIOUS is verification-only, but a token signed with a
  // public old secret still verifies, so it needs the same bar. This is a real
  // trap, not a hypothetical: rotating off a placeholder by moving it here (to
  // avoid dropping live sessions) is the natural reading of the error above, and
  // it would quietly leave the hole wide open.
  for (const previous of config.sessionSecretPrevious) {
    const previousProblem = sessionSecretProblem(previous);
    if (previousProblem) {
      throw new Error(
        `SESSION_SECRET_PREVIOUS contains an entry that is unusable in production: ${previousProblem}. ` +
          "Refusing to boot — cookies signed with that entry would still verify. Remove it; " +
          "sessions signed with it expire on their own within 7 days."
      );
    }
  }
  if (isSessionSecretShort(config.sessionSecret)) {
    console.warn(
      `[server] ⚠ SESSION_SECRET is only ${sessionSecretLength(config.sessionSecret)} characters. ` +
        `It is accepted, but rotate it to a 32-byte random value when convenient. ${HOW_TO_GENERATE}`
    );
  }
}

// GitHub signs every webhook with GITHUB_APP_WEBHOOK_SECRET, and the receiver
// verifies that HMAC before trusting an event (github/webhooks.ts). With no
// secret the receiver now FAILS CLOSED (rejects every delivery) — but a prod
// deployment silently dropping all webhooks is still broken, so keep the same
// prod signal as the session guard above: refuse to boot.
// In local dev we only warn; unsigned events can be explicitly allowed with
// ALLOW_UNSIGNED_WEBHOOKS=1 (never honored in a production-like environment).
if (isProductionLike() && !isGithubWebhookConfigured()) {
  throw new Error(
    "GITHUB_APP_WEBHOOK_SECRET must be set in production (WEB_ORIGIN is https, or NODE_ENV=production). " +
      "Refusing to boot: without it the GitHub webhook receiver would accept forged, unsigned events."
  );
}
if (!isProductionLike() && !isGithubWebhookConfigured()) {
  console.warn(
    config.github.allowUnsignedWebhooks
      ? "[server] ⚠ GITHUB_APP_WEBHOOK_SECRET is unset and ALLOW_UNSIGNED_WEBHOOKS=1 — " +
          "the GitHub webhook receiver accepts UNSIGNED events. Local dev only; " +
          "never run production this way."
      : "[server] ⚠ GITHUB_APP_WEBHOOK_SECRET is unset — the GitHub webhook receiver " +
          "fails closed and will REJECT all deliveries. Set the secret (or, for local " +
          "dev only, ALLOW_UNSIGNED_WEBHOOKS=1)."
  );
}

// Persistence is non-optional in prod. Unlike the secrets above, initDb() does
// NOT throw on a missing DATABASE_URL — it silently falls back to an in-memory
// store (db.ts), which serves reads fine but persists nothing, so EVERYTHING is
// wiped on the next redeploy. That failure mode has bitten prod before (see the
// self-heal note in github/oauth.ts). Same prod signal as the guards above:
// refuse to boot rather than run a production deploy on a throwaway store.
// Local/ephemeral dev trips neither signal and is unaffected.
if (isProductionLike() && !config.databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set in production (WEB_ORIGIN is https, or NODE_ENV=production). Refusing to boot: " +
      "without it the server runs an in-memory store that is silently wiped on every redeploy."
  );
}

const app = express();

// Render (and most PaaS) terminate TLS at a proxy and forward over http with
// X-Forwarded-* headers. Trusting the first hop makes req.protocol report https
// (from X-Forwarded-Proto), so the OAuth redirect_uri is built as https.
//
// Pinned to exactly 1 hop — NOT `true`. `true` trusts the whole X-Forwarded-For
// chain and takes its leftmost (client-supplied) entry as req.ip, which an
// attacker can forge to dodge the per-IP rate limiters. With a fixed hop count
// Express resolves req.ip from the address Render actually appended, which the
// client can't control. This doesn't affect https detection (the immediate hop
// is still trusted, so X-Forwarded-Proto is still honoured) or Secure cookies
// (those key off config.secureCookies, not req). Assumes a single proxy hop in
// front of the app, which is Render's standard web-service topology.
app.set("trust proxy", 1);

// Security headers on every response (HSTS, nosniff, frameguard, …). Helmet is
// tuned for a cross-origin JSON API + OAuth redirector (CSP/CORP/COOP all
// adjusted) — see security.ts for the per-header rationale.
app.use(securityHeaders);

app.use(morgan("dev"));
app.use(cors({ origin: allowedWebOrigins(), credentials: true }));
app.use(cookieParser());

// Broad per-IP flood shield, applied after CORS so handled preflights don't burn
// budget and before the webhook receivers below so they're covered too. This is
// the only throttle in front of the (HMAC-gated, but otherwise unauthenticated)
// webhook endpoints; per-IP is deliberately the right grain there — a flood
// comes from one source, while legitimate GitHub/Linear/Stripe deliveries arrive
// across many provider IPs and won't individually trip it. LLM-triggering routes
// get a much tighter bucket of their own (see rate-limit.ts / api.ts).
app.use(globalLimiter);

// Durability barrier: hold each response until its staged writes have reached
// Postgres so a redeploy/crash can't drop a write the client was told succeeded.
// Mounted before the webhook receivers + /api so it covers every mutating path.
// See durability.ts (extracted there so its failure-finalization is unit tested).
app.use(durabilityBarrier);

// Webhook receiver needs the raw body for HMAC verification, so register it
// BEFORE express.json() takes over the body. Both paths are accepted because
// the local smee tunnel is sometimes configured with `-t http://host:port`
// (no path), which forwards to `/`. Either lands the event in the same
// handler.
app.post(
  ["/api/webhooks/github", "/"],
  express.raw({ type: "application/json", limit: "5mb" }),
  handleWebhook
);

// Linear webhook also needs the raw body for HMAC verification — register it
// before express.json() for the same reason as the GitHub receiver above.
app.post(
  "/api/webhooks/linear",
  express.raw({ type: "application/json", limit: "5mb" }),
  handleLinearWebhook
);

// Stripe webhook needs the raw body too — for `stripe.webhooks.constructEvent`
// signature verification. Register it before express.json() like the
// GitHub/Linear receivers above.
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleStripeWebhook
);

app.use(express.json({ limit: "1mb" }));

// CSRF mitigation. The session cookie is SameSite=None in prod, so it rides
// cross-site requests; reject state-changing requests whose Origin/Referer isn't
// our own web origin. Registered AFTER the webhook receivers above — those
// terminate without next() and carry no browser Origin — so only the
// browser-facing identity + /api routes are gated. See csrf.ts for the full
// rationale (incl. why it only enforces when the cookie is cross-site).
app.use(enforceSameOrigin);

// Identity routes. authLimiter caps the unauthenticated OAuth handshake (each
// callback does a token exchange) well above any human sign-in cadence.
app.get("/api/auth/github", authLimiter, startOAuth);
app.get("/api/auth/github/callback", authLimiter, finishOAuth);
app.post("/api/auth/signout", authLimiter, signOut);

// Linear workspace connect (OAuth). Connects an already-signed-in user's Linear
// workspace and registers the ticket webhook; see linear/oauth.ts.
app.get("/api/auth/linear", authLimiter, startLinearOAuth);
app.get("/api/auth/linear/callback", authLimiter, finishLinearOAuth);

// API
app.use("/api", api);
app.use("/api", bounties);
app.use("/api", contributor);

// Convenience: where the GitHub-app-install button on onboarding sends users.
app.get("/api/install/redirect", (_req, res) => {
  if (!config.github.appName) return void res.status(503).send("GITHUB_APP_NAME not set");
  res.redirect(`https://github.com/apps/${config.github.appName}/installations/new`);
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// Error handler
app.use((err: any, req: any, res: any, _next: any) => {
  console.error("[server]", err);
  res.status(500).json({ error: "internal_error", message: err?.message || String(err) });
});

// Load persisted state from Postgres before we serve requests or run the
// worker/backfill — all of which read synchronously from the in-memory
// snapshot that initDb() populates.
try {
  await initDb();
} catch (err) {
  console.error("[server] fatal: could not initialize the database\n", err);
  process.exit(1);
}

// Collapse duplicate review rows from before creation was idempotent — must
// run before the worker starts so a leftover dupe can't enqueue another run.
const mergedReviews = dedupePRReviews();
if (mergedReviews > 0) {
  console.log(`[server] merged ${mergedReviews} duplicate PR review row${mergedReviews === 1 ? "" : "s"}`);
}

// Analytics. Non-fatal by design: initStatsig() swallows its own errors, so a
// Statsig outage (or an unset key in dev) never blocks boot.
await initStatsig();

const port = config.port;
const server = app.listen(port, () => {
  console.log(`DevAsign API listening on http://localhost:${port}`);
  console.log(`  · LLM:        ${isLLMLive() ? "live (Anthropic)" : "mock"}`);
  console.log(`  · GitHub App: ${isGithubAppConfigured() ? "configured" : "missing (outbound App credentials unset)"}`);
  console.log(`  · Webhook:    ${isGithubWebhookConfigured() ? "signature verified (HMAC)" : "UNVERIFIED — no secret (dev only)"}`);
  console.log(`  · Slack:      ${isSlackEnvConfigured() ? `env fallback → ${config.integrations.slackBotChannel}` : "per-user only"}`);
  console.log(`  · Discord:    ${isDiscordEnvConfigured() ? `env fallback → ${config.integrations.discordBotChannelId}` : "per-user only"}`);
  console.log(`  · Statsig:    ${isStatsigConfigured() ? `live (${config.statsig.environment})` : "disabled (no key)"}`);
  console.log(`  · Web origin: ${config.webOrigin}`);
  // Spell out which webhook event types the receiver handles. If a comment
  // posted on GitHub never shows up in stdout (or in the review log), the
  // first thing to verify is that the matching event here is also subscribed
  // in the GitHub App's settings on github.com → Permissions & events.
  console.log(
    `  · Webhooks:   accepting installation, installation_repositories, pull_request, issue_comment, pull_request_review, pull_request_review_comment, github_app_authorization, ping`
  );
  // Self-diagnose: ask GitHub which events the App is actually configured to
  // deliver. A common failure mode is the handler being ready while the App
  // is missing a subscription — comments then vanish silently. Loud-warn on
  // any gap so the user fixes it before it bites them.
  void verifyAppEventSubscriptions();
});

startWorker();
startBountyKeeper();
backfillRepoIndex();

// Flush staged writes to Postgres on a clean exit so mutations still inside
// the debounce window aren't lost. Stop accepting new connections FIRST so no
// request can stage a fresh write during the drain (otherwise the listener stays
// open and a late write could miss the flush, then die on exit).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\n[server] ${signal} received — draining and flushing pending writes…`);
    try {
      server.close();
      closeAllStreams(); // end open SSE streams so clients reconnect to the next instance
      await Promise.all([shutdownDb(), shutdownStatsig()]);
    } catch (err) {
      console.error("[server] error during shutdown", err);
    }
    process.exit(0);
  });
}

// Cross-check the App's actual webhook event subscriptions against what we
// need to handle the full review surface. Soft-fail on network errors so a
// transient GitHub blip can't take startup down.
const REQUIRED_APP_EVENTS = [
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
];
async function verifyAppEventSubscriptions(): Promise<void> {
  const name = config.github.appName;
  if (!name) return;
  try {
    const resp = await fetch(`https://api.github.com/apps/${name}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "devasign-app",
      },
    });
    if (!resp.ok) {
      console.warn(`[startup] couldn't query App "${name}" subscriptions: HTTP ${resp.status}`);
      return;
    }
    const data = (await resp.json()) as { events?: string[] };
    const events = Array.isArray(data.events) ? data.events : [];
    const missing = REQUIRED_APP_EVENTS.filter((e) => !events.includes(e));
    if (missing.length === 0) {
      console.log(`  · App events: ${events.join(", ")} (all required ✓)`);
      return;
    }
    console.warn("");
    console.warn(`⚠  GitHub App "${name}" is missing webhook event subscriptions:`);
    for (const e of missing) console.warn(`     · ${e}`);
    console.warn(`   Without these, the matching webhooks never reach this server`);
    console.warn(`   (the handlers will look correct but never fire). Visit:`);
    console.warn(`     https://github.com/settings/apps/${name}/permissions`);
    console.warn(`   and check the boxes under "Subscribe to events".`);
    console.warn("");
  } catch (err) {
    console.warn(`[startup] couldn't query App "${name}" subscriptions:`, err);
  }
}

// Existing repositories may pre-date the indexer. Walk them at boot and
// enqueue a full build for any that have never been indexed, throttled so a
// DB with many repos doesn't stampede the LLM in the first minute.
function backfillRepoIndex() {
  const repos = db.filter("repositories", (r) => (r.indexState ?? "none") === "none" && r.reviewsEnabled);
  if (!repos.length) return;
  console.log(`  · Repo index: backfilling ${repos.length} repo${repos.length === 1 ? "" : "s"}`);
  let i = 0;
  for (const r of repos) {
    setTimeout(() => {
      db.update("repositories", (x) => x.id === r.id, { indexState: "queued" });
      enqueueIndex({ repoId: r.id, full: true });
    }, i * 5_000);
    i++;
  }
}
