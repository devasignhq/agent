import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import helmet from "helmet";

import {
  config,
  isDiscordEnvConfigured,
  isGithubAppConfigured,
  isLLMLive,
  isSlackEnvConfigured,
  isStatsigConfigured,
} from "./config.js";
import { initStatsig, shutdownStatsig } from "./statsig.js";
import { startOAuth, finishOAuth, signOut } from "./github/oauth.js";
import { enforceSameOrigin } from "./csrf.js";
import { handleWebhook } from "./github/webhooks.js";
import { startLinearOAuth, finishLinearOAuth } from "./linear/oauth.js";
import { handleLinearWebhook } from "./linear/webhooks.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { api } from "./routes/api.js";
import { dedupePRReviews } from "./review/dedupe.js";
import { startWorker } from "./worker.js";
import { runDeletionSweep } from "./account.js";
import { db, initDb, shutdownDb } from "./db.js";
import { enqueueIndex } from "./queue.js";
import { authLimiter, globalLimiter } from "./rate-limit.js";

// Session cookies are JWTs signed with SESSION_SECRET; the default placeholder is
// public, so signing with it in prod would be no better than not signing at all.
// secureCookies (an https WEB_ORIGIN) is our prod signal — refuse to boot rather
// than mint forgeable sessions. Local/ephemeral dev runs over http, so unaffected.
if (config.secureCookies && config.sessionSecret === "dev-secret-replace-me") {
  throw new Error(
    "SESSION_SECRET must be set to a real secret in production (WEB_ORIGIN is https). " +
      "Refusing to boot with the 'dev-secret-replace-me' placeholder."
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

// Security headers on every response (HSTS, nosniff, frameguard, referrer
// policy, …). Two deviations from helmet's defaults, both because this is a
// JSON API consumed cross-origin by the SPA at WEB_ORIGIN (e.g. www.devasign.ai):
//   · contentSecurityPolicy off — a CSP belongs on the HTML host, not a JSON
//     API; helmet's default policy is meaningless here and only invites
//     confusion.
//   · crossOriginResourcePolicy: cross-origin — the default `same-origin` is the
//     wrong signal for a separate-origin client; relax it so the SPA is never
//     blocked from reading a response.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(morgan("dev"));
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(cookieParser());

// Broad per-IP flood shield, applied after CORS so handled preflights don't burn
// budget and before the webhook receivers below so they're covered too. This is
// the only throttle in front of the (HMAC-gated, but otherwise unauthenticated)
// webhook endpoints; per-IP is deliberately the right grain there — a flood
// comes from one source, while legitimate GitHub/Linear/Stripe deliveries arrive
// across many provider IPs and won't individually trip it. LLM-triggering routes
// get a much tighter bucket of their own (see rate-limit.ts / api.ts).
app.use(globalLimiter);

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
app.listen(port, () => {
  console.log(`DevAsign API listening on http://localhost:${port}`);
  console.log(`  · LLM:        ${isLLMLive() ? "live (Anthropic)" : "mock"}`);
  console.log(`  · GitHub App: ${isGithubAppConfigured() ? "configured" : "missing — webhook will still receive"}`);
  console.log(`  · Slack:      ${isSlackEnvConfigured() ? `env fallback → ${config.integrations.slackBotChannel}` : "per-user only"}`);
  console.log(`  · Discord:    ${isDiscordEnvConfigured() ? `env fallback → ${config.integrations.discordBotChannelId}` : "per-user only"}`);
  console.log(`  · Statsig:    ${isStatsigConfigured() ? `live (${config.statsig.environment})` : "disabled (no key)"}`);
  console.log(`  · Web origin: ${config.webOrigin}`);
  // Spell out which webhook event types the receiver handles. If a comment
  // posted on GitHub never shows up in stdout (or in the review log), the
  // first thing to verify is that the matching event here is also subscribed
  // in the GitHub App's settings on github.com → Permissions & events.
  console.log(
    `  · Webhooks:   accepting installation, installation_repositories, pull_request, issue_comment, pull_request_review, pull_request_review_comment, ping`
  );
  // Self-diagnose: ask GitHub which events the App is actually configured to
  // deliver. A common failure mode is the handler being ready while the App
  // is missing a subscription — comments then vanish silently. Loud-warn on
  // any gap so the user fixes it before it bites them.
  void verifyAppEventSubscriptions();
});

startWorker();
backfillRepoIndex();

// Sweep for accounts past their 14-day deletion window (purge) and send the
// day-12 reminder. Timestamp-driven so it's restart-safe; runs at boot and
// every 6 hours, with each account isolated in try/catch inside the sweep.
const DELETION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
void runDeletionSweep();
setInterval(() => void runDeletionSweep(), DELETION_SWEEP_INTERVAL_MS);
console.log("[account] deletion sweep scheduled (every 6h, 14-day restore window)");

// Flush staged writes to Postgres on a clean exit so mutations still inside
// the debounce window aren't lost.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`\n[server] ${signal} received — flushing pending writes…`);
    try {
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
