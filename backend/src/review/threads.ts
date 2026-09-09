// Reconciling DevAsign's inline review-comment threads across pushes.
//
// The planner (planReconciliation) is pure and decides everything: which threads
// to edit, which to mark fixed, which items open a new thread, and what overflows
// onto the summary card. reconcileThreads is a thin loop that performs the plan
// and returns the state to persist. Split that way because every interesting rule
// here — the guards against announcing a phantom fix, the caps, the budget — is
// exactly the part that must be testable without a network:
//   node --import tsx/esm --test src/review/threads.test.ts
import { createHash } from "node:crypto";
import {
  createPRReview,
  createPRReviewComment,
  deletePRReviewComment,
  getPRReviewComment,
  listPRReviewComments,
  updatePRReviewComment,
  type BatchedReviewComment,
  type ReviewCommentAnchor,
} from "../github/review-comments.js";
import type { ReviewThread } from "../types.js";
import { resolveAnchor, type Anchor, type LineIndex } from "./anchor.js";
import {
  attributionLine,
  formatResolvedThreadBody,
  formatThreadBody,
  parseItemMarker,
  parseResolvedMarker,
  type ThreadBodyOpts,
} from "./comment.js";
import type { ReviewItem, ReviewItemCategory, ReviewStage } from "./items.js";

// Lifetime ceiling on threads for one PR, and the per-run write budget. GitHub's
// secondary limit is ~80 content-creating requests a minute and 500 an hour, and
// the pipeline already spends a dozen calls elsewhere, so the run budget is the
// one that actually protects us — two reviews in the same minute must not trip it.
export const MAX_OPEN_THREADS_PER_PR = 40;
export const MAX_THREAD_WRITES_PER_RUN = 25;

// Per-category ceilings so one noisy advisory stage can't crowd out the criteria
// and bugs that people actually act on. Criteria are uncapped: they are the point.
export const PER_CATEGORY_CAP: Record<ReviewItemCategory, number> = {
  criterion: Infinity,
  regression: Infinity,
  criticalError: Infinity,
  defect: 15,
  security: 15,
  commitIntent: 5,
  deferral: 5,
  convention: 5,
  docDrift: 3,
  crossRepo: 3,
  parity: 0,
  lineNote: 10,
};

// How many consecutive qualifying runs may fail to report an item before its
// thread is marked fixed. One, so a real fix shows up on the push that fixed it:
// making every genuine fix wait two pushes to avoid an occasional flake trades a
// certain annoyance for a rare one. The guards below (stage ran, sha moved, diff
// non-empty) are what make one safe; raise this if flip-flopping shows up.
export const THREAD_MISS_THRESHOLD = 1;

// Display order for spending the write budget — most consequential first, so a
// truncated run still says the things that matter.
const CATEGORY_PRIORITY: ReviewItemCategory[] = [
  "criterion",
  "regression",
  "criticalError",
  "security",
  "defect",
  "commitIntent",
  "deferral",
  "crossRepo",
  "convention",
  "docDrift",
  "parity",
  "lineNote",
];
const SEVERITY_PRIORITY = { blocker: 0, warn: 1, nit: 2 } as const;

export type FixAttribution =
  | { kind: "commit"; sha: string; url: string; message?: string }
  | { kind: "range"; base: string; head: string; url: string; count: number }
  | { kind: "head"; sha: string; url: string };

export type ThreadOp =
  | { op: "create"; item: ReviewItem; anchor: Anchor; body: string }
  | {
      op: "update";
      thread: ReviewThread;
      item: ReviewItem;
      body: string;
      // false when the rendered body is byte-identical to what's already there:
      // state still refreshes, but no API call is made.
      changed: boolean;
    }
  // The body is built at apply time, not here: collapsing "what this was"
  // needs the thread's current body, which only the IO layer can read back.
  | {
      op: "resolve";
      thread: ReviewThread;
      sha: string;
      attribution: FixAttribution | { kind: "gone"; path: string; sha: string; url: string };
    }
  // Absent this run but not yet resolved: state-only, no API call.
  | { op: "miss"; thread: ReviewThread }
  // Left untouched — the stage that owns it didn't run, so its absence means
  // nothing. Still counted on the card so the reader isn't told it went away.
  | { op: "carry"; thread: ReviewThread }
  | { op: "overflow"; item: ReviewItem; reason: "cap" | "unanchorable" | "budget" };

