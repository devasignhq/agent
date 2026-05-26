// @ts-nocheck
// Persists the PRs the user has most recently opened from the review queue
// so the sidebar's "recent" list reflects actual activity.
import React from "react";

const KEY = "devasign.recentReviews";
const MAX = 8;
const EVENT = "devasign:recents-changed";

export type RecentReview = {
  id: string;        // backend uuid
  uiId: number;      // PR number shown in UI
  repo: string;      // e.g. "acme/pay"
  title: string;
  flag: "blocker" | "review" | "ok";
  ts: number;
};

const read = (): RecentReview[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const write = (list: RecentReview[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore quota / disabled storage */
  }
};

export const pushRecent = (item: Omit<RecentReview, "ts">) => {
  if (!item || !item.id) return;
  const now = Date.now();
  const next = [{ ...item, ts: now }, ...read().filter((r) => r.id !== item.id)].slice(0, MAX);
  write(next);
};

export const useRecentReviews = (limit = 3): RecentReview[] => {
  const [list, setList] = React.useState<RecentReview[]>(() => read());
  React.useEffect(() => {
    const sync = () => setList(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return list.slice(0, limit);
};
