// App-level notifications that drive the bell + popover in the dashboard.
// Server-stored so the unread badge stays consistent across tabs and the
// notification feed survives page reloads. Creation and read-state changes push
// a live "changed" signal to the user's open SSE streams (notifications-stream.ts)
// so the dashboard refetches on demand instead of polling on a timer.
import { v4 as uuid } from "uuid";
import { db } from "./db.js";
import { notifyUser } from "./notifications-stream.js";
import type { Notification, NotificationKind } from "./types.js";

// Insert a notification row for a specific user. Returns the inserted row,
// or null when there's no user to attach it to (unclaimed install — same
// defensive stance the rest of the codebase takes for missing FKs).
export function pushNotification(
  userId: string,
  kind: NotificationKind,
  title: string,
  meta: string,
  opts: { link?: string; reviewId?: string } = {}
): Notification | null {
  if (!userId) return null;
  const row: Notification = {
    id: uuid(),
    userId,
    kind,
    title,
    meta,
    link: opts.link,
    reviewId: opts.reviewId,
    createdAt: Date.now(),
    readAt: null,
  };
  db.insert("notifications", row);
  notifyUser(userId); // push the live "changed" signal to this user's open streams
  return row;
}

// Resolve review → repo → installation → userId and emit a notification for
// the install owner. Used at all four PR-related call sites (handlePullRequest,
// ensurePRReview, /reviews/sync, runReviewJob terminal status).
export function notifyForReview(
  reviewId: string,
  kind: NotificationKind,
  title: string,
  meta: string,
  link?: string
): Notification | null {
  const review = db.find("prReviews", (r) => r.id === reviewId);
  if (!review) return null;
  const repo = db.find("repositories", (r) => r.id === review.repoId);
  if (!repo) return null;
  const install = db.find("installations", (i) => i.id === repo.installationId);
  if (!install) return null;
  return pushNotification(install.userId, kind, title, meta, {
    link: link || `/reviews/${review.id}`,
    reviewId: review.id,
  });
}

// Most recent notifications for a user, newest first, capped at `limit`.
export function notificationsForUser(userId: string, limit = 50): Notification[] {
  return db
    .filter("notifications", (n) => n.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// Number of unread notifications for the user — drives the bell badge count.
export function unreadCountForUser(userId: string): number {
  return db.filter("notifications", (n) => n.userId === userId && n.readAt === null).length;
}

// Stamp every unread notification for the user with the current time. Returns
// the count of rows that were actually flipped (i.e. previously unread).
export function markAllRead(userId: string): number {
  const now = Date.now();
  const unread = db.filter(
    "notifications",
    (n) => n.userId === userId && n.readAt === null
  );
  for (const row of unread) {
    db.update("notifications", (n) => n.id === row.id, { readAt: now });
  }
  // Let other open tabs of the same user clear their badge without waiting on
  // the fallback poll. Only signal when something actually flipped.
  if (unread.length > 0) notifyUser(userId);
  return unread.length;
}
