import "dotenv/config";
import fs from "node:fs";

function loadPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  }
  return "";
}

// The platform's Stellar admin secret seed (S…), used to sign admin_release /
// admin_refund on the escrow contract (the backend acts as the trusted arbiter).
// Env-inline-or-file, mirroring loadPrivateKey above. This is the ONLY signing
// key the backend holds — funding + sponsor-approve are signed client-side with
// the sponsor's own Freighter wallet, so no per-user seeds ever touch the server.
function loadStellarKey(): string {
  if (process.env.STELLAR_ADMIN_SECRET) {
    return process.env.STELLAR_ADMIN_SECRET.trim();
  }
  if (process.env.STELLAR_ADMIN_SECRET_PATH) {
    return fs.readFileSync(process.env.STELLAR_ADMIN_SECRET_PATH, "utf8").trim();
  }
  return "";
}

// The fallback used when SESSION_SECRET is unset. Local dev only — it is in the
// repo, so it is public, and the boot guard in server.ts refuses to start a
// production deploy that is still signing with it.
export const DEV_SESSION_SECRET = "dev-secret-replace-me";

// Every session secret that is public knowledge: the dev fallback above and the
// placeholder .env.example ships. Signing with either is no better than not
// signing at all — anyone can mint a session cookie for any user id, or a bounty
// fund/cancel/approve link for any bounty (bounties/links.ts signs those with
// this same key). .env.example's value belongs here precisely because copying
// that file to a server is the likeliest way a real deploy ends up with a known
// secret; matching only the code default would let that path through.
const PUBLIC_SESSION_SECRETS = new Set([
  DEV_SESSION_SECRET,
  "replace-me-with-a-long-random-string",
]);

// A secret shorter than this can be ground offline against a captured cookie, so
// it's a boot failure. We *recommend* 32 (`randomBytes(32).toString("hex")` = 64
// hex chars) and only warn below it: 16+ chars of real randomness is already far
// out of brute-force range for HS256, and hard-failing at 32 would take a live
// deploy down on its next boot over a secret that is short but perfectly safe.
const MIN_SESSION_SECRET_LENGTH = 16;
const RECOMMENDED_SESSION_SECRET_LENGTH = 32;

