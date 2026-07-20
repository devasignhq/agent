// REST API for the frontend.
import express, { Router } from "express";
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { db, dbHealth } from "../db.js";
import type { RepoGuidanceItem, Repository, User } from "../types.js";
import { enqueueGuidanceIngest, enqueueIndex, enqueueMaintainerFeedback, enqueueReview } from "../queue.js";
import { clearSessionCookie, getSessionUser, peekSessionUserId } from "../github/oauth.js";
import { appJWT, gh, getOrgMembership } from "../github/app.js";
import { addInstallMember, installationsForUser, userInInstall } from "../github/installations.js";
import { config, isAnnualConfigured, isDbConfigured, isGithubAppConfigured, isLLMLive, isStellarConfigured, isStripeConfigured } from "../config.js";
import { postBugFixCommentForAttachment } from "../review/pipeline.js";
import { advancedChanged, effectiveWorkflow, normalizeWorkflow } from "../review/workflow.js";
import { fetchLinearTeams, validateLinearToken } from "../linear/client.js";
import { parseIntegrationInput } from "../integrations/validate.js";
import { detectVideoProvider } from "../llm.js";
import { isObviouslyNonPublicHost } from "../ssrf.js";
import { cancelScheduledChange, changePlan, createCheckoutSession, createPortalSession } from "../billing/stripe.js";
import { defaultDeletionDeps, purgeAccount, type DeletionDeps } from "../account.js";
import { chargeForNewPRReview, effectivePlan, intervalOf, planForUser, PLAN_LIMITS, type Interval } from "../billing/plans.js";
import { shouldAutoReviewOpenedPR } from "../review/eligibility.js";
import {
  markAllRead,
  notificationsForUser,
  notifyForReview,
  unreadCountForUser,
} from "../notifications.js";
import { addClient, removeClient } from "../notifications-stream.js";
import { sanitizeTabId } from "../request-context.js";
import { track } from "../statsig.js";
import { expensiveLimiter } from "../rate-limit.js";

export const api = Router();

// --- Identity ---

// Exported for unit tests (the ghost-session / data-loss branch below); the
// route binds it directly. See deleteAccountHandler for the same pattern.
export function meHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) {
    // Distinguish a genuine sign-out from a "ghost session": a validly-signed,
    // unexpired cookie whose user row is gone. If the entire users table is empty
    // we almost certainly lost data (a store wiped on redeploy), so surface it as
    // a temporary outage (503) rather than letting it masquerade as "signed out".
    // Masquerading sends the user to the sign-in screen, where re-auth would mint
    // a fresh account and orphan everything we're trying to recover. Keep the
    // cookie so the session re-resolves itself once the store is back.
    // Gate on isDbConfigured(): only treat an empty users table as data loss when
    // a real DB is meant to persist. In ephemeral mode (no DATABASE_URL, local
    // dev) the in-memory store is wiped on every restart BY DESIGN, so an empty
    // table is expected — a 503 there would trap the developer on the "account
    // unavailable" screen with no path back to sign-in. Then it's a normal 401.
    const ghostId = peekSessionUserId(req);
    if (ghostId && db.table("users").length === 0 && isDbConfigured()) {
      console.error(
        `[me] ghost session for user ${ghostId} but the users table is EMPTY — likely DATA LOSS ` +
          `(store wiped on redeploy). Returning 503 (account_unavailable), NOT signing the user out. ` +
          `Check /api/health rowsLoadedAtBoot.`
      );
      res.status(503).json({ error: "account_unavailable" });
      return;
    }
    // No valid token, or a healthy store where only this row is gone (e.g. the
    // account was deleted on another device): a genuine signed-out state. Clear
    // any stale ghost cookie so it can't keep resolving to nothing.
    if (ghostId) clearSessionCookie(res);
    res.status(401).json({ error: "not_signed_in" });
    return;
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  res.json({ user, subscription: sub });
}
api.get("/me", meHandler);

// Delete the signed-in user's account immediately and permanently: run the full
// teardown (cancel billing, uninstall the App, wipe every row — see account.ts:
// purgeAccount) and clear the session. There is no restore window and no
// confirmation email; once this returns the account is gone. The final "account
// deleted" notice asks the user to revoke the "Authorized GitHub Apps" OAuth
// grant themselves — we never store their token, so we can't.
//
// Exported with injectable deps so unit tests can assert the teardown without
// calling Stripe/email; the route binds the real ones.
export async function deleteAccountHandler(
  req: Request,
  res: Response,
  deps: DeletionDeps = defaultDeletionDeps
) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });

  await purgeAccount(user.id, deps);

  // Clear the session cookie (same attributes as signOut, or the browser won't
  // overwrite it). The account no longer exists, so the user is signed out.
  clearSessionCookie(res);
  res.json({ ok: true });
}

// Wrap so Express's (req, res, next) never leaks `next` into the deps slot —
// the route always runs with the real implementations.
api.delete("/me", (req, res) => deleteAccountHandler(req, res));

api.get("/health", (_req, res) => {
  const write = dbHealth();
  res.json({
    ok: true,
    llm: isLLMLive() ? "live" : "mock",
    githubApp: isGithubAppConfigured() ? "configured" : "missing",
    githubAppName: config.github.appName,
    // "ephemeral" means DATABASE_URL is unset → all rows (incl. subscriptions)
    // are wiped on every restart/redeploy. Prod must read "postgres".
    db: isDbConfigured() ? "postgres" : "ephemeral",
    // At-rest encryption for integration tokens. "unconfigured" = a real DB is
    // connected but INTEGRATION_ENCRYPTION_KEY is unset, so tokens are written in
    // PLAINTEXT. Prod must read "ok" (set the key, then redeploy — see config.ts).
    encryption: write.encryption,
    // Soroban escrow (bounties). "live" once the contract/USDC-SAC ids + admin
    // seed are set; "unconfigured" means the bounty routes 503 and the keeper
    // no-ops. Non-bounty features are unaffected either way.
    stellar: isStellarConfigured() ? "live" : "unconfigured",
    // Write-through health. `writeThrough: "degraded"` (or quarantinedRows > 0,
    // or a growing pendingWrites) means writes aren't reaching Postgres and the
    // in-memory snapshot is drifting ahead of it — the next restart will lose
    // the unpersisted rows. This is the at-a-glance signal that what bit us in
    // prod is happening again.
    writeThrough: write.writeThrough,
    pendingWrites: write.pendingWrites,
    quarantinedRows: write.quarantinedRows,
    lastFlushError: write.lastFlushError,
    // How many rows loadAll() pulled from Postgres when this process booted, and
    // when it booted. After a deploy, a `rowsLoadedAtBoot` of 0 (or far below the
    // prior value) on a DB that should have data is the at-a-glance signal that
    // the store came up empty — i.e. the "wiped on redeploy" symptom, caught.
    rowsLoadedAtBoot: write.rowsLoadedAtBoot,
    bootedAt: write.bootedAt,
  });
});

// --- Installations / Repositories ---