export type ReconciliationPlan = {
  ops: ThreadOp[];
  // What the summary card should count, including threads carried over from a
  // stage that didn't re-run this time.
  openForCounting: Array<Pick<ReviewItem, "category" | "state">>;
  fixedCount: number;
  unanchorable: ReviewItem[];
  overflowed: ReviewItem[];
};

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

function anchorFor(item: ReviewItem, index: LineIndex): Anchor {
  return resolveAnchor({ path: item.path, line: item.line }, index);
}

function bodyOptsFor(anchor: Anchor, reopened: boolean): ThreadBodyOpts {
  return {
    reopened,
    snappedFrom: anchor.kind === "line" ? anchor.snappedFrom : undefined,
  };
}

function sortForBudget(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => {
    const cat = CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category);
    if (cat !== 0) return cat;
    return SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity];
  });
}

export function planReconciliation(args: {
  items: ReviewItem[];
  threads: ReviewThread[];
  index: LineIndex;
  headSha: string;
  // Stages that actually produced a result this run. A thread owned by a stage
  // that didn't run is never read as fixed.
  stagesRun: Set<ReviewStage>;
  attribution: FixAttribution;
  // Link builder for the "no longer in this PR" wording.
  commitUrl: (sha: string) => string;
  caps?: Partial<Record<ReviewItemCategory, number>>;
  budget?: number;
  maxOpen?: number;
}): ReconciliationPlan {
  const { items, threads, index, headSha, stagesRun, attribution } = args;
  const caps = { ...PER_CATEGORY_CAP, ...(args.caps ?? {}) };
  let budget = args.budget ?? MAX_THREAD_WRITES_PER_RUN;
  const maxOpen = args.maxOpen ?? MAX_OPEN_THREADS_PER_PR;

  const byKey = new Map(items.map((i) => [i.key, i]));
  const ops: ThreadOp[] = [];
  const openForCounting: Array<Pick<ReviewItem, "category" | "state">> = items.map((i) => ({
    category: i.category,
    state: i.state,
  }));
  let fixedCount = 0;

  // ── Existing threads ────────────────────────────────────────────────────
  for (const thread of threads) {
    const item = byKey.get(thread.key);
    if (item) {
      const anchor = anchorFor(item, index);
      // A criterion that just flipped to met is a fix, even though its thread
      // stays open so the reader can see it pass. `state` can't say this — it
      // only tracks whether we're still reporting the item at all.
      const justFixed = thread.itemState === "open" && item.state === "met";
      if (justFixed) fixedCount++;
      const body = formatThreadBody(item, {
        ...bodyOptsFor(anchor, thread.state === "resolved"),
        fixedIn: justFixed ? attributionLine(attribution) : null,
      });
      const changed = bodyHash(body) !== thread.bodyHash || thread.state === "resolved";
      if (changed && budget <= 0) {
        ops.push({ op: "update", thread, item, body, changed: false });
      } else {
        if (changed) budget--;
        ops.push({ op: "update", thread, item, body, changed });
      }
      continue;
    }

    // Absent this run. Work out whether that means anything.
    if (thread.state === "resolved") {
      ops.push({ op: "carry", thread });
      continue;
    }
    // Rebuilt from GitHub after the stored rows were lost: it doesn't know which
    // stage owns it, so its absence proves nothing until it is reported again.
    if (thread.recovered) {
      ops.push({ op: "carry", thread });
      openForCounting.push({ category: thread.category, state: "open" });
      continue;
    }
    // The stage that owns it didn't run — a toggled-off or thrown stage is not
    // evidence of a fix. Leave the thread exactly as it is, but keep counting it.
    if (!stagesRun.has(thread.stage)) {
      ops.push({ op: "carry", thread });
      openForCounting.push({ category: thread.category, state: "open" });
      continue;
    }
    // Same commit as the last time we saw it: a rerun, not a new push. Nothing
    // changed in the code, so an absence here is model noise, never a fix.
    if (thread.lastSeenSha === headSha) {
      ops.push({ op: "carry", thread });
      openForCounting.push({ category: thread.category, state: "open" });
      continue;
    }

    const missCount = thread.missCount + 1;
    if (missCount < THREAD_MISS_THRESHOLD) {
      ops.push({ op: "miss", thread });
      continue;
    }
    if (budget <= 0) {
      ops.push({ op: "miss", thread });
      continue;
    }
    // The file left the PR entirely — a real resolution, but a different one:
    // say the finding no longer applies rather than claiming someone fixed it.
    const gone = thread.path ? !index.has(thread.path) : false;
    budget--;
    fixedCount++;
    ops.push({
      op: "resolve",
      thread,
      sha: headSha,
      attribution: gone
        ? { kind: "gone" as const, path: thread.path!, sha: headSha, url: args.commitUrl(headSha) }
        : attribution,
    });
  }

  // ── New items ───────────────────────────────────────────────────────────
  const known = new Set(threads.map((t) => t.key));
  const perCategory = new Map<ReviewItemCategory, number>();
  for (const t of threads) {
    if (t.state === "open") perCategory.set(t.category, (perCategory.get(t.category) ?? 0) + 1);
  }
  let openThreads = threads.filter((t) => t.state === "open").length;
  const unanchorable: ReviewItem[] = [];
  const overflowed: ReviewItem[] = [];

  for (const item of sortForBudget(items.filter((i) => !known.has(i.key)))) {
    const anchor = anchorFor(item, index);
    if (anchor.kind === "none") {
      unanchorable.push(item);
      ops.push({ op: "overflow", item, reason: "unanchorable" });
      continue;
    }
    const used = perCategory.get(item.category) ?? 0;
    if (used >= (caps[item.category] ?? Infinity) || openThreads >= maxOpen) {
      overflowed.push(item);
      ops.push({ op: "overflow", item, reason: "cap" });
      continue;
    }
    if (budget <= 0) {
      overflowed.push(item);
      ops.push({ op: "overflow", item, reason: "budget" });
      continue;
    }
    budget--;
    openThreads++;
    perCategory.set(item.category, used + 1);
    ops.push({ op: "create", item, anchor, body: formatThreadBody(item, bodyOptsFor(anchor, false)) });
  }

  return { ops, openForCounting, fixedCount, unanchorable, overflowed };
}

