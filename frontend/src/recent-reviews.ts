// @ts-nocheck
// Persists the PRs the user has most recently opened from the review queue
// so the sidebar's "recent" list reflects actual activity. The list is scoped
// per signed-in user, so a different account on the same browser never inherits
// another user's recents.
import React from "react";

const KEY_PREFIX = "devasign.recentReviews";
const MAX = 8;
const EVENT = "devasign:recents-changed";

// A falsy userId yields no key, which makes read/write no-ops. That keeps the
// signed-out / loading states empty and avoids creating a stray bare key.
const keyFor = (userId?: string | null): string | null =>
  userId ? `${KEY_PREFIX}:${userId}` : null;

export type RecentReview = {
  id: string;        // backend uuid
  uiId: number;      // PR number shown in UI
  repo: string;      // e.g. "acme/pay"
  title: string;
  flag: "blocker" | "review" | "ok";
  ts: number;
};

const read = (userId?: string | null): RecentReview[] => {
  if (typeof window === "undefined") return [];
  const key = keyFor(userId);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const write = (userId: string | null | undefined, list: RecentReview[]) => {
  if (typeof window === "undefined") return;
  const key = keyFor(userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore quota / disabled storage */
  }
};

export const pushRecent = (
  userId: string | null | undefined,
  item: Omit<RecentReview, "ts">
) => {
  if (!userId || !item || !item.id) return;
  const now = Date.now();
  const next = [{ ...item, ts: now }, ...read(userId).filter((r) => r.id !== item.id)].slice(0, MAX);
  write(userId, next);
};

export const useRecentReviews = (userId?: string | null, limit = 3): RecentReview[] => {
  const [list, setList] = React.useState<RecentReview[]>(() => read(userId));
  React.useEffect(() => {
    // Re-read whenever the user changes (login / logout / account switch).
    setList(read(userId));
    const sync = () => setList(read(userId));
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [userId]);
  return list.slice(0, limit);
};
