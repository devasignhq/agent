// GitHub OAuth — identifies the human user (separate from the GitHub App which
// holds repo permissions). See devasign.md §4: "OAuth ≠ GitHub App".
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { config, isGithubOAuthConfigured, isStripeConfigured } from "../config.js";
import { db } from "../db.js";
import type { User } from "../types.js";
import { isDeletionPending, restoreAccount } from "../account.js";
import { reconcileSubscriptionFromStripe } from "../billing/stripe.js";

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

// GitHub's GET /user only returns an email when the user has a public one; with
// "Keep my email addresses private" enabled it's null and we'd otherwise mint a
// useless ${login}@users.noreply.github.com address. The user:email scope (above)
// lets us read every address via GET /user/emails and pick the real, verified one.
type GithubEmail = { email: string; primary: boolean; verified: boolean; visibility: string | null };
const NOREPLY_SUFFIX = "@users.noreply.github.com";
const isRealEmail = (e: string | null | undefined): e is string =>
  !!e && !e.endsWith(NOREPLY_SUFFIX);

// Pure: the verified, non-noreply address (primary first), or null when there's no
// real one — the caller owns the noreply fallback. Exported for a quick unit check.
export function pickPrimaryEmail(emails: GithubEmail[]): string | null {
  const real = emails.filter((e) => typeof e.email === "string" && e.verified && isRealEmail(e.email));
  if (real.length === 0) return null;
  return (real.find((e) => e.primary) ?? real[0]).email;
}

// Best-effort: null on any failure so the caller falls back. Same fetch pattern as /user.
async function fetchPrimaryEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "devasign-app" },
    });
    if (!res.ok) return null;
    const emails = (await res.json()) as GithubEmail[];
    return Array.isArray(emails) ? pickPrimaryEmail(emails) : null;
  } catch {
    return null;
  }
}

// Keep the Stripe customer email aligned with our user record after a backfill.
// Dynamic import so this auth handler keeps no static dependency on billing, and
// fully swallowed so a Stripe hiccup can never block sign-in.
async function syncStripeEmail(user: User): Promise<void> {
  try {
    const { updateCustomerEmail } = await import("../billing/stripe.js");
    await updateCustomerEmail(user);
  } catch {
    /* best-effort; never block login */
  }
}

// True when a *different* user already holds this email — keeps the write path
// from minting duplicate-email rows (a verified GitHub address can migrate
// between accounts over time). There is no DB constraint; users are keyed by id.
const emailTakenByOther = (email: string, selfId: string | null): boolean =>
  !!db.find("users", (u) => u.email === email && u.id !== selfId);

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

  // Prefer the real, verified address from /user/emails; fall back to the public
  // profile email, then a synthetic noreply so new users always get *some* value.
  const resolvedEmail =
    (await fetchPrimaryEmail(tokenBody.access_token)) ||
    me.email ||
    `${me.login}@users.noreply.github.com`;

  // Find-or-create
  let user = db.find("users", (u) => u.githubId === me.id);
  if (!user) {
    // Don't mint a duplicate-email row if a verified address already belongs to
    // another account; fall back to the per-login (unique) noreply instead.
    let email = resolvedEmail;
    if (isRealEmail(email) && emailTakenByOther(email, null)) {
      console.warn(`[oauth] ${email} already in use; new user ${me.login} gets noreply`);
      email = `${me.login}@users.noreply.github.com`;
    }
    user = {
      id: uuid(),
      githubId: me.id,
      githubLogin: me.login,
      email,
      avatarUrl: me.avatar_url,
      plan: "free",
      createdAt: Date.now(),
    } satisfies User;
    db.insert("users", user);
    db.insert("subscriptions", {
      id: uuid(),
      userId: user.id,
      plan: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      reviewsUsed: 0,
      usagePeriodStart: Date.now(),
      pendingPlan: null,
      scheduleId: null,
    });
  } else if (isRealEmail(resolvedEmail) && resolvedEmail !== user.email) {
    // Backfill returning users whose stored email is stale/noreply — but never
    // downgrade a good address to a noreply fallback (isRealEmail guards that),
    // and never duplicate an address another account already holds.
    if (emailTakenByOther(resolvedEmail, user.id)) {
      console.warn(`[oauth] skipping email backfill for user ${user.id}: ${resolvedEmail} already in use`);
    } else {
      user = db.update("users", (u) => u.id === user!.id, { email: resolvedEmail }) ?? user;
      await syncStripeEmail(user);
    }
  }

  // If this account was pending deletion, logging in is the restore action:
  // clear the flag, resume billing, and surface the welcome-back pop-up. Code
  // review resumes automatically once the flag is gone (see account.ts).
  let restored = false;
  if (isDeletionPending(user)) {
    await restoreAccount(user);
    restored = true;
  }

  // Self-heal billing from Stripe: if our local row says "free" but Stripe has
  // this customer on a trial/active plan (card already on file), promote them now
  // rather than waiting for a webhook that won't replay. Covers a missed webhook
  // and — the common case — state lost when the store was wiped on a redeploy.
  // Best-effort: a Stripe hiccup must never block sign-in. Re-read the user since
  // a successful reconcile mirrors the new plan onto the user row.
  if (isStripeConfigured()) {
    try {
      await reconcileSubscriptionFromStripe(user);
      user = db.find("users", (u) => u.id === user!.id) ?? user;
    } catch (err) {
      console.error(`[oauth] stripe reconcile failed for user ${user.id}:`, err);
    }
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
  // welcome_back=1 lets a top-level restore show the pop-up; the durable signal
  // for the popup-login path is the welcomeBack flag on /api/me.
  res.redirect(`${config.webOrigin}/?auth=ok${restored ? "&welcome_back=1" : ""}`);
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

// Clear the session cookie. clearCookie only overwrites the cookie when
// path/sameSite/secure match how it was set; reuse the same attributes (maxAge
// is irrelevant when clearing). Shared by signOut and account deletion.
export function clearSessionCookie(res: Response): void {
  const { maxAge: _ignored, ...clearOpts } = sessionCookieOptions();
  res.clearCookie("devasign_session", clearOpts);
}

export function signOut(_req: Request, res: Response) {
  clearSessionCookie(res);
  res.json({ ok: true });
}