// ── Applying the plan ──────────────────────────────────────────────────────

function threadFrom(
  item: ReviewItem,
  anchor: Anchor,
  commentId: number,
  body: string,
  headSha: string
): ReviewThread {
  return {
    key: item.key,
    commentId,
    state: "open",
    category: item.category,
    severity: item.severity,
    stage: item.stage,
    itemState: item.state,
    title: item.title,
    path: anchor.kind === "none" ? undefined : anchor.path,
    line: anchor.kind === "line" ? anchor.line : undefined,
    anchor: anchor.kind === "line" ? "line" : "file",
    firstSeenSha: headSha,
    lastSeenSha: headSha,
    missCount: 0,
    bodyHash: bodyHash(body),
    updatedAt: Date.now(),
  };
}

export type ReconcileResult = {
  threads: ReviewThread[];
  created: number;
  updated: number;
  resolved: number;
  // True when GitHub told us to stop writing (secondary rate limit). The caller
  // renders the remainder on the summary card rather than half-spraying threads.
  aborted: boolean;
  // The batched review was refused and its threads were opened one at a time.
  fellBack: boolean;
  // The batch's outcome is unknown (it may have posted); the next run must
  // rebuild thread ids from GitHub before creating anything.
  recoveryNeeded: boolean;
};

export type ThreadIO = Pick<
  typeof import("../github/review-comments.js"),
  "createPRReview" | "createPRReviewComment" | "updatePRReviewComment" | "getPRReviewComment"