api.get("/installations", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  // Auto-discover: query GitHub for all installs of the App and adopt any
  // owned by accounts the current user can access. This recovers installs
  // that were missed (e.g. webhook delivery failure, JWT broken at the time,
  // or popup never made it back to our origin).
  //
  // `?fast=1` lets the Settings → Installation page paint immediately from
  // the local DB: the reconcile still runs but as a background side-effect
  // so the request returns in a single LAN round-trip. The frontend triggers
  // a second (non-fast) call once mounted to pick up whatever the background
  // reconcile turned up.
  if (req.query.fast === "1") {
    void reconcileInstallsForUser(user).catch((err) =>
      console.warn("[installations] background reconcile failed:", err)
    );
  } else {
    await reconcileInstallsForUser(user).catch((err) =>
      console.warn("[installations] reconcile failed:", err)
    );
  }
  // `shared` flags an org install the current user didn't originally create —
  // they have access because another org owner installed it. The onboarding repo
  // browser surfaces a banner for these so a new owner isn't confused to find the
  // App already installed.
  res.json(
    installationsForUser(user.id).map((i) => ({
      ...i,
      shared: i.userId !== user.id && i.accountType === "Organization",
    }))
  );
});

// Pulls all installations the App can see from GitHub and:
//   - claims any matching the current user (by account.id === user.githubId,
//     or by membership the user can confirm — we only auto-claim the user's
//     own personal account here, which is the safe default);
//   - materialises Repository rows for each granted repo.
async function reconcileInstallsForUser(user: { id: string; githubId: number | null; githubLogin: string }) {
  if (!user.githubId) return;
  let apps: Array<any> = [];
  try {
    const resp = await fetch("https://api.github.com/app/installations", {
      headers: {
        Authorization: `Bearer ${appJWT()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devasign-app",
      },
    });
    if (!resp.ok) {
      console.warn("[reconcile] /app/installations failed:", resp.status, await resp.text());
      return;
    }
    apps = (await resp.json()) as any[];
  } catch (err) {
    console.warn("[reconcile] fetch failed:", err);
    return;
  }

  // Materialize installs the user can access: their personal account, plus any
  // org install they already belong to (adopted at signup in finishOAuth, or
  // linked explicitly). Org installs they DON'T yet belong to are left alone —
  // adoption is gated on owner/admin role at signin, not discovered here.
  const eligible = apps.filter((inst) => {
    if (inst?.account?.id === user.githubId) return true; // personal
    const row = db.find("installations", (i) => i.installationId === inst?.id);
    return row ? userInInstall(row, user.id) : false; // already a member
  });

  // Up-front DB writes for each eligible install — single-threaded reads/writes
  // against the in-memory DB stay deterministic this way. The slow part —
  // /installation/repositories — runs in parallel below.
  const rows = eligible.map((inst) => {
    let row = db.find("installations", (i) => i.installationId === inst.id);
    const accountType: "User" | "Organization" =
      inst.account?.type === "Organization" ? "Organization" : "User";
    if (!row) {
      row = {
        id: uuid(),
        userId: user.id,
        userIds: [user.id],
        accountId: inst.account.id,
        accountLogin: inst.account.login,
        accountType,
        installationId: inst.id,
        repoIds: [],
      };
      db.insert("installations", row);
    } else {
      // Ensure membership + backfill accountType on the existing row.
      addInstallMember(row.id, user.id);
      if (row.accountType !== accountType) {
        db.update("installations", (i) => i.id === row!.id, { accountType });
      }
      row = db.find("installations", (i) => i.id === row!.id) || row;
    }
    return { inst, row };
  });

  // Fan out the per-install repo fetches. Each round-trip is independent;
  // running them in parallel cuts reconcile time from sum-of-latencies to
  // max(latencies) for multi-install users.
  await Promise.all(
    rows.map(async ({ inst, row }) => {
      try {
        const reposResp = await gh<any>(inst.id, "/installation/repositories?per_page=100");
        const repos = reposResp?.repositories || [];
        const ids = repos.map((r: any) => r.id);
        db.update("installations", (i) => i.id === row.id, { repoIds: ids });
        for (const r of repos) {
          const [owner, name] = String(r.full_name || "").split("/");
          if (!owner || !name) continue;
          const existing = db.find(
            "repositories",
            (x) => x.owner === owner && x.name === name
          );
          if (existing) {
            const visChanged = typeof r.private === "boolean" && existing.private !== r.private;
            if (existing.installationId !== row.id || visChanged) {
              db.update("repositories", (x) => x.id === existing.id, {
                installationId: row.id,
                ...(typeof r.private === "boolean" ? { private: r.private } : {}),
              });
            }
            continue;
          }
          const inserted = db.insert("repositories", {
            id: uuid(),
            installationId: row.id,
            owner,
            name,
            defaultBranch: r.default_branch || "main",
            private: Boolean(r.private),
            defaultModel: "claude-opus-4-7",
            modelOverrides: {},
            reviewsEnabled: true,
            indexState: "queued",
          });
          enqueueIndex({ repoId: inserted.id, full: true });
        }
      } catch (err) {
        console.warn(`[reconcile] repos for ${inst.id} failed:`, err);
      }
    })
  );
}

// Authorize a claim of `account`'s installation by `user`. Personal installs
// require the account to *be* the user (account.id === their GitHub id); org
// installs require an active org membership that resolves back to the user's
// GitHub id (so a since-changed login now belonging to someone else can't
// pass). `fetchMembership` is injected so this is unit-testable without network.
// Anything we can't positively verify returns false (→ 403).
export async function authorizeInstallationClaim(
  user: User,
  account: { id?: number; login?: string; type?: string } | null | undefined,
  fetchMembership: (
    org: string,
    username: string
  ) => Promise<{ state: string; role: string; userId: number } | null>
): Promise<boolean> {
  if (!account || typeof account.id !== "number") return false; // can't verify → deny
  // Personal: the installation is on the caller's own account.
  if (account.id === user.githubId) return true;
  // Org: caller must be an *active* member (member or admin) whose membership
  // resolves to their GitHub id.
  if (account.type === "Organization" && account.login && user.githubLogin) {
    const m = await fetchMembership(account.login, user.githubLogin);
    return !!m && m.state === "active" && m.userId === user.githubId;
  }
  return false;
}

// Used by the onboarding GitHub-install screen to link a pending install to
// the signed-in user. Normally the install webhook lands first and leaves
// userId="" — but the popup-handshake can outrace the webhook (especially via
// smee in dev), so we also pull live install + repo data from GitHub here
// using the App's installation token. That way the onboarding repo browser
// never has to wait for a webhook to arrive.
//
// Claiming is ownership-gated (authorizeInstallationClaim): only the personal
// owner, or a verified active org member, may link an installation. Without
// this, any signed-in user could claim any installation id by enumeration and
// read its private-repo reviews / change its settings.
export async function linkInstallationHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const id = Number(req.params.installationId);

  let install = db.find("installations", (i) => i.installationId === id);

  // Fetch live install metadata from GitHub — its `account` is what we verify
  // ownership against, so we can't proceed without it. (Also self-corrects
  // stale rows from a prior install.)
  let liveInstall: any = null;
  try {
    // /app/installations/{id} is an App-level endpoint: it requires the App JWT
    // (Bearer), NOT an installation token, so we fetch directly rather than via
    // gh() (same pattern as reconcileInstallsForUser / uninstallApp).
    const resp = await fetch(`https://api.github.com/app/installations/${id}`, {
      headers: {
        Authorization: `Bearer ${appJWT()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devasign-app",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
    liveInstall = await resp.json();
  } catch (err) {
    // Couldn't reach GitHub. Without live account data we can't verify
    // ownership, so fail closed: 404 when there's no row at all (as before),
    // 502 when a row exists but we can't re-verify the claim right now.
    console.warn("[link] couldn't reach GitHub:", err);
    return void res
      .status(install ? 502 : 404)
      .json({ error: install ? "verification_unavailable" : "install_not_found" });
  }

  // Ownership gate — reject anyone who isn't the personal owner or a verified
  // active org member of the account behind this installation.
  const authorized = await authorizeInstallationClaim(
    user,
    liveInstall?.account,
    (org, username) => getOrgMembership(id, org, username)
  );
  if (!authorized) return void res.status(403).json({ error: "forbidden" });

  // Authorized — now pull the repo list (skipped above so we never hit GitHub
  // for, or leak the existence of, repos belonging to a caller we'd reject).
  let liveRepos: Array<any> = [];
  let reposFetched = false;
  try {
    const reposResp = await gh<any>(id, "/installation/repositories?per_page=100");
    liveRepos = reposResp?.repositories || [];
    reposFetched = true;
  } catch (err) {
    console.warn("[link] couldn't list repos:", err);
  }

  const accountType: "User" | "Organization" =
    liveInstall?.account?.type === "Organization" ? "Organization" : "User";
  if (!install) {
    install = {
      id: uuid(),
      userId: user.id,
      userIds: [user.id],
      accountId: liveInstall?.account?.id ?? 0,
      accountLogin: liveInstall?.account?.login ?? "unknown",
      accountType,
      installationId: id,
      repoIds: liveRepos.map((r) => r.id),
    };
    db.insert("installations", install);
  } else {
    // Add this user to the membership set rather than overwriting userId — a
    // second org owner linking the same install must not displace the first.
    // Only overwrite repoIds when the list actually came back: reposFetched
    // distinguishes "fetch failed" from "succeeded with zero repos" (so removing
    // every repo correctly clears the row instead of keeping stale ids).
    db.update("installations", (i) => i.id === install!.id, {
      accountId: liveInstall?.account?.id ?? install.accountId,
      accountLogin: liveInstall?.account?.login ?? install.accountLogin,
      accountType,
      repoIds: reposFetched ? liveRepos.map((r) => r.id) : install.repoIds,
    });
    // addInstallMember sets userId when empty, dedupes into userIds, and returns
    // the fresh row (db.update replaces rather than mutating in place).
    install = addInstallMember(install.id, user.id) ?? install;
  }

  // Materialise Repository rows for everything we can see.
  for (const r of liveRepos) {
    const [owner, name] = String(r.full_name || "").split("/");
    if (!owner || !name) continue;
    const existing = db.find(
      "repositories",
      (x) => x.owner === owner && x.name === name
    );
    if (existing) {
      const visChanged = typeof r.private === "boolean" && existing.private !== r.private;
      if (
        existing.installationId !== install!.id ||
        existing.defaultBranch !== (r.default_branch || existing.defaultBranch) ||
        visChanged
      ) {
        db.update("repositories", (x) => x.id === existing.id, {
          installationId: install!.id,
          defaultBranch: r.default_branch || existing.defaultBranch,
          ...(typeof r.private === "boolean" ? { private: r.private } : {}),
        });
      }
      continue;
    }
    const inserted = db.insert("repositories", {
      id: uuid(),
      installationId: install!.id,
      owner,
      name,
      defaultBranch: r.default_branch || "main",
      private: Boolean(r.private),
      defaultModel: "claude-opus-4-7",
      modelOverrides: {},
      reviewsEnabled: true,
      indexState: "queued",
    });
    enqueueIndex({ repoId: inserted.id, full: true });
  }

  res.json({ ok: true, installation: install, repoCount: liveRepos.length });
}
api.post("/installations/:installationId/link", linkInstallationHandler);

api.get("/repositories", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const installs = installationsForUser(user.id);
  const installIds = new Set(installs.map((i) => i.id));
  const repos = db.filter("repositories", (r) => installIds.has(r.installationId));
  // Attach per-repo review counts for the Workflow rail cards. One pass over the
  // user's reviews: approved = "passed", blocked = "changes_requested".
  const repoIds = new Set(repos.map((r) => r.id));
  const stats = new Map<string, { total: number; approved: number; blocked: number }>();
  for (const rv of db.filter("prReviews", (r) => repoIds.has(r.repoId))) {
    const s = stats.get(rv.repoId) || { total: 0, approved: 0, blocked: 0 };
    s.total++;
    if (rv.status === "passed") s.approved++;
    else if (rv.status === "changes_requested") s.blocked++;
    stats.set(rv.repoId, s);
  }
  res.json(
    repos.map((r) => ({
      ...r,
      reviewStats: stats.get(r.id) || { total: 0, approved: 0, blocked: 0 },
    }))
  );
});

// Trigger a full repo re-index. Useful when the indexer prompt or allow-list
// changes, or when QA wants to observe the build without waiting for a webhook.
api.post("/repositories/:id/reindex", expensiveLimiter, (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  // Owner-scoped: refuse if the repo doesn't belong to this user's installs.
  const installs = installationsForUser(user.id);
  if (!installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  db.update("repositories", (r) => r.id === repo.id, { indexState: "queued", indexError: null });
  const job = enqueueIndex({ repoId: repo.id, full: true });
  res.json({ ok: true, jobId: job.id });
});

// --- Per-repo review workflow ---

// Read a repo's effective workflow (defaults merged over any stored overrides),
// plus whether advanced controls are locked for this user's plan. Owner-scoped.
api.get("/repositories/:id/workflow", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  const installs = installationsForUser(user.id);
  if (!installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  res.json({ workflow: effectiveWorkflow(repo), advancedLocked: effectivePlan(sub) === "free" });
});

// Save a repo's workflow. Owner-scoped. Paywall: free users may change which
// stages run (basic) but not the trigger policy or verdict mode (advanced) — an
// advanced change from a free user is refused with 403 upgrade_required (the UI
// also locks those controls, so this is the server-side backstop).
api.put("/repositories/:id/workflow", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  const installs = installationsForUser(user.id);
  if (!installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  const next = normalizeWorkflow(req.body?.workflow ?? req.body);
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (effectivePlan(sub) === "free" && advancedChanged(effectiveWorkflow(repo), next)) {
    return void res.status(403).json({ error: "upgrade_required" });
  }
  db.update("repositories", (r) => r.id === repo.id, { workflow: next });
  res.json({ ok: true, workflow: next });
});

// Accept only a URL we are willing to STORE and later hand back to a browser as
// a link. Guidance materials and task attachments both end up rendered as an
// <a href> on the agent page, so a `javascript:`/`data:` URL stored here is
// stored XSS — a scheme check at the boundary is what keeps it out.
//
// This is NOT the SSRF boundary, and must not be mistaken for one. Nothing
// fetches a task attachment server-side (summarizeVideo hands the URL to Gemini
// as prompt text, and only a hostname-allowlisted YouTube link ever becomes a
// fileUri), and the one path that does fetch — guidance `kind: "doc"` — goes
// through ssrf.ts's resolvePublicUrl + fetchGuarded, which re-validates and
// re-pins every redirect hop. That guard is the boundary, by design: it holds at
// connect time, where a check here cannot.
//
// Deliberately DNS-free. Resolving here would put an attacker-controlled lookup
// in the request handler (latency/DoS), and a resolve-time verdict cannot bind
// the later fetch anyway — that is the rebinding TOCTOU ssrf.ts exists to close.
// So we only drop what is decidable offline: bad schemes and hosts that can
// never be public. It buys a fast, honest 400 instead of an item that fails
// later in the worker.
function isStorableLinkUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isObviouslyNonPublicHost(u.hostname);
}

// --- Per-repo guidance materials (Workflow "Ingest context" node) ---
//
// Maintainer-attached videos, doc links and uploaded PDFs that steer every
// review on the repo. Each add distils the material once (review/guidance.ts);
// we store only the distilled text, never raw PDF bytes. Owner-scoped; mutations
// are Pro/Max (gated like custom prompts / advanced workflow controls).

const MAX_GUIDANCE_ITEMS = 20;
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

// Resolve an owner-scoped repo for a guidance request. On any failure it writes
// the response and returns null, so callers just early-return.
function ownedRepo(req: Request, res: Response): { repo: Repository; user: User } | null {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) {
    res.status(404).json({ error: "repo_not_found" });
    return null;
  }
  const installs = installationsForUser(user.id);
  if (!installs.some((i) => i.id === repo.installationId)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { repo, user };
}

// Pro/Max backstop for guidance mutations (the UI also locks the controls).
function guidanceLocked(user: User): boolean {
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  return effectivePlan(sub) === "free";
}

// Friendly display title from a link's host + last path segment.
function guidanceTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ? `${u.hostname}/${decodeURIComponent(seg)}`.slice(0, 120) : u.hostname;
  } catch {
    return url.slice(0, 120);
  }
}

// List a repo's guidance materials. Owner-scoped (read is not plan-gated, so a
// downgraded user can still see/manage what they added).
api.get("/repositories/:id/guidance", (req, res) => {
  const ctx = ownedRepo(req, res);
  if (!ctx) return;
  res.json({ items: ctx.repo.guidance ?? [] });
});

// Whole-repo security audit: aggregate the vulnerabilities the indexer's
// security sub-pass stored across this repo's files. Read-only and owner-scoped,
// with no LLM cost (pure aggregation over the repo index). Empty until the index
// has been (re)built with the security pass — `indexState` tells the caller
// whether a build is pending so an empty list reads as "not scanned yet" rather
// than "clean".
api.get("/repositories/:id/security", (req, res) => {
  const ctx = ownedRepo(req, res);
  if (!ctx) return;
  const entries = db.filter("repoIndex", (e) => e.repoId === ctx.repo.id);
  const vulnerabilities = entries
    .flatMap((e) => e.vulnerabilities ?? [])
    .sort((a, b) => {
      // Blockers first, then by file path for stable grouping.
      if (a.severity !== b.severity) return a.severity === "blocker" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  const blocker = vulnerabilities.filter((v) => v.severity === "blocker").length;
  res.json({
    indexState: ctx.repo.indexState ?? "none",
    indexedAt: ctx.repo.indexedAt ?? null,
    indexedCommit: ctx.repo.indexedCommit ?? null,
    counts: {
      total: vulnerabilities.length,
      blocker,
      warn: vulnerabilities.length - blocker,
      affectedFiles: new Set(vulnerabilities.map((v) => v.path)).size,
    },
    vulnerabilities,
  });
});

// Add a video or documentation link. Distils immediately via the queue.
api.post("/repositories/:id/guidance", expensiveLimiter, (req, res) => {
  const ctx = ownedRepo(req, res);
  if (!ctx) return;
  if (guidanceLocked(ctx.user)) return void res.status(403).json({ error: "upgrade_required" });

  const kind = req.body?.kind;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (kind !== "video" && kind !== "doc") return void res.status(400).json({ error: "invalid_kind" });
  if (!isStorableLinkUrl(url)) return void res.status(400).json({ error: "invalid_url" });
  const existing = ctx.repo.guidance ?? [];
  if (existing.length >= MAX_GUIDANCE_ITEMS) return void res.status(400).json({ error: "too_many_items" });

  const item: RepoGuidanceItem = {
    id: uuid(),
    kind,
    title: guidanceTitleFromUrl(url),
    url,
    status: "indexing",
    addedAt: Date.now(),
    addedBy: ctx.user.githubLogin,
    error: null,
  };
  db.update("repositories", (r) => r.id === ctx.repo.id, { guidance: [...existing, item] });
  enqueueGuidanceIngest({ repoId: ctx.repo.id, itemId: item.id });
  track(ctx.user, "guidance added", { kind, repo: `${ctx.repo.owner}/${ctx.repo.name}` });
  res.json({ ok: true, item });
});

// Upload a PDF directly. Sent as a raw `application/pdf` body (the global
// express.json parser passes it through on content-type mismatch), so this
// route-scoped raw parser can take a larger limit than the 1mb global one.
api.post(
  "/repositories/:id/guidance/pdf",
  // Throttle before the 20mb raw parser so a flood is rejected without us
  // buffering the body.
  expensiveLimiter,
  express.raw({ type: "application/pdf", limit: "20mb" }),
  (req, res) => {
    const ctx = ownedRepo(req, res);
    if (!ctx) return;
    if (guidanceLocked(ctx.user)) return void res.status(403).json({ error: "upgrade_required" });

    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length === 0) return void res.status(400).json({ error: "data_required" });
    if (buf.length > MAX_PDF_BYTES) return void res.status(413).json({ error: "file_too_large" });
    if (buf.toString("latin1", 0, 5) !== "%PDF-") return void res.status(400).json({ error: "not_a_pdf" });

    const existing = ctx.repo.guidance ?? [];
    if (existing.length >= MAX_GUIDANCE_ITEMS) return void res.status(400).json({ error: "too_many_items" });

    const rawName = typeof req.query.filename === "string" ? req.query.filename : "";
    const item: RepoGuidanceItem = {
      id: uuid(),
      kind: "pdf",
      title: (rawName || "document.pdf").slice(0, 120),
      status: "indexing",
      addedAt: Date.now(),
      addedBy: ctx.user.githubLogin,
      error: null,
    };
    db.update("repositories", (r) => r.id === ctx.repo.id, { guidance: [...existing, item] });
    // Bytes ride along on the in-memory job; we never persist them to the DB.
    enqueueGuidanceIngest({
      repoId: ctx.repo.id,
      itemId: item.id,
      pdfBase64: buf.toString("base64"),
      pdfMediaType: "application/pdf",
    });
    track(ctx.user, "guidance added", { kind: "pdf", repo: `${ctx.repo.owner}/${ctx.repo.name}` });
    res.json({ ok: true, item });
  }
);

// Remove a guidance material. Not plan-gated, so a downgraded user can clean up.
api.delete("/repositories/:id/guidance/:itemId", (req, res) => {
  const ctx = ownedRepo(req, res);
  if (!ctx) return;
  const existing = ctx.repo.guidance ?? [];
  const item = existing.find((g) => g.id === req.params.itemId);
  if (!item) return void res.status(404).json({ error: "item_not_found" });
  db.update("repositories", (r) => r.id === ctx.repo.id, {
    guidance: existing.filter((g) => g.id !== item.id),
  });
  res.json({ ok: true });
});

// List the repo's GitHub Actions workflows — populates the "Run GitHub Action"
// node's picker. Owner-scoped. Best-effort: if the App lacks `actions:read`
// (or the repo has none), return an empty list + flag so the UI can nudge the
// user to grant the permission rather than erroring.
api.get("/repositories/:id/actions/workflows", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  const installs = installationsForUser(user.id);
  const install = installs.find((i) => i.id === repo.installationId);
  if (!install) return void res.status(403).json({ error: "forbidden" });
  try {
    const data = await gh<{ workflows: Array<{ id: number; name: string; path: string; state: string }> }>(
      install.installationId,
      `/repos/${repo.owner}/${repo.name}/actions/workflows?per_page=100`
    );
    const workflows = (data.workflows || [])
      .filter((w) => w.state === "active")
      .map((w) => ({
        id: w.id,
        name: w.name,
        // The dispatch API accepts the workflow file name as its id.
        file: w.path.split("/").pop() || String(w.id),
      }));
    res.json({ workflows });
  } catch (err) {
    console.warn(`[actions] list workflows failed for ${repo.owner}/${repo.name}:`, err);
    res.json({ workflows: [], error: "actions_unavailable" });
  }
});

// --- PR Reviews (the agent's queue) ---

api.get("/reviews", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const status = req.query.status as string | undefined;
  const installs = installationsForUser(user.id);
  // Plan-based visibility: free (and lapsed) users only see public-repo reviews;
  // paid plans see public + private. Same private-repo entitlement as the review
  // gate (PLAN_LIMITS.privateRepos).
  const canPrivate = PLAN_LIMITS[planForUser(user.id)].privateRepos;
  const repos = db.filter(
    "repositories",
    (r) => installs.some((i) => i.id === r.installationId) && (canPrivate || !r.private)
  );
  const repoIds = new Set(repos.map((r) => r.id));
  let reviews = db.filter("prReviews", (r) => repoIds.has(r.repoId));
  if (status) reviews = reviews.filter((r) => r.status === status);
  reviews.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(reviews);
});

// Owner-scoped: 401 if signed out, 404 if the id is unknown, 403 if the review
// exists but its repo isn't under one of this user's installs. Exported so the
// auth gate is covered directly in review-auth.test.ts.
export function getReviewHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const review = db.find("prReviews", (r) => r.id === req.params.id);
  if (!review) return void res.status(404).json({ error: "review_not_found" });
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  const installs = installationsForUser(user.id);
  if (!repo || !installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  const logs = db.filter("reviewLogs", (l) => l.reviewId === review.id).sort((a, b) => a.at - b.at);
  const task = review.taskId ? db.find("tasks", (t) => t.id === review.taskId) : null;
  res.json({ review, logs, task });
}
api.get("/reviews/:id", getReviewHandler);

// Re-run a review (e.g. after the user attached a Loom and updated the task).
// Same owner-scoped gate as the read above — this re-queues work, so an
// unauthorized caller must not be able to flip status or enqueue a pipeline run.
export function rerunReviewHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const review = db.find("prReviews", (r) => r.id === req.params.id);
  if (!review) return void res.status(404).json({ error: "review_not_found" });
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  const installs = installationsForUser(user.id);
  if (!repo || !installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  db.update("prReviews", (r) => r.id === review.id, { status: "queued" });
  enqueueReview(review.id);
  res.json({ ok: true });
}
api.post("/reviews/:id/rerun", expensiveLimiter, rerunReviewHandler);

// Pull open PRs from every connected repo and ensure each one has a PRReview
// row in the queue. Newly-discovered PRs are enqueued for review immediately.
// Idempotent: PRs we've already seen are left alone (the user can hit "Re-run"
// on the card if they want a fresh pass).
api.post("/reviews/sync", expensiveLimiter, async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });

  const installs = installationsForUser(user.id);
  const repos = db.filter("repositories", (r) =>
    installs.some((i) => i.id === r.installationId)
  );

  let discovered = 0;
  let enqueued = 0;
  const errors: Array<{ repo: string; message: string }> = [];

  // Sync attributes every discovered review to the signed-in user. Skip private
  // repos their plan can't review (free → public only), matching the queue filter.
  const plan = planForUser(user.id);
  const canPrivate = PLAN_LIMITS[plan].privateRepos;

  for (const repo of repos) {
    const install = installs.find((i) => i.id === repo.installationId);
    if (!install) continue;
    if (repo.private && !canPrivate) continue;
    let openPRs: Array<any> = [];
    try {
      openPRs = await gh<any[]>(
        install.installationId,
        `/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=50`
      );
    } catch (err: any) {
      errors.push({ repo: `${repo.owner}/${repo.name}`, message: err?.message || String(err) });
      continue;
    }
    for (const pr of openPRs) {
      discovered++;
      const newSha: string = pr.head?.sha || "";
      const existing = db.find(
        "prReviews",
        (r) => r.repoId === repo.id && r.prNumber === pr.number
      );
      if (existing) {
        // Webhook fallback: GitHub may have failed to deliver the
        // `pull_request.synchronize` event (no tunnel, server restart,
        // network blip). The PR's head SHA on GitHub no longer matches our
        // stored one — treat it as a push we missed and re-run the review.
        // Same shape as the webhook synchronize path so the Agent page log
        // and queue card behave identically regardless of which source
        // surfaced the commit first.
        if (newSha && existing.headSha !== newSha && repo.reviewsEnabled) {
          db.update("prReviews", (r) => r.id === existing.id, {
            headSha: newSha,
            status: "queued",
            additions: null,
            deletions: null,
            changedFiles: null,
            updatedAt: Date.now(),
          });
          db.insert("reviewLogs", {
            id: uuid(),
            reviewId: existing.id,
            kind: "ingest",
            at: Date.now(),
            action: "commit.push",
            target: newSha.slice(0, 7),
            detail: "New commits detected (sync from GitHub)",
            meta: {
              after: newSha,
              prevHeadSha: existing.headSha,
              source: "sync",
            },
          });
          enqueueReview(existing.id);
          enqueued++;
        }
        continue;
      }
      // Auto-review eligibility — mirror the webhook so the dashboard poll only
      // enqueues PRs we'd review unprompted (own PRs on Free/Pro; own + team PRs
      // on Max). PRs that need a "review" comment are left untouched here, with
      // no row, exactly as the webhook leaves them.
      if (
        !shouldAutoReviewOpenedPR({
          ownerUserId: user.id,
          prAuthorLogin: pr.user?.login || "",
          prAuthorId: pr.user?.id,
          authorAssociation: pr.author_association,
        })
      ) {
        continue;
      }

      // Monthly-cap gate for a newly-discovered PR — dashboard sync bypasses the
      // `opened` webhook's cap check. Over-cap owners' new PRs are skipped
      // silently (no row, no comment), matching the webhook's no-row state.
      const cap = chargeForNewPRReview(user.id, repo, pr.number);
      if (cap && !cap.allowed) continue;

      const review = {
        id: uuid(),
        repoId: repo.id,
        prNumber: pr.number,
        prTitle: pr.title,
        headSha: newSha,
        baseSha: pr.base?.sha || "",
        status: "queued" as const,
        verdict: null,
        criteria: [],
        taskId: null,
        // Listing endpoint doesn't include diff stats; pipeline will fill these
        // in on its first run via the full PR fetch in ingestContext.
        additions: null,
        deletions: null,
        changedFiles: null,
        attributedUserId: user.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.insert("prReviews", review);
      if (repo.reviewsEnabled) {
        enqueueReview(review.id);
        enqueued++;
      }
      // App notification: this PR was discovered via a sync (e.g. opened
      // before the App was installed, or webhook delivery missed). Same
      // copy as the webhook path so the user sees one consistent message.
      notifyForReview(
        review.id,
        "review",
        `PR #${pr.number} added to review queue`,
        `${repo.owner}/${repo.name} — ${pr.title}`
      );
    }
  }

  res.json({ ok: true, discovered, enqueued, errors });
});

// --- Tasks + Message-Agent ---

// Owner-scoped: 401 if signed out, 404 if the id is unknown, 403 if the task
// exists but isn't the caller's. Ownership resolves task → review → repo →
// installation → user, or directly via task.userId for Linear tasks that have
// no linked review yet. Exported so the gate is covered in task-auth.test.ts.
export function getTaskHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const task = db.find("tasks", (t) => t.id === req.params.id);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
  // task → review → repo → installation → user.id, OR Linear task.userId === user.id
  const linkedReviews = db.filter("prReviews", (r) => r.taskId === task.id);
  const repoIds = new Set(linkedReviews.map((r) => r.repoId));
  const repos = db.filter("repositories", (r) => repoIds.has(r.id));
  const installs = installationsForUser(user.id);
  const owns =
    repos.some((repo) => installs.some((i) => i.id === repo.installationId)) ||
    (!!task.userId && task.userId === user.id);
  if (!owns) return void res.status(403).json({ error: "forbidden" });
  res.json(task);
}
api.get("/tasks/:id", getTaskHandler);