export const config = {
  port: Number(process.env.PORT || 8787),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:5173",
  // The contributor (developer) app's origin — a second first-party frontend
  // (its deployed URL in prod; the Vite dev server on :3002 locally). Feeds
  // allowedWebOrigins() below (CORS + CSRF), the OAuth return-to-initiating-app
  // redirect, AND — because the two apps mint separate maintainer/contributor
  // accounts — the per-request choice of which session cookie (hence which
  // account) to resolve (see kindForRequest in github/oauth.ts). That last use
  // is an exact string compare, so a value that merely *resembles* the deployed
  // origin resolves the maintainer account rather than erroring: match the
  // scheme and host exactly, with no trailing slash.
  //
  // Deploying it under the same registrable domain as this API (e.g.
  // contributors.devasign.ai against api.devasign.ai) keeps the session cookie
  // first-party. Nothing here requires that — the allowlist is pure env — but on
  // an unrelated domain (*.vercel.app → *.onrender.com) the cookie is genuinely
  // third-party, which Safari blocks and Firefox partitions.
  contributorOrigin: process.env.CONTRIBUTOR_ORIGIN || "http://localhost:3002",
  // Cross-site session cookies need SameSite=None; Secure, which is only valid
  // (and only wanted) once the dashboard is served over https — i.e. prod. In
  // local dev WEB_ORIGIN is http://localhost, so cookies stay SameSite=Lax.
  secureCookies: (process.env.WEB_ORIGIN || "").startsWith("https://"),
  sessionSecret: process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  // Old session secrets, accepted for verification only (never for signing) so
  // rotating SESSION_SECRET doesn't invalidate every live session at once. Set
  // SESSION_SECRET to the new key and SESSION_SECRET_PREVIOUS to the old one(s),
  // comma-separated; drop the old entry after one session lifetime (7 days).
  sessionSecretPrevious: (process.env.SESSION_SECRET_PREVIOUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  github: {
    oauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
    appId: process.env.GITHUB_APP_ID || "",
    appName: process.env.GITHUB_APP_NAME || "devasign",
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET || "",
    // Explicit dev-only escape hatch: with no webhookSecret the receiver now
    // fails CLOSED; set ALLOW_UNSIGNED_WEBHOOKS=1 to accept unsigned events on
    // a local (non-https) server. Never honored when WEB_ORIGIN is https.
    allowUnsignedWebhooks: process.env.ALLOW_UNSIGNED_WEBHOOKS === "1",
    privateKey: loadPrivateKey(),
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-7",
  },
  // Gemini is used as a vision/video understanding model so Opus can reason
  // over Loom / YouTube / Vimeo references the user attached to a task.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-pro",
    // USD per 1M tokens, used only for the est-cost figure attached to analytics
    // events (Anthropic prices live in a table in llm.ts; Gemini's are env-driven
    // so a price change needs no code edit). Defaults to the public 2.5-pro rate.
    inputPerMTok: Number(process.env.GEMINI_INPUT_PER_MTOK || 1.25),
    outputPerMTok: Number(process.env.GEMINI_OUTPUT_PER_MTOK || 10),
  },
  // Linear OAuth — lets a user connect their whole Linear workspace so DevAsign
  // can ingest tickets (acceptance criteria) and post notification comments.
  // Distinct from the per-user `integrations.linearApiKey` env fallback below,
  // which is a single workspace-wide key for dev.
  linear: {
    oauthClientId: process.env.LINEAR_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.LINEAR_OAUTH_CLIENT_SECRET || "",
    // Public OAuth apps use a single app-level webhook (configured in the Linear
    // app settings, not per-connect): Linear delivers every install's events to
    // one URL signed with this one secret. Verify all inbound webhooks against it.
    webhookSigningSecret: process.env.LINEAR_WEBHOOK_SIGNING_SECRET || "",
  },
  integrations: {
    // Workspace-wide fallback. Used by broadcastVerdict() only when no
    // per-user Slack integration is configured in the DB.
    slackBotToken: process.env.SLACK_BOT_TOKEN || "",
    slackBotChannel: process.env.SLACK_BOT_CHANNEL || "",
    linearApiKey: process.env.LINEAR_API_KEY || "",
    discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
    discordBotChannelId: process.env.DISCORD_BOT_CHANNEL_ID || "",
  },
  // Stripe billing. Secret key + webhook signing secret + the recurring Price
  // IDs for each paid tier. When unset, billing routes 503 and the app still
  // boots (mirrors the GitHub-OAuth-not-configured fallback).
  //
  // Annual billing is additive: the *Annual price IDs are full-rate yearly
  // Prices and the 20% discount comes from annualCouponId (a percent_off:20
  // coupon applied to annual subs). All three are optional — when any is unset,
  // the annual option is hidden and the monthly tiers work unchanged.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    pricePro: process.env.STRIPE_PRICE_PRO || "",
    priceMax: process.env.STRIPE_PRICE_MAX || "",
    priceProAnnual: process.env.STRIPE_PRICE_PRO_ANNUAL || "",
    priceMaxAnnual: process.env.STRIPE_PRICE_MAX_ANNUAL || "",
    annualCouponId: process.env.STRIPE_COUPON_ANNUAL || "",
  },
  // Transactional email (Resend), used for the account-deletion lifecycle mails
  // (scheduled / day-12 reminder / final "wiped"). When RESEND_API_KEY is unset
  // the email helpers log a preview and no-op, so dev/tests need no provider —
  // the same graceful-degradation stance as Stripe/GitHub above.
  email: {
    resendApiKey: process.env.RESEND_API_KEY || "",
    from: process.env.EMAIL_FROM || "DevAsign <no-reply@devasign.ai>",
  },
  // Statsig server-side analytics + feature gates. When the key is unset the
  // client no-ops, so dev/tests need no provider (same stance as Stripe/email).
  statsig: {
    secretKey: process.env.STATSIG_SECRET_KEY || "",
    environment: process.env.STATSIG_ENVIRONMENT || "development",
  },
  // Neon/Postgres connection string. Source of truth for all persisted state.
  databaseUrl: process.env.DATABASE_URL || "",
  // App-level encryption for secrets stored at rest (integration tokens). 64 hex
  // chars = 32 bytes for AES-256-GCM. When unset the store degrades to plaintext
  // (the same graceful stance as Stripe/email/Statsig) and /api/health reports
  // the integrations column as "unconfigured". Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryption: {
    key: process.env.INTEGRATION_ENCRYPTION_KEY || "",
  },
  // Stellar / Soroban escrow for the bounty feature. When any of contractId /
  // usdcSac / adminSecret is unset the bounty routes 503 and the escrow keeper
  // no-ops (the same graceful-degradation stance as Stripe/LLM/Statsig above),
  // so dev/tests boot without a chain. Non-custodial: the backend holds ONLY the
  // admin seed (for admin_release/admin_refund); sponsors sign create_escrow /
  // release with their own Freighter wallet client-side.
  stellar: {
    network: process.env.STELLAR_NETWORK || "testnet",
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    // Deployed escrow contract id (C…) and the USDC Stellar Asset Contract id
    // (C…) it was initialized with. No public defaults — both are created at
    // deploy time (see the plan's testnet deploy steps).
    contractId: process.env.STELLAR_ESCROW_CONTRACT_ID || "",
    usdcSac: process.env.STELLAR_USDC_SAC_ID || "",
    adminSecret: loadStellarKey(),
    // Horizon, used only for the receiver USDC-trustline pre-check (a payout to a
    // classic account with no USDC trustline would trap on-chain). Optional: when
    // usdcIssuer is empty (e.g. a pure Soroban test token with no trustline model)
    // the check is skipped. usdcCode/usdcIssuer identify the CLASSIC asset the SAC
    // wraps, for that Horizon lookup.
    horizonUrl: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    usdcCode: process.env.STELLAR_USDC_CODE || "USDC",
    usdcIssuer: process.env.STELLAR_USDC_ISSUER || "",
    // Testnet account funding faucet, used only to bootstrap the admin account in
    // dev tooling; never on the request path.
    friendbotUrl: process.env.STELLAR_FRIENDBOT_URL || "https://friendbot.stellar.org",
  },
  // Verifier: runner auth (GitHub Actions OIDC) and branch timing.
  verify: {
    // Issuer/JWKS overrides are honoured only when NOT production-like (see
    // verify/oidc.ts) — they exist so a local run can present a dev-minted token.
    oidcIssuer: process.env.VERIFY_OIDC_ISSUER || "https://token.actions.githubusercontent.com",
    oidcJwksUrl: process.env.VERIFY_OIDC_JWKS_URL || "https://token.actions.githubusercontent.com/.well-known/jwks",
    oidcAudience: process.env.VERIFY_OIDC_AUDIENCE || "devasign",
    // How long the review branch waits at the join before reporting "pending".
    joinTimeoutMs: Number(process.env.VERIFY_JOIN_TIMEOUT_MS || 60_000),
    // Silence from a resolved runner past this settles the run as timed_out.
    runTimeoutMs: Number(process.env.VERIFY_RUN_TIMEOUT_MS || 60 * 60_000),
  },
  // Private S3-compatible bucket (Cloudflare R2) for run artifacts. When unset,
  // runs still verify but produce no recordings (artifacts are rejected as
  // storage_unconfigured) — same graceful stance as the other providers.
  artifacts: {
    endpoint: process.env.ARTIFACT_S3_ENDPOINT || "",
    bucket: process.env.ARTIFACT_S3_BUCKET || "",
    region: process.env.ARTIFACT_S3_REGION || "auto",
    accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.ARTIFACT_S3_SECRET_ACCESS_KEY || "",
    putUrlTtlSeconds: Number(process.env.ARTIFACT_PUT_URL_TTL_SECONDS || 900),
    getUrlTtlSeconds: Number(process.env.ARTIFACT_GET_URL_TTL_SECONDS || 300),
    // Dev-only file-backed store (refused when production-like): signed PUT/GET
    // served by this server from /v1/artifacts/local. Lets a local runner upload
    // recordings with no bucket. apiOrigin is the base those signed URLs use.
    localDir: process.env.ARTIFACT_LOCAL_DIR || "",
    apiOrigin: process.env.API_ORIGIN || `http://localhost:${Number(process.env.PORT || 8787)}`,
  },
};

