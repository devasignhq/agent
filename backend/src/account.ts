// Account-deletion lifecycle — soft delete with a 14-day restore window.
//
// Requesting deletion no longer wipes anything immediately. Instead we stamp
// `deletionRequestedAt` on the user (which pauses code review — see worker.ts),
// pause billing, and email them. The account is kept for 14 days; logging back
// in clears the flag and restores everything (oauth.ts → restoreAccount). If
// they never return, a periodic sweep (server.ts) purges the account at day 14
// — the original hard-delete teardown, now living in purgeAccount — and emails
// a final notice. A day-12 reminder goes out in between.
//
// Functions take an injectable `deps` (GitHub/Stripe/email) so tests can assert
// the flow without hitting external services; the defaults wire the real ones.
import { db } from "./db.js";
import type { Subscription, User } from "./types.js";
import { isGithubAppConfigured, isStripeConfigured } from "./config.js";
import { uninstallApp } from "./github/app.js";
import {
  cancelSubscriptionForDeletion,
  pauseSubscriptionForDeletion,
  resumeSubscriptionAfterRestore,
} from "./billing/stripe.js";
import {
  sendAccountPurgedEmail,
  sendDeletionReminderEmail,
  sendDeletionScheduledEmail,
} from "./email.js";
import { pushNotification } from "./notifications.js";
import { track } from "./statsig.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a requested-for-deletion account is kept before it's wiped, and when
// (within that window) the reminder email goes out.
export const RESTORE_WINDOW_DAYS = 14;
export const REMINDER_DAY = 12;

// When the account will be wiped if the user doesn't return.
export function purgeAtFrom(requestedAt: number): number {
  return requestedAt + RESTORE_WINDOW_DAYS * DAY_MS;
}

export function isDeletionPending(user: Pick<User, "deletionRequestedAt">): boolean {
  return typeof user.deletionRequestedAt === "number";
}

// Resolve review → repo → installation → owner and report whether that owner has
// a pending deletion. The worker uses this to skip posting reviews while an
// account is in its restore window (no analysis, no GitHub comments). Mirrors
// the FK chain in notifications.ts:notifyForReview.
export function reviewOwnerPendingDeletion(reviewId: string): boolean {
  const review = db.find("prReviews", (r) => r.id === reviewId);
  if (!review) return false;
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  if (!repo) return false;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return false;
  const owner = db.find("users", (u) => u.id === install.userId);
  return !!owner && isDeletionPending(owner);
}

// External-service dependencies, injectable for tests.
export type DeletionDeps = {
  uninstallApp: (installationId: number) => Promise<void>;
  cancelSubscriptionForDeletion: (sub: Subscription) => Promise<void>;
  pauseSubscriptionForDeletion: (sub: Subscription) => Promise<void>;
  resumeSubscriptionAfterRestore: (sub: Subscription) => Promise<void>;
  sendDeletionScheduledEmail: (user: User, purgeAt: number) => Promise<unknown>;
  sendDeletionReminderEmail: (user: User, purgeAt: number) => Promise<unknown>;
  sendAccountPurgedEmail: (user: User) => Promise<unknown>;
};

export const defaultDeletionDeps: DeletionDeps = {
  uninstallApp,
  cancelSubscriptionForDeletion,
  pauseSubscriptionForDeletion,
  resumeSubscriptionAfterRestore,
  sendDeletionScheduledEmail,
  sendDeletionReminderEmail,
  sendAccountPurgedEmail,
};

// Mark the account for deletion: stamp the timestamp (pausing reviews), pause
// billing so no renewal lands during the window, and email the user a restore
// link. Idempotent — a second request while already pending is a no-op. We keep
// the data, subscription, and GitHub App install intact; the hard cancel +
// uninstall + wipe all happen later in purgeAccount.
export async function requestAccountDeletion(
  user: User,
  deps: DeletionDeps = defaultDeletionDeps
): Promise<void> {
  if (isDeletionPending(user)) return;
  const now = Date.now();
  db.update("users", (u) => u.id === user.id, { deletionRequestedAt: now });

  // Best-effort: a billing hiccup shouldn't block the user from deleting. The
  // purge hard-cancels regardless, so the worst case is one more invoice.
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (sub && isStripeConfigured()) {
    try {
      await deps.pauseSubscriptionForDeletion(sub);
    } catch (err) {
      console.error(`[account] pause billing failed for user ${user.id}:`, err);
    }
  }

  await deps.sendDeletionScheduledEmail(user, purgeAtFrom(now));
  track(user, "account deletion requested");
}

// Restore a pending-deletion account: clear the flags (logging in is the
// restore action), resume billing, flag the welcome-back pop-up, and leave a
// durable in-app notice. Reviews resume automatically once the flag is gone.
export async function restoreAccount(
  user: User,
  deps: DeletionDeps = defaultDeletionDeps
): Promise<void> {
  // Setting the keys to undefined drops them from the JSONB row on next flush.
  db.update("users", (u) => u.id === user.id, {
    deletionRequestedAt: undefined,
    reminderSentAt: undefined,
    welcomeBack: true,
  });

  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (sub && isStripeConfigured()) {
    try {
      await deps.resumeSubscriptionAfterRestore(sub);
    } catch (err) {
      console.error(`[account] resume billing failed for user ${user.id}:`, err);
    }
  }

  pushNotification(
    user.id,
    "system",
    "Welcome back",
    "Your account was restored — code review has resumed."
  );
}

// Permanently wipe an account (end of the restore window). This is the original
// account-deletion teardown: external services first so a transient failure
// leaves everything intact and the sweep retries next tick (every step is
// idempotent), then erase local rows. Throws on external failure so the caller
// (runDeletionSweep) logs it and retries — the wipe is never reached in that case.
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

  // ── External teardown first ────────────────────────────────────────────────
  if (sub && isStripeConfigured()) {
    await deps.cancelSubscriptionForDeletion(sub);
  }
  if (isGithubAppConfigured()) {
    for (const install of installs) {
      await deps.uninstallApp(install.installationId);
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

// Periodic sweep (server.ts schedules it): purge accounts past the 14-day window
// and send the day-12 reminder once. Timestamp-driven, so it's restart-safe.
// Each account is isolated in try/catch so one failure can't abort the batch.
export async function runDeletionSweep(deps: DeletionDeps = defaultDeletionDeps): Promise<void> {
  const now = Date.now();
  // Snapshot the candidate list — purgeAccount mutates `users` mid-loop.
  const pending = db.filter("users", (u) => isDeletionPending(u));
  for (const user of pending) {
    const requestedAt = user.deletionRequestedAt!;
    const purgeAt = purgeAtFrom(requestedAt);
    try {
      if (now >= purgeAt) {
        await purgeAccount(user.id, deps);
      } else if (now >= requestedAt + REMINDER_DAY * DAY_MS && !user.reminderSentAt) {
        await deps.sendDeletionReminderEmail(user, purgeAt);
        db.update("users", (u) => u.id === user.id, { reminderSentAt: now });
      }
    } catch (err) {
      console.error(`[account] deletion sweep failed for user ${user.id}:`, err);
    }
  }
}
