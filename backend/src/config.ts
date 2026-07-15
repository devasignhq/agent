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

export const config = {
  port: Number(process.env.PORT || 8787),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:5173",
  // Cross-site session cookies need SameSite=None; Secure, which is only valid
  // (and only wanted) once the dashboard is served over https — i.e. prod. In
  // local dev WEB_ORIGIN is http://localhost, so cookies stay SameSite=Lax.
  secureCookies: (process.env.WEB_ORIGIN || "").startsWith("https://"),
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-replace-me",
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
};

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
export const isStellarConfigured = () =>
  Boolean(
    config.stellar.rpcUrl &&
      config.stellar.contractId &&
      config.stellar.usdcSac &&
      config.stellar.adminSecret
  );