// Every first-party web origin (sponsor dashboard + contributor app), deduped.
// The single source of truth for the CORS allowlist and the same-origin CSRF
// check — a new frontend origin gets added here and nowhere else.
export const allowedWebOrigins = (): string[] => [
  ...new Set([config.webOrigin, config.contributorOrigin].filter(Boolean)),
];

// Are we running a real deployment? Two independent signals, either of which is
// enough. An https WEB_ORIGIN is the convention the webhook/DB boot guards in
// server.ts already use, but it can't stand alone for the session guard: a deploy
// that forgets WEB_ORIGIN silently falls back to http://localhost:5173, which
// switches that signal off exactly when the guard matters most. NODE_ENV is set
// to "production" by Render (and most hosts), so it catches that case. Neither is
// set in local dev or under `npm test`, so both stay on the dev fallback.
export const isProductionLike = () =>
  config.secureCookies || process.env.NODE_ENV === "production";

/**
 * Why `secret` is unfit to sign production sessions, or null if it's usable.
 * Pure and exported so the boot guard and its tests share one definition of
 * "unusable" — see the constants above for the reasoning behind each rule.
 *
 * Every rule judges the TRIMMED value, because that is where the entropy is: a
 * secret pasted into a dashboard field with a stray trailing space is still the
 * public placeholder plus one guess, and " x " is one character of entropy, not
 * three. Note we validate the trimmed value but sign with the raw one — deliberate,
 * and not worth "fixing" by trimming config.sessionSecret at the source: that
 * would change the signing key under any deploy whose secret has stray
 * whitespace and log every user out. Judging trimmed is strictly conservative,
 * so the divergence can only reject secrets, never wave one through.
 */
