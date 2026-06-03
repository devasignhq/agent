// Linear OAuth — connects an already-signed-in DevAsign user's Linear workspace.
// Unlike GitHub OAuth (which establishes identity), this attaches a workspace
// token to the current user as an Integration row, then registers a webhook so
// opened tickets flow in. Mirrors github/oauth.ts (state CSRF map + redirect_uri
// derived from the request host).
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { config, isLinearOAuthConfigured } from "../config.js";
import { db } from "../db.js";
import { getSessionUser } from "../github/oauth.js";
import { fetchLinearWorkspace, type LinearWorkspace } from "./client.js";
import { planForUser } from "../billing/plans.js";

const STATE_TTL_MS = 5 * 60 * 1000;
// state -> the DevAsign user who started the connect. Binding the userId here
// (rather than relying on the session cookie surviving the redirect) makes the
// callback robust even if the browser drops the cookie on the cross-site hop.
const pendingState = new Map<string, { userId: string; expiresAt: number }>();

function pruneState() {
  const now = Date.now();
  for (const [k, v] of pendingState) if (v.expiresAt < now) pendingState.delete(k);
}

// read → ingest ticket context; write → post the notification comment. Webhook
// creation may need a broader scope depending on the Linear app config; we keep
// registration best-effort so a scope gap doesn't block the connection.
const SCOPES = "read,write";

export function startLinearOAuth(req: Request, res: Response) {
  if (!isLinearOAuthConfigured()) {
    res.status(503).json({
      error: "linear_oauth_not_configured",
      message: "Set LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET in .env",
    });
    return;
  }
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not_signed_in" });
    return;
  }
  // Linear integration + acceptance-criteria sync is a Pro/Max feature. The
  // frontend hides the connect button for free users; this is the backstop.
  if (planForUser(user.id) === "free") {
    res.status(403).json({
      error: "upgrade_required",
      message: "Linear integration is available on Pro and Max. Upgrade to connect your workspace.",
    });
    return;
  }
  pruneState();
  const state = uuid();
  pendingState.set(state, { userId: user.id, expiresAt: Date.now() + STATE_TTL_MS });
  const redirect = `${req.protocol}://${req.get("host")}/api/auth/linear/callback`;
  const u = new URL("https://linear.app/oauth/authorize");
  u.searchParams.set("client_id", config.linear.oauthClientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  // Attribute the app's comments + webhook to DevAsign, not the authorizing user.
  // Linear's current OAuth docs use actor=app for app/service-account-attributed
  // tokens; actor=application is the deprecated legacy value.
  u.searchParams.set("actor", "app");
  res.redirect(u.toString());
}

export async function finishLinearOAuth(req: Request, res: Response) {
  const { code, state } = req.query as { code?: string; state?: string };
  const entry = state ? pendingState.get(state) : undefined;
  if (!code || !state || !entry) {
    res.status(400).send("Invalid OAuth state");
    return;
  }
  pendingState.delete(state);
  const userId = entry.userId;
  const redirect = `${req.protocol}://${req.get("host")}/api/auth/linear/callback`;

  // Token exchange (form-encoded per Linear's OAuth spec).
  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.linear.oauthClientId,
      client_secret: config.linear.oauthClientSecret,
      redirect_uri: redirect,
      code,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) {
    console.warn(
      "[linear] token exchange failed:",
      tokenRes.status,
      await tokenRes.text().catch(() => "")
    );
    return void res.redirect(`${config.webOrigin}/?linear=error`);
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenBody.access_token;
  if (!accessToken) return void res.redirect(`${config.webOrigin}/?linear=error`);

  // Workspace identity — labels the integration in the UI and routes inbound
  // webhooks back to this row (matched by organizationId).
  let workspace: LinearWorkspace | null = null;
  try {
    workspace = await fetchLinearWorkspace(accessToken);
  } catch (err) {
    console.warn("[linear] workspace lookup failed:", err);
  }

  // One Linear integration per user. Re-connecting just refreshes the token.
  // Webhooks are delivered by the app-level webhook configured in the Linear
  // dashboard (one URL + one signing secret), so there's nothing to register
  // per-connect — we only need to remember the workspace's organizationId so
  // inbound webhooks route back to this user's token.
  const existing = db.find(
    "integrations",
    (i) => i.userId === userId && i.type === "linear"
  );
  const workspaceMeta: Record<string, string> = {
    organizationId: workspace?.organizationId || "",
    workspaceName: workspace?.workspaceName || "",
    urlKey: workspace?.urlKey || "",
  };
  const tokens: Record<string, string> = { accessToken };

  if (existing) {
    db.update("integrations", (i) => i.id === existing.id, { tokens, workspaceMeta });
  } else {
    db.insert("integrations", {
      id: uuid(),
      userId,
      type: "linear",
      tokens,
      workspaceMeta,
      createdAt: Date.now(),
    });
  }
  console.log(
    `[linear] connected workspace "${workspace?.workspaceName || "?"}" for user ${userId}`
  );

  res.redirect(`${config.webOrigin}/?linear=connected`);
}