>;

const defaultIO: ThreadIO = {
  createPRReview,
  createPRReviewComment,
  updatePRReviewComment,
  getPRReviewComment,
};

type CreateOp = Extract<ThreadOp, { op: "create" }>;

export async function reconcileThreads(
  args: {
    installationId: number;
    owner: string;
    name: string;
    prNumber: number;
    headSha: string;
    plan: ReconciliationPlan;
  },
  io: ThreadIO = defaultIO
): Promise<ReconcileResult> {
  const { installationId, owner, name, prNumber, headSha, plan } = args;
  const out: ReviewThread[] = [];
  let created = 0;
  let updated = 0;
  let resolved = 0;
  let aborted = false;
  let fellBack = false;
  let recoveryNeeded = false;
  const lineCreates: CreateOp[] = [];
  const fileCreates: CreateOp[] = [];

  for (const op of plan.ops) {
    switch (op.op) {
      case "carry":
        out.push(op.thread);
        break;
      case "miss":
        out.push({
          ...op.thread,
          missCount: op.thread.missCount + 1,
          missingSinceSha: op.thread.missingSinceSha ?? headSha,
          updatedAt: Date.now(),
        });
        break;
      case "update": {
        if (!op.changed) {
          out.push({
            ...op.thread,
            itemState: op.item.state,
            title: op.item.title,
            lastSeenSha: headSha,
            missCount: 0,
            updatedAt: Date.now(),
          });
          break;
        }
        const res = await io.updatePRReviewComment(
          installationId,
          owner,
          name,
          op.thread.commentId,
          op.body
        );
        if (res === "gone") break; // comment deleted by a human — drop the state
        if (res === "ok") updated++;
        out.push({
          ...op.thread,
          state: "open",
          itemState: op.item.state,
          title: op.item.title,
          category: op.item.category,
          severity: op.item.severity,
          stage: op.item.stage,
          recovered: undefined,
          lastSeenSha: headSha,
          missCount: 0,
          missingSinceSha: undefined,
          resolvedAtSha: undefined,
          resolvedAt: undefined,
          bodyHash: res === "ok" ? bodyHash(op.body) : op.thread.bodyHash,
          updatedAt: Date.now(),
        });
        break;
      }
      case "resolve": {
        // Read the thread back so the "What this was" block collapses the real
        // detail rather than a reconstruction — the item is gone from this run,
        // so its body exists only on GitHub.
        const current = await io.getPRReviewComment(installationId, owner, name, op.thread.commentId);
        if (current === "gone") break;
        const body = formatResolvedThreadBody({
          item: { key: op.thread.key, title: op.thread.title, category: op.thread.category },
          openBody: current ?? "",
          sha: op.sha,
          attribution: op.attribution,
        });
        const res = await io.updatePRReviewComment(
          installationId,
          owner,
          name,
          op.thread.commentId,
          body
        );
        if (res === "gone") break;
        if (res === "ok") resolved++;
        out.push({
          ...op.thread,
          state: res === "ok" ? "resolved" : "open",
          missCount: op.thread.missCount + 1,
          missingSinceSha: op.thread.missingSinceSha ?? headSha,
          resolvedAtSha: res === "ok" ? op.sha : undefined,
          resolvedAt: res === "ok" ? Date.now() : undefined,
          bodyHash: res === "ok" ? bodyHash(body) : op.thread.bodyHash,
          updatedAt: Date.now(),
        });
        break;
      }
      case "create":
        if (op.anchor.kind === "line") lineCreates.push(op);
        else if (op.anchor.kind === "file") fileCreates.push(op);
        break;
      case "overflow":
        break;
    }
  }

  // One comment at a time, with a file-level retry when the anchor lost a race
  // with the diff we planned against. Never retries the same payload.
  const createOne = async (op: CreateOp): Promise<void> => {
    if (op.anchor.kind === "none" || aborted) return;
    const anchor: ReviewCommentAnchor =
      op.anchor.kind === "line"
        ? { kind: "line", path: op.anchor.path, line: op.anchor.line, side: "RIGHT" }
        : { kind: "file", path: op.anchor.path };
    let res = await io.createPRReviewComment(installationId, owner, name, prNumber, {
      body: op.body,
      commitId: headSha,
      anchor,
    });
    if ("error" in res && res.error === "anchor" && anchor.kind === "line") {
      res = await io.createPRReviewComment(installationId, owner, name, prNumber, {
        body: op.body,
        commitId: headSha,
        anchor: { kind: "file", path: anchor.path },
      });
    }
    if ("error" in res) {
      if (res.error === "rate_limit") aborted = true;
      return;
    }
    created++;
    out.push(threadFrom(op.item, op.anchor, res.id, op.body, headSha));
  };

  // New line-anchored threads go up as one review so the timeline shows a single
  // "reviewed" event. Comment ids come back from a listing, matched by marker.
  if (lineCreates.length) {
    const comments: BatchedReviewComment[] = lineCreates.map((op) => ({
      path: (op.anchor as Extract<Anchor, { kind: "line" }>).path,
      line: (op.anchor as Extract<Anchor, { kind: "line" }>).line,
      side: "RIGHT",
      body: op.body,
    }));
    const res = await io.createPRReview(installationId, owner, name, prNumber, {
      commitId: headSha,
      comments,
    });
    if ("error" in res) {
      if (res.error === "anchor") {
        fellBack = true;
        for (const op of lineCreates) await createOne(op);
      } else if (res.error === "rate_limit") {
        aborted = true;
      } else {
        recoveryNeeded = true;
      }
    } else {
      const byKey = new Map<string, number>();
      for (const c of res.comments) {
        const key = parseItemMarker(c.body);
        if (key) byKey.set(key, c.id);
      }
      for (const op of lineCreates) {
        const id = byKey.get(op.item.key);
        if (id == null) {
          console.warn(`[review] batched review ${res.reviewId} returned no comment for ${op.item.key}`);
          recoveryNeeded = true;
          continue;
        }
        created++;
        out.push(threadFrom(op.item, op.anchor, id, op.body, headSha));
      }
    }
  }
  // File-level anchors cannot ride in comments[]; they stay separate posts.
  for (const op of fileCreates) await createOne(op);

  return { threads: out, created, updated, resolved, aborted, fellBack, recoveryNeeded };
}