export function sessionSecretProblem(secret: string): string | null {
  const trimmed = secret.trim();
  if (!trimmed) return "it is empty";
  if (PUBLIC_SESSION_SECRETS.has(trimmed)) {
    return `it is ${JSON.stringify(trimmed)}, a placeholder committed to this repo and therefore public`;
  }
  if (trimmed.length < MIN_SESSION_SECRET_LENGTH) {
    return `it is ${trimmed.length} characters; production requires at least ${MIN_SESSION_SECRET_LENGTH}`;
  }
  return null;
}

/** True when the secret is usable but shorter than we'd like — warn, don't fail. */
export const isSessionSecretShort = (secret: string) =>
  !sessionSecretProblem(secret) && secret.trim().length < RECOMMENDED_SESSION_SECRET_LENGTH;

/** The length the guard actually judged — trimmed, so warnings can't misreport it. */
export const sessionSecretLength = (secret: string) => secret.trim().length;

export const isDbConfigured = () => Boolean(config.databaseUrl);
// At-rest encryption for integration tokens. When false, seal/open no-op and
// tokens are stored in plaintext (dev/tests run this way).
export const isEncryptionConfigured = () => Boolean(config.encryption.key);
export const isLLMLive = () => Boolean(config.llm.apiKey);
export const isGeminiLive = () => Boolean(config.gemini.apiKey);
export const isGithubOAuthConfigured = () =>
  Boolean(config.github.oauthClientId && config.github.oauthClientSecret);
export const isGithubAppConfigured = () =>
  Boolean(config.github.appId && config.github.privateKey);
// Inbound GitHub webhooks are HMAC-signed with this secret; without it the
// receiver can't verify signatures and falls open. Enforced at boot (refuse in
// prod, warn in dev) in server.ts — separate from App config above, which is
// about the *outbound* App credentials.
export const isGithubWebhookConfigured = () => Boolean(config.github.webhookSecret);
export const isLinearOAuthConfigured = () =>
  Boolean(config.linear.oauthClientId && config.linear.oauthClientSecret);
export const isLinearWebhookConfigured = () => Boolean(config.linear.webhookSigningSecret);
export const isSlackEnvConfigured = () =>
  Boolean(config.integrations.slackBotToken && config.integrations.slackBotChannel);
export const isDiscordEnvConfigured = () =>
  Boolean(config.integrations.discordBotToken && config.integrations.discordBotChannelId);
// Transactional email. When false, the email helpers log a preview and no-op.
export const isEmailConfigured = () => Boolean(config.email.resendApiKey);
// Analytics. When false, track()/initStatsig() no-op and the app runs dark.
export const isStatsigConfigured = () => Boolean(config.statsig.secretKey);
// Paid checkout/portal need the secret key + both Price IDs. The webhook secret
// is checked separately at the webhook receiver.
export const isStripeConfigured = () =>
  Boolean(config.stripe.secretKey && config.stripe.pricePro && config.stripe.priceMax);
// Annual billing additionally needs both annual Price IDs + the discount coupon.
// Gated separately so the annual option only surfaces once it's fully set up.
export const isAnnualConfigured = () =>
  Boolean(
    isStripeConfigured() &&
      config.stripe.priceProAnnual &&
      config.stripe.priceMaxAnnual &&
      config.stripe.annualCouponId
  );
// Soroban escrow (bounties). Needs the RPC URL + the deployed contract & USDC
// SAC ids + the admin signing seed. When false, bounty routes 503 and the escrow
// keeper no-ops — the app still boots and every non-bounty feature is unaffected.
export const isArtifactStorageConfigured = () =>
  Boolean(
    config.artifacts.endpoint &&
      config.artifacts.bucket &&
      config.artifacts.accessKeyId &&
      config.artifacts.secretAccessKey
  );
export const isStellarConfigured = () =>
  Boolean(
    config.stellar.rpcUrl &&
      config.stellar.contractId &&
      config.stellar.usdcSac &&
      config.stellar.adminSecret
  );
