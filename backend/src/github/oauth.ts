// GitHub OAuth — identifies the human user (separate from the GitHub App which
// holds repo permissions). See devasign.md §4: "OAuth ≠ GitHub App".
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { config, isGithubOAuthConfigured } from "../config.js";
import { db } from "../db.js";
import type { User } from "../types.js";

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingState = new Map<string, number>(); // state -> expiresAt

function pruneState() {
  const now = Date.now();
  for (const [k, exp] of pendingState) if (exp < now) pendingState.delete(k);
}

// Session cookie attributes. In prod the dashboard (www.devasign.ai) and API
// (api.devasign.ai) are different hosts, so the cookie must be SameSite=None;
// Secure to ride along on the cross-origin XHR — both share devasign.ai, so it
// stays first-party. Locally we're on http://localhost where None/Secure is
// invalid, so fall back to Lax. Setting and clearing must use identical
// attributes or the browser won't overwrite the existing cookie.
function sessionCookieOptions() {
  const secure = config.secureCookies;
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function startOAuth(req: Request, res: Response) {
  if (!isGithubOAuthConfigured()) {
    res.status(503).json({
      error: "github_oauth_not_configured",
      message: "Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET in .env",
    });
    return;
  }
  pruneState();
  const state = uuid();
  pendingState.set(state, Date.now() + STATE_TTL_MS);
  const redirect = `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", config.github.oauthClientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
}

export async function finishOAuth(req: Request, res: Response) {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || !pendingState.has(state)) {
    res.status(400).send("Invalid OAuth state");
    return;
  }
  pendingState.delete(state);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.oauthClientId,
      client_secret: config.github.oauthClientSecret,
      code,
    }),
  });
  if (!tokenRes.ok) {
    res.status(502).send(`token exchange failed: ${tokenRes.status}`);
    return;
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenBody.access_token) {
    res.status(502).send("missing access_token in response");
    return;
  }

  const meRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "devasign-app" },
  });
  const me = (await meRes.json()) as {
    id: number;
    login: string;
    email: string | null;
    avatar_url?: string;
  };

  // Find-or-create
  let user = db.find("users", (u) => u.githubId === me.id);
  if (!user) {
    user = {
      id: uuid(),
      githubId: me.id,
      githubLogin: me.login,
      email: me.email || `${me.login}@users.noreply.github.com`,
      avatarUrl: me.avatar_url,
      plan: "free",
      createdAt: Date.now(),
    } satisfies User;
    db.insert("users", user);
    db.insert("subscriptions", {
      id: uuid(),
      userId: user.id,
      plan: "free",
      credits: 50,
      autoRefill: false,
      stripeCustomerId: null,
    });
  }

  db.insert("authAudit", {
    id: uuid(),
    userId: user.id,
    at: Date.now(),
    event: "signin",
    meta: { via: "github_oauth" },
  });

  // Trivial session cookie (signed in dev; replace with real session store in prod)
  const session = Buffer.from(`${user.id}:${Date.now()}`).toString("base64url");
  res.cookie("devasign_session", session, sessionCookieOptions());
  // Land on a sentinel URL so the popup handshake in main.tsx can detect a
  // successful sign-in and signal the opener. For top-level (non-popup)
  // navigation the frontend just strips the query and renders normally.
  res.redirect(`${config.webOrigin}/?auth=ok`);
}

export function getSessionUser(req: Request): User | null {
  const raw = req.cookies?.devasign_session;
  if (!raw) return null;
  try {
    const [userId] = Buffer.from(raw, "base64url").toString("utf8").split(":");
    return db.find("users", (u) => u.id === userId);
  } catch {
    return null;
  }
}

export function signOut(_req: Request, res: Response) {
  // clearCookie only overwrites the cookie when path/sameSite/secure match how
  // it was set; reuse the same attributes (maxAge is irrelevant when clearing).
  const { maxAge: _ignored, ...clearOpts } = sessionCookieOptions();
  res.clearCookie("devasign_session", clearOpts);
  res.json({ ok: true });
}
