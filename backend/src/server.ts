import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";

import {
  config,
  isDiscordEnvConfigured,
  isGithubAppConfigured,
  isLLMLive,
  isSlackEnvConfigured,
} from "./config.js";
import { startOAuth, finishOAuth, signOut } from "./github/oauth.js";
import { handleWebhook } from "./github/webhooks.js";
import { api } from "./routes/api.js";
import { startWorker } from "./worker.js";

const app = express();

app.use(morgan("dev"));
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(cookieParser());

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

app.use(express.json({ limit: "1mb" }));

// Identity routes
app.get("/api/auth/github", startOAuth);
app.get("/api/auth/github/callback", finishOAuth);
app.post("/api/auth/signout", signOut);

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
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[server]", err);
  res.status(500).json({ error: "internal_error", message: err?.message || String(err) });
});

const port = config.port;
app.listen(port, () => {
  console.log(`DevAsign API listening on http://localhost:${port}`);
  console.log(`  · LLM:        ${isLLMLive() ? "live (Anthropic)" : "mock"}`);
  console.log(`  · GitHub App: ${isGithubAppConfigured() ? "configured" : "missing — webhook will still receive"}`);
  console.log(`  · Slack:      ${isSlackEnvConfigured() ? `env fallback → ${config.integrations.slackBotChannel}` : "per-user only"}`);
  console.log(`  · Discord:    ${isDiscordEnvConfigured() ? `env fallback → ${config.integrations.discordBotChannelId}` : "per-user only"}`);
  console.log(`  · Web origin: ${config.webOrigin}`);
});

startWorker();
