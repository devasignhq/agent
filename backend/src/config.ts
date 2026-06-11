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

export const config = {
  port: Number(process.env.PORT || 8787),
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:5173",
  // Cross-site session cookies need SameSite=None; Secure, which is only valid
  // (and only wanted) once the dashboard is served over https — i.e. prod. In
  // local dev WEB_ORIGIN is http://localhost, so cookies stay SameSite=Lax.
  secureCookies: (process.env.WEB_ORIGIN || "").startsWith("https://"),
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-replace-me",
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
};

export const isDbConfigured = () => Boolean(config.databaseUrl);
export const isLLMLive = () => Boolean(config.llm.apiKey);
export const isGeminiLive = () => Boolean(config.gemini.apiKey);
export const isGithubOAuthConfigured = () =>
  Boolean(config.github.oauthClientId && config.github.oauthClientSecret);
export const isGithubAppConfigured = () =>
  Boolean(config.github.appId && config.github.privateKey);
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