// Adds an attachment (Loom link, Figma URL, image, PDF, plain text) to a task.
// Mirrors the Message-agent screen in the design.
export function addTaskAttachmentHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const task = db.find("tasks", (t) => t.id === req.params.id);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
  // task → review → repo → installation → user.id, OR Linear task.userId === user.id
  const linkedReviews = db.filter("prReviews", (r) => r.taskId === task.id);
  const repoIds = new Set(linkedReviews.map((r) => r.repoId));
  const repos = db.filter("repositories", (r) => repoIds.has(r.id));
  const installs = installationsForUser(user.id);
  const owns =
    repos.some((repo) => installs.some((i) => i.id === repo.installationId)) ||
    (!!task.userId && task.userId === user.id);
  if (!owns) return void res.status(403).json({ error: "forbidden" });
  const { kind, url, note } = req.body || {};
  if (!kind) return void res.status(400).json({ error: "kind_required" });
  // `url` is optional — a `kind: "text"` message from the composer carries only
  // a note. When one IS present it gets stored, echoed back to the agent page,
  // and rendered there as a link, so it has to clear the same bar as a guidance
  // URL. See isStorableLinkUrl: this is an XSS/storage check, not an SSRF one.
  if (url !== undefined && url !== null && url !== "" && !isStorableLinkUrl(url)) {
    return void res.status(400).json({ error: "invalid_url" });
  }
  const att = { id: uuid(), kind, url, note, createdAt: Date.now() };
  // Non-text kinds (videos, docs, images, PDFs) genuinely reshape the brief
  // and warrant a fresh criteria synthesis. Plain text messages from the
  // composer go through the lighter maintainer-feedback path below, which
  // decides for itself whether `endGoal` should change.
  const patch: any = { attachments: [...task.attachments, att] };
  if (kind !== "text") patch.endGoal = null;
  db.update("tasks", (t) => t.id === task.id, patch);
  track(user, "attachment added", { attachment_kind: kind, task_id: task.id });

  // When the user drops a Loom (or any other recognised video link) on a
  // PR-bound task mid-review, post a discrete bug-fix comment to the PR so
  // the developer can act on it immediately, without waiting for the next
  // push to trigger a full re-review. Fire-and-forget — never block the
  // attachment response on Gemini/Opus/GitHub round-trips.
  const isVideo = kind === "loom" || (kind === "link" && url && detectVideoProvider(url));
  if (isVideo) {
    void postBugFixCommentForAttachment(task.id, att).catch((err) =>
      console.warn("[bugfix] post failed:", err)
    );
  }

  // Text messages from the agent-page composer should re-evaluate the end
  // goal & acceptance criteria. Reuse the maintainer-feedback flow: same
  // Opus refinement step, same persistence, same GitHub-comment behaviour.
  // The only differentiator is `sourceEvent: "in_app_message"` so downstream
  // logs can tell where the comment originated.
  if (kind === "text" && typeof note === "string" && note.trim()) {
    // One task is 1:1 with a review in practice; if the PR was closed and
    // reopened we may have several, in which case refine the most recently
    // updated one (the one the user is looking at in the agent page).
    const latestReview = linkedReviews.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latestReview) {
      const comment = {
        body: note.trim(),
        author: user.githubLogin || "user",
        authorAssociation: "OWNER",
        sourceUrl: "",
        sourceEvent: "in_app_message" as const,
      };
      // Immediate timeline entry so the user sees their message land before
      // the Opus round-trip resolves. Mirrors the webhook path that logs
      // `comment.received` on every maintainer-comment ingest.
      db.insert("reviewLogs", {
        id: uuid(),
        reviewId: latestReview.id,
        kind: "ingest",
        at: Date.now(),
        action: "comment.received",
        target: comment.author,
        detail: comment.body.slice(0, 240),
        meta: { sourceEvent: comment.sourceEvent },
      });
      enqueueMaintainerFeedback(latestReview.id, comment);
    }
  }

  res.json({ ok: true, attachment: att });
}
api.post("/tasks/:id/attachments", expensiveLimiter, addTaskAttachmentHandler);

