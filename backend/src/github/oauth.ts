// GitHub OAuth — identifies the human user (separate from the GitHub App which
// holds repo permissions). See devasign.md §4: "OAuth ≠ GitHub App".
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { config, isGithubOAuthConfigured, isStripeConfigured } from "../config.js";
import { db } from "../db.js";
import type { User } from "../types.js";
import { addInstallMember } from "./installations.js";
import { reconcileSubscriptionFromStripe } from "../billing/stripe.js";
import { track } from "../statsig.js";

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
// A session lives 7 days. Both the JWT's exp claim and the cookie's maxAge are
// derived from this one constant so the token and the cookie can't drift apart.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sessionCookieOptions() {
  const secure = config.secureCookies;
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

// The session cookie's value is a JWT signed with SESSION_SECRET (HS256). The
// signature makes it unforgeable, and the exp claim makes expiry tamper-proof —
// a client can't extend its own session by editing a timestamp the way the old
// plain `userId:ts` cookie allowed. Exported so the tests and the ephemeral-dev
// script mint cookies through the same path the server verifies.
export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, config.sessionSecret, {
    algorithm: "HS256",
    expiresIn: SESSION_TTL_SECONDS,
  });
}

// The user id from a valid, unexpired token, or null. Verifies against the
// current secret first, then any SESSION_SECRET_PREVIOUS entry, so a secret
// rotation doesn't drop live sessions. algorithms is pinned to HS256 so a
// forged `alg: none` (or algorithm-confusion) token can never verify.
function verifySession(token: string): string | null {
  for (const secret of [config.sessionSecret, ...config.sessionSecretPrevious]) {
    try {
      const { sub } = jwt.verify(token, secret, { algorithms: ["HS256"] }) as {
        sub?: string;
      };
      if (typeof sub === "string" && sub) return sub;
    } catch {
      // wrong/old secret, or an expired or forged token — try the next secret
    }
  }
  return null;
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
  // Bind the state to *this* browser (login-CSRF defense). The pending-state map
  // alone can't distinguish the browser that started the flow from a victim's:
  // an attacker could start the flow, capture a valid (code, state), and replay
  // it in a victim's session to log them into the attacker's account. The cookie
  // lands in the attacker's browser, not the victim's, so finishOAuth's
  // state-must-equal-cookie check rejects the replay. SameSite=Lax is sufficient
  // and correct — the GitHub callback is a top-level GET navigation, which still
  // sends Lax cookies, while keeping the cookie off cross-site subrequests.
  res.cookie("github_oauth_state", state, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_MS,
  });
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
  // Login-CSRF guard: the state must be live in our map AND equal the cookie we
  // set on the browser that started the flow (see startOAuth). The map check
  // alone can't tell the victim's browser from the attacker's.
  const cookieState = req.cookies?.github_oauth_state;
  if (!code || !state || !pendingState.has(state) || state !== cookieState) {
    res.status(400).send("Invalid OAuth state");
    return;
  }
  pendingState.delete(state);
  // One-shot: clear the state cookie (same attributes as set, minus maxAge, or
  // the browser won't overwrite it) so a stale value can't linger.
  res.clearCookie("github_oauth_state", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
  });

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
  let isNewUser = false;
  let user = db.find("users", (u) => u.githubId === me.id);
  if (!user) {
    isNewUser = true;
    // Anti-masquerade / self-heal: if this browser still presents a validly-signed
    // session for a user id that no longer exists, the person isn't actually new —
    // their row went missing (account deletion, or a store wiped on redeploy).
    // Recreate them under that ORIGINAL id rather than minting a fresh uuid, so any
    // user-scoped rows that survived re-link to them instead of being orphaned
    // behind a brand-new identity. Safe: the id comes from a token we signed
    // (HS256, httpOnly), so it can only be this browser's own prior id — and if the
    // store really was wiped there's nothing left to mis-link to anyway.
    const recoveredId = peekSessionUserId(req);
    const reuseId = !!recoveredId && !db.find("users", (u) => u.id === recoveredId);
    const newId = reuseId ? recoveredId! : uuid();
    if (reuseId) {
      console.error(
        `[oauth] ⚠ recreating user ${me.login} (github ${me.id}) under its prior id ${newId} — ` +
          `a valid session pointed at a missing account. Likely an account deletion, or DATA LOSS ` +
          `(store wiped on redeploy). Check /api/health rowsLoadedAtBoot.`
      );
    }
    // Don't mint a duplicate-email row if a verified address already belongs to
    // another account; fall back to the per-login (unique) noreply instead.
    let email = resolvedEmail;
    if (isRealEmail(email) && emailTakenByOther(email, null)) {
      console.warn(`[oauth] ${email} already in use; new user ${me.login} gets noreply`);
      email = `${me.login}@users.noreply.github.com`;
    }
    user = {
      id: newId,
      githubId: me.id,
      githubLogin: me.login,
      email,
      avatarUrl: me.avatar_url,
      plan: "free",
      createdAt: Date.now(),
    } satisfies User;
    db.insert("users", user);
    // Reuse may re-link a subscription that outlived the user row; only seed a
    // fresh free subscription when none already exists for this id.
    if (!db.find("subscriptions", (s) => s.userId === user!.id)) {
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
    }
  } else {
    // Returning user: refresh fields that drift on GitHub's side. Batch into one
    // update so we only touch Stripe when the email actually changed.
    const updates: Partial<User> = {};
    if (isRealEmail(resolvedEmail) && resolvedEmail !== user.email) {
      // Backfill stale/noreply emails — but never downgrade a good address to a
      // noreply fallback (isRealEmail guards that), and never duplicate an
      // address another account already holds.
      if (emailTakenByOther(resolvedEmail, user.id)) {
        console.warn(`[oauth] skipping email backfill for user ${user.id}: ${resolvedEmail} already in use`);
      } else {
        updates.email = resolvedEmail;
      }
    }
    // Keep githubLogin fresh — a GitHub rename would otherwise leave it
    // permanently stale, which breaks org-membership checks that look the user
    // up by login (see authorizeInstallationClaim).
    if (me.login && me.login !== user.githubLogin) {
      updates.githubLogin = me.login;
    }
    if (Object.keys(updates).length > 0) {
      user = db.update("users", (u) => u.id === user!.id, updates) ?? user;
      if (updates.email) await syncStripeEmail(user);
    }
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

  // Adopt installations this user can access: their personal account, and any org
  // where they're an owner/admin — so an org install set up by another owner shows
  // up on their account automatically. Uses the OAuth token (not persisted), which
  // is only in scope here. Best-effort: never block sign-in.
  try {
    await adoptUserInstallations(user, tokenBody.access_token);
  } catch (err) {
    console.warn(`[oauth] install adoption failed for user ${user.id}:`, err);
  }

  if (isNewUser) {
    track(user, "user signed up", { github_login: user.githubLogin });
  } else {
    track(user, "user signed in", { github_login: user.githubLogin });
  }

  db.insert("authAudit", {
    id: uuid(),
    userId: user.id,
    at: Date.now(),
    event: "signin",
    meta: { via: "github_oauth" },
  });

  // Session cookie: a JWT signed with SESSION_SECRET (HS256), unforgeable and
  // self-expiring — see signSession/verifySession above.
  const session = signSession(user.id);
  res.cookie("devasign_session", session, sessionCookieOptions());
  // Land on a sentinel URL so the popup handshake in main.tsx can detect a
  // successful sign-in and signal the opener. For top-level (non-popup)
  // navigation the frontend just strips the query and renders normally.
  res.redirect(`${config.webOrigin}/?auth=ok`);
}

