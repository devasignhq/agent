// Account deletion — immediate, permanent hard delete.
//
// Deleting an account wipes it right away: there is no confirmation email, no
// restore window, and no background sweep. DELETE /api/me calls purgeAccount
// (see routes/api.ts), which tears down external services (Stripe, GitHub App)
// best-effort and then erases every local row the account owns.
//
// "Best-effort" matters because there's no retry sweep anymore: a Stripe/GitHub
// hiccup is logged for manual cleanup but must never strand the account — the
// local wipe always runs, so the user's data is gone the moment they ask.
//
// purgeAccount takes injectable `deps` (GitHub/Stripe/email) so tests can assert
// the teardown without hitting external services; the defaults wire the real ones.
import { db } from "./db.js";
import type { Subscription, User } from "./types.js";
import { isGithubAppConfigured, isStripeConfigured } from "./config.js";
import { uninstallApp } from "./github/app.js";
import { cancelSubscriptionForDeletion } from "./billing/stripe.js";
import { sendAccountPurgedEmail } from "./email.js";
import { track } from "./statsig.js";

// External-service dependencies, injectable for tests.
export type DeletionDeps = {
  uninstallApp: (installationId: number) => Promise<void>;
  cancelSubscriptionForDeletion: (sub: Subscription) => Promise<void>;
  sendAccountPurgedEmail: (user: User) => Promise<unknown>;
};

export const defaultDeletionDeps: DeletionDeps = {
  uninstallApp,
  cancelSubscriptionForDeletion,
  sendAccountPurgedEmail,
};

// Permanently and immediately wipe an account. Tears down external services
// first (best-effort — see file header), sends a final notice while we still
// have the user's email, then erases every local row, child rows first. Never
// throws on an external failure: the wipe always runs so deletion is immediate
// and complete. Idempotent — a missing user is a no-op.
export async function purgeAccount(
  userId: string,
  deps: DeletionDeps = defaultDeletionDeps
): Promise<void> {
  const user = db.find("users", (u) => u.id === userId);
  if (!user) return;

  // Snapshot every row set up front, before any await. The GitHub uninstall
  // below triggers an `installation.deleted` webhook that races to delete some
  // of these same rows; capturing ids now keeps our cleanup independent of it.
  const installs = db.filter("installations", (i) => i.userId === userId);
  const installDbIds = new Set(installs.map((i) => i.id));
  const repoIds = new Set(
    db.filter("repositories", (r) => installDbIds.has(r.installationId)).map((r) => r.id)
  );
  const reviews = db.filter("prReviews", (r) => repoIds.has(r.repoId));
  const reviewIds = new Set(reviews.map((r) => r.id));
  // PR-linked tasks carry no userId (only Linear tasks do), so collect them via
  // the reviews we're deleting; Linear tasks are dropped by userId below.
  const prTaskIds = new Set(
    reviews.map((r) => r.taskId).filter((id): id is string => typeof id === "string")
  );
  const sub = db.find("subscriptions", (s) => s.userId === userId);

  // ── External teardown first, best-effort ───────────────────────────────────
  // There's no retry sweep anymore, so a failure here must not abort the wipe:
  // log it loudly for manual follow-up and keep going.
  if (sub && isStripeConfigured()) {
    try {
      await deps.cancelSubscriptionForDeletion(sub);
    } catch (err) {
      console.error(`[account] Stripe cancel failed during delete for user ${userId}:`, err);
    }
  }
  if (isGithubAppConfigured()) {
    for (const install of installs) {
      try {
        await deps.uninstallApp(install.installationId);
      } catch (err) {
        console.error(
          `[account] GitHub uninstall failed during delete for user ${userId} (install ${install.installationId}):`,
          err
        );
      }
    }
  } else if (installs.length > 0) {
    console.warn(
      `[account] GitHub App not configured — leaving ${installs.length} installation(s) in place for user ${userId}`
    );
  }

  // Final notice while we still have the user's email/login. Best-effort (the
  // email helper never throws), and sent before the wipe for that reason.
  await deps.sendAccountPurgedEmail(user);
  track(user, "account purged");

  // ── Erase local state, child rows first ─────────────────────────────────────
  db.remove("reviewLogs", (l) => reviewIds.has(l.reviewId));
  db.remove("prReviews", (r) => reviewIds.has(r.id));
  db.remove("repoIndex", (e) => repoIds.has(e.repoId));
  db.remove("repositories", (r) => repoIds.has(r.id));
  db.remove("installations", (i) => installDbIds.has(i.id));
  db.remove("tasks", (t) => t.userId === userId || prTaskIds.has(t.id));
  db.remove("integrations", (i) => i.userId === userId);
  db.remove("subscriptions", (s) => s.userId === userId);
  db.remove("notifications", (n) => n.userId === userId);
  db.remove("linearProjectUpdates", (u) => u.userId === userId);
  db.remove("authAudit", (a) => a.userId === userId);
  db.remove("users", (u) => u.id === userId);
}