// Removes an attachment from a task's end-goal. We do more than just splice
// the array: we also invalidate `task.endGoal` and clear `review.criteria`
// on any linked PR review, then re-queue the review. That undoes the context
// (synthesised end goal + per-criterion checks) that this attachment seeded.
export function removeTaskAttachmentHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const task = db.find("tasks", (t) => t.id === req.params.taskId);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
  // task → review → repo → installation → user.id, OR Linear task.userId === user.id.
  // Checked before attachment_not_found so we don't leak attachment existence on
  // a task the caller doesn't own.
  const linkedReviews = db.filter("prReviews", (r) => r.taskId === task.id);
  const repoIds = new Set(linkedReviews.map((r) => r.repoId));
  const repos = db.filter("repositories", (r) => repoIds.has(r.id));
  const installs = installationsForUser(user.id);
  const owns =
    repos.some((repo) => installs.some((i) => i.id === repo.installationId)) ||
    (!!task.userId && task.userId === user.id);
  if (!owns) return void res.status(403).json({ error: "forbidden" });
  const removed = task.attachments.find((a) => a.id === req.params.attachmentId);
  if (!removed) return void res.status(404).json({ error: "attachment_not_found" });
  const remaining = task.attachments.filter((a) => a.id !== req.params.attachmentId);
  db.update("tasks", (t) => t.id === task.id, {
    attachments: remaining,
    endGoal: null, // force resynthesis without this constraint's context
  });
  // Scrub the removed attachment out of persistent video-summary logs so the
  // frontend's "sources analyzed" list doesn't keep showing a Loom (or other
  // video link) that the user just dropped. Video logs survive across review
  // re-runs — the pipeline only summarises newly-seen URLs — so without this
  // pass the URL would stick around in `meta.videos` forever.
  const removedUrls = new Set<string>(
    [removed.url, removed.contentRef].filter((s): s is string => typeof s === "string" && s.length > 0)
  );
  if (removedUrls.size > 0) {
    const linkedReviewIds = new Set(linkedReviews.map((r) => r.id));
    const videoLogs = db.filter("reviewLogs", (l) =>
      linkedReviewIds.has(l.reviewId) &&
      (l.action === "Videos summarized by Gemini" ||
        l.action === "Videos in maintainer feedback summarized") &&
      Array.isArray((l.meta as any)?.videos)
    );
    for (const entry of videoLogs) {
      const videos = ((entry.meta as any).videos as Array<{ url?: string }>) || [];
      const remainingVideos = videos.filter((v) => !v?.url || !removedUrls.has(v.url));
      if (remainingVideos.length === 0) {
        db.remove("reviewLogs", (l) => l.id === entry.id);
      } else if (remainingVideos.length !== videos.length) {
        db.update("reviewLogs", (l) => l.id === entry.id, {
          meta: { ...(entry.meta as object), videos: remainingVideos } as any,
        });
      }
    }
  }
  // For each linked review: log the removal, wipe criteria, requeue.
  for (const rev of linkedReviews) {
    db.insert("reviewLogs", {
      id: uuid(),
      reviewId: rev.id,
      kind: "ingest",
      at: Date.now(),
      action: "constraint.removed",
      target: removed.kind,
      detail:
        `Removed ${removed.kind} attachment` +
        (removed.url ? ` (${removed.url})` : removed.note ? ` — "${String(removed.note).slice(0, 80)}"` : "") +
        "; re-synthesising end goal.",
      meta: { attachmentId: removed.id, kind: removed.kind, by: user.githubLogin },
    });
    db.update("prReviews", (r) => r.id === rev.id, {
      criteria: [],
      status: "queued",
      verdict: null,
    });
    enqueueReview(rev.id);
  }
  res.json({ ok: true, removed });
}
api.delete("/tasks/:taskId/attachments/:attachmentId", expensiveLimiter, removeTaskAttachmentHandler);