// GitHub API call with the user-to-server OAuth token. Returns the parsed JSON,
// or null on any non-2xx / network error (callers degrade gracefully).
async function ghUser<T>(accessToken: string, path: string): Promise<T | null> {
  try {
    const resp = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devasign-app",
      },
    });
    if (!resp.ok) {
      // 404 on a membership check just means "not an admin / not visible" — quiet.
      if (resp.status !== 404) console.warn(`[oauth] GET ${path} → ${resp.status}`);
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    console.warn(`[oauth] GET ${path} failed:`, err);
    return null;
  }
}

// Is `user` an active owner/admin of `org`? Owners adopt org installs at signup.
async function isOrgAdmin(accessToken: string, org: string): Promise<boolean> {
  const m = await ghUser<{ state?: string; role?: string }>(
    accessToken,
    `/user/memberships/orgs/${encodeURIComponent(org)}`
  );
  return !!m && m.state === "active" && m.role === "admin";
}

// Link the signed-in user to every installation they can access: their personal
// account, plus any org where they're an owner/admin. Adding to the membership
// set (addInstallMember) never displaces the original installer. Repos are
// materialized lazily by the next /api/installations reconcile, so this stays a
// few quick API calls and keeps sign-in fast.
async function adoptUserInstallations(user: User, accessToken: string): Promise<void> {
  const body = await ghUser<{ installations?: any[] }>(
    accessToken,
    "/user/installations?per_page=100"
  );
  const installs = body?.installations || [];
  for (const inst of installs) {
    const account = inst.account || {};
    const accountType: "User" | "Organization" =
      account.type === "Organization" ? "Organization" : "User";

    let eligible = false;
    if (accountType === "User") {
      eligible = account.id === user.githubId; // their own personal account
    } else if (account.login) {
      eligible = await isOrgAdmin(accessToken, account.login); // org owner/admin only
    }
    if (!eligible) continue;

    const row = db.find("installations", (i) => i.installationId === inst.id);
    if (!row) {
      db.insert("installations", {
        id: uuid(),
        userId: user.id,
        userIds: [user.id],
        accountId: account.id,
        accountLogin: account.login,
        accountType,
        installationId: inst.id,
        repoIds: [],
      });
    } else {
      if (row.accountType !== accountType) {
        db.update("installations", (i) => i.id === row.id, { accountType });
      }
      addInstallMember(row.id, user.id);
    }
  }
}

export function getSessionUser(req: Request): User | null {
  const raw = req.cookies?.devasign_session;
  if (!raw) return null;
  const userId = verifySession(raw);
  if (!userId) return null;
  return db.find("users", (u) => u.id === userId);
}

// The user id a valid, unexpired session cookie *claims* — even when no matching
// user row exists. getSessionUser() returns null in both the "no/invalid cookie"
// and "valid cookie, missing user" cases, which are very different: the latter is
// a "ghost session", proof this browser held an account that's now gone (a legit
// deletion, or — the case we must not paper over — a store wiped on a redeploy).
// Callers use this to tell the two apart instead of funnelling a wipe into a
// fresh sign-up. Returns null only when there is genuinely no valid session.
export function peekSessionUserId(req: Request): string | null {
  const raw = req.cookies?.devasign_session;
  if (!raw) return null;
  return verifySession(raw);
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