// Rebuild thread state from the PR itself. Only worth doing when the stored rows
// are gone but we know we've reviewed before — otherwise the threads we'd be
// looking for don't exist yet, and the listing is a wasted round trip.
export async function loadThreadsFromGitHub(args: {
  installationId: number;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
}): Promise<ReviewThread[] | null> {
  const rows = await listPRReviewComments(
    args.installationId,
    args.owner,
    args.name,
    args.prNumber
  );
  if (!rows) return null;
  const threads: ReviewThread[] = [];
  for (const row of rows) {
    if (row.inReplyToId) continue; // a reply, not the head of one of our threads
    const key = parseItemMarker(row.body);
    if (!key) continue;
    const resolvedSha = parseResolvedMarker(row.body);
    threads.push({
      key,
      commentId: row.id,
      state: resolvedSha ? "resolved" : "open",
      itemState: "open",
      title: row.path || "this finding",
      // The marker carries the key, not the taxonomy. These are placeholders,
      // refreshed the first time the item is reported again; `recovered` stops
      // the planner acting on them before that happens.
      recovered: true,
      category: "defect",
      severity: "warn",
      stage: "defects",
      path: row.path || undefined,
      line: row.line ?? row.originalLine ?? undefined,
      anchor: row.line == null && row.originalLine == null ? "file" : "line",
      firstSeenSha: args.headSha,
      lastSeenSha: args.headSha,
      missCount: 0,
      resolvedAtSha: resolvedSha ?? undefined,
      bodyHash: bodyHash(row.body),
      updatedAt: Date.now(),
    });
  }
  return threads;
}

export { deletePRReviewComment };