// --- Integrations ---

api.get("/integrations", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  // Don't leak tokens to the frontend.
  const safe = db.filter("integrations", (i) => i.userId === user.id).map((i) => ({
    id: i.id,
    type: i.type,
    workspaceMeta: i.workspaceMeta,
    createdAt: i.createdAt,
  }));
  res.json(safe);
});

// Exported (like meHandler) so the auth + validation + insert wiring is testable
// without standing up the HTTP server.
export function createIntegrationHandler(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  // Whitelist the type, require a well-formed credential, and cap workspaceMeta
  // before the raw body becomes a row the review/broadcast paths later trust.
  const parsed = parseIntegrationInput(req.body);
  if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
  const row = {
    id: uuid(),
    userId: user.id,
    ...parsed.value,
    createdAt: Date.now(),
  };
  db.insert("integrations", row);
  track(user, "integration connected", { integration_type: row.type });
  res.json({ ok: true, id: row.id });
}
api.post("/integrations", createIntegrationHandler);

api.delete("/integrations/:id", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  // Linear webhooks are app-level (not per-connect), so disconnecting just drops
  // the row; the app keeps delivering but the org no longer resolves to a token,
  // and the webhook handler acknowledges + ignores it.
  const removedIntegration = db.find(
    "integrations",
    (i) => i.id === req.params.id && i.userId === user.id
  );
  db.remove("integrations", (i) => i.id === req.params.id && i.userId === user.id);
  if (removedIntegration) {
    track(user, "integration disconnected", { integration_type: removedIntegration.type });
  }
  res.json({ ok: true });
});

// Teams in the connected Linear workspace, fetched live with the stored token (which
// never leaves the server). Powers the "Linear workspace" section in Settings →
// Repository. Returns connected:false (not an error) when the user has no Linear row.
api.get("/integrations/linear/teams", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const row = db.find(
    "integrations",
    (i) => i.userId === user.id && i.type === "linear"
  );
  if (!row) return void res.json({ connected: false, teams: [] });
  const teams = await fetchLinearTeams(row.tokens.accessToken);
  res.json({
    connected: true,
    workspace: row.workspaceMeta?.workspaceName || row.workspaceMeta?.urlKey || "",
    teams,
  });
});

// Re-check the stored Linear token against Linear. Called after the user visits
// "Manage Access" (where they can revoke DevAsign) — Linear has no revocation
// webhook, so we probe on demand. If the token is confirmed revoked we drop the
// row so the UI flips back to "Connect Linear"; a transient failure keeps it.
api.post("/integrations/linear/validate", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const row = db.find(
    "integrations",
    (i) => i.userId === user.id && i.type === "linear"
  );
  if (!row) return void res.json({ connected: false });
  const status = await validateLinearToken(row.tokens.accessToken);
  if (status === "revoked") {
    db.remove("integrations", (i) => i.id === row.id && i.userId === user.id);
    return void res.json({ connected: false });
  }
  res.json({ connected: true }); // "valid" or "unknown" → keep the row
});

// --- Billing (Stripe) ---

// Parse + validate the optional billing interval from a request body. Defaults
// to "month"; returns null when the value is present but not month/year.
function parseInterval(body: unknown): Interval | null {
  const i = (body as { interval?: unknown } | null)?.interval ?? "month";
  return i === "month" || i === "year" ? i : null;
}

// Enriched subscription view for the Billing settings page: the row plus the
// effective plan (after any lapse-downgrade) and the monthly review allowance
// + usage. `reviewLimit: null` means unlimited (Max). `annualAvailable` gates the
// monthly/annual toggle; `interval` is the current sub's cadence.
api.get("/billing/subscription", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  const plan = effectivePlan(sub);
  const limits = PLAN_LIMITS[plan];
  res.json({
    subscription: sub ?? null,
    effectivePlan: plan,
    interval: intervalOf(sub),
    annualAvailable: isAnnualConfigured(),
    reviewsUsed: sub?.reviewsUsed ?? 0,
    reviewLimit: Number.isFinite(limits.monthlyReviews) ? limits.monthlyReviews : null,
    features: { privateRepos: limits.privateRepos, linear: limits.linear },
  });
});

// Start a Stripe Checkout for a paid tier. Returns a hosted-page URL the
// frontend redirects to. Card up front + 14-day trial (see billing/stripe.ts).
api.post("/billing/checkout", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  if (!isStripeConfigured()) {
    return void res.status(503).json({
      error: "stripe_not_configured",
      message: "Set STRIPE_SECRET_KEY, STRIPE_PRICE_PRO and STRIPE_PRICE_MAX in the backend env.",
    });
  }
  const plan = req.body?.plan;
  if (plan !== "pro" && plan !== "max") {
    return void res.status(400).json({ error: "invalid_plan", message: "plan must be 'pro' or 'max'" });
  }
  const interval = parseInterval(req.body);
  if (!interval) {
    return void res.status(400).json({ error: "invalid_interval", message: "interval must be 'month' or 'year'" });
  }
  if (interval === "year" && !isAnnualConfigured()) {
    return void res.status(503).json({ error: "annual_not_configured", message: "Annual billing isn't available." });
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub) return void res.status(404).json({ error: "no_subscription" });
  const onboarding = Boolean(req.body?.onboarding);
  try {
    const url = await createCheckoutSession(user, sub, plan, interval, onboarding);
    track(user, "checkout initiated", { plan, interval, onboarding });
    res.json({ url });
  } catch (err) {
    console.error("[billing] checkout failed:", err);
    res.status(502).json({ error: "checkout_failed" });
  }
});

// Open the Stripe Customer Portal (update card, cancel, view invoices).
api.post("/billing/portal", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  if (!isStripeConfigured()) {
    return void res.status(503).json({ error: "stripe_not_configured" });
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub?.stripeCustomerId) {
    return void res
      .status(404)
      .json({ error: "no_customer", message: "No billing account yet — subscribe first." });
  }
  try {
    const url = await createPortalSession(sub, { cancel: req.body?.flow === "cancel" });
    res.json({ url });
  } catch (err) {
    console.error("[billing] portal failed:", err);
    res.status(502).json({ error: "portal_failed" });
  }
});

// Switch the active subscription to another paid tier. body: { plan, immediate }.
// Upgrades are typically immediate; downgrades default to scheduled (immediate=false).
api.post("/billing/change-plan", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  if (!isStripeConfigured()) return void res.status(503).json({ error: "stripe_not_configured" });
  const plan = req.body?.plan;
  if (plan !== "pro" && plan !== "max") {
    return void res.status(400).json({ error: "invalid_plan", message: "plan must be 'pro' or 'max'" });
  }
  const interval = parseInterval(req.body);
  if (!interval) {
    return void res.status(400).json({ error: "invalid_interval", message: "interval must be 'month' or 'year'" });
  }
  if (interval === "year" && !isAnnualConfigured()) {
    return void res.status(503).json({ error: "annual_not_configured", message: "Annual billing isn't available." });
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  // Must have an active paid plan to switch; free/lapsed users subscribe via checkout.
  if (!sub?.stripeSubscriptionId || effectivePlan(sub) === "free") {
    return void res.status(404).json({ error: "no_active_subscription", message: "Start a plan first." });
  }
  // No-op only when BOTH tier and interval already match (so monthly→annual on
  // the same tier is a valid change that captures the discount).
  if (effectivePlan(sub) === plan && intervalOf(sub) === interval) {
    return void res.status(400).json({ error: "already_on_plan" });
  }
  try {
    const previousPlan = effectivePlan(sub);
    const previousInterval = intervalOf(sub);
    await changePlan(sub, plan, interval, Boolean(req.body?.immediate));
    track(user, "plan changed", {
      from_plan: previousPlan,
      to_plan: plan,
      from_interval: previousInterval,
      to_interval: interval,
      immediate: Boolean(req.body?.immediate),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[billing] change-plan failed:", err);
    res.status(502).json({ error: "change_plan_failed" });
  }
});

// Revert a pending scheduled downgrade — keep the current plan.
api.post("/billing/scheduled-change/cancel", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  if (!isStripeConfigured()) return void res.status(503).json({ error: "stripe_not_configured" });
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub) return void res.status(404).json({ error: "no_subscription" });
  try {
    await cancelScheduledChange(sub);
    res.json({ ok: true });
  } catch (err) {
    console.error("[billing] cancel scheduled change failed:", err);
    res.status(502).json({ error: "cancel_scheduled_failed" });
  }
});

// --- Audit log (Security screen) ---

api.get("/audit", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  res.json(
    db
      .filter("authAudit", (a) => a.userId === user.id)
      .sort((a, b) => b.at - a.at)
      .slice(0, 100)
  );
});

// --- Notifications (bell + popover) ---

// Snapshot for the bell — the frontend fetches this on load and whenever the
// live stream below signals a change (with a slow fallback poll as a backstop).
api.get("/notifications", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  res.json({
    items: notificationsForUser(user.id, 50),
    unreadCount: unreadCountForUser(user.id),
  });
});

// Server-Sent Events stream: pushes a lightweight "notifications-changed" signal
// the instant a notification is created (or marked read) for this user, so the
// dashboard refetches on demand instead of polling on a timer. GET, so it sails
// past the CSRF guard, the durability barrier and the json parser untouched; the
// path is exempted from globalLimiter (rate-limit.ts) since it's one long-lived
// connection. See notifications-stream.ts.
api.get("/notifications/stream", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Defeat proxy response buffering (nginx-style) so frames flush immediately.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  // A write to a socket the client already dropped surfaces asynchronously as an
  // 'error' on the response stream (EPIPE/ECONNRESET) — writeFrame's try/catch
  // can't see it, and with no listener Node escalates it to an uncaught exception
  // that crashes the process. Swallow it; teardown runs via the 'close' handler
  // below. Registered before the first write so an instant disconnect can't slip
  // past it.
  res.on("error", () => {});
  // Establish the stream and tell the browser how long to wait before
  // reconnecting if it drops (EventSource handles the reconnect itself).
  res.write("retry: 5000\n\n");
  // githubId indexes this stream for bounty fan-out (applications carry a
  // githubId, not a userId). The tab id arrives as a query param because
  // EventSource can't set headers — it lets a write caused by THIS tab skip
  // pushing back to it. Both are optional; a stream without them still works.
  addClient(user.id, res, {
    githubId: user.githubId,
    tabId: sanitizeTabId(req.query.tab),
  });
  req.on("close", () => removeClient(user.id, res));
});

// "Mark all read" button. Returns how many rows were actually flipped — the
// frontend uses that to optimistically zero the badge.
api.post("/notifications/read", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const marked = markAllRead(user.id);
  res.json({ ok: true, marked });
});
