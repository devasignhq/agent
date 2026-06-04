// REST API for the frontend.
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { enqueueIndex, enqueueMaintainerFeedback, enqueueReview } from "../queue.js";
import { getSessionUser } from "../github/oauth.js";
import { appJWT, gh } from "../github/app.js";
import { config, isGithubAppConfigured, isLLMLive, isStripeConfigured } from "../config.js";
import { postBugFixCommentForAttachment } from "../review/pipeline.js";
import { fetchLinearTeams } from "../linear/client.js";
import { detectVideoProvider } from "../llm.js";
import { cancelScheduledChange, changePlan, createCheckoutSession, createPortalSession } from "../billing/stripe.js";
import { effectivePlan, PLAN_LIMITS } from "../billing/plans.js";
import {
  markAllRead,
  notificationsForUser,
  notifyForReview,
  unreadCountForUser,
} from "../notifications.js";

export const api = Router();

// --- Identity ---

api.get("/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not_signed_in" });
    return;
  }
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  res.json({ user, subscription: sub });
});

api.get("/health", (_req, res) => {
  res.json({
    ok: true,
    llm: isLLMLive() ? "live" : "mock",
    githubApp: isGithubAppConfigured() ? "configured" : "missing",
    githubAppName: config.github.appName,
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
  res.json(db.filter("installations", (i) => i.userId === user.id));
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

  // Only auto-claim installs on the user's personal account; org installs
  // require explicit linking via the popup-handshake (to avoid claiming
  // someone else's org).
  const owned = apps.filter((inst) => inst?.account?.id === user.githubId);

  // Up-front DB writes for each owned install — single-threaded reads/writes
  // against the in-memory DB stay deterministic this way. The slow part —
  // /installation/repositories — runs in parallel below.
  const rows = owned.map((inst) => {
    let row = db.find("installations", (i) => i.installationId === inst.id);
    if (!row) {
      row = {
        id: uuid(),
        userId: user.id,
        accountId: inst.account.id,
        accountLogin: inst.account.login,
        installationId: inst.id,
        repoIds: [],
      };
      db.insert("installations", row);
    } else if (!row.userId) {
      db.update("installations", (i) => i.id === row!.id, { userId: user.id });
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

// Used by the onboarding GitHub-install screen to link a pending install to
// the signed-in user. Normally the install webhook lands first and leaves
// userId="" — but the popup-handshake can outrace the webhook (especially via
// smee in dev), so we also pull live install + repo data from GitHub here
// using the App's installation token. That way the onboarding repo browser
// never has to wait for a webhook to arrive.
api.post("/installations/:installationId/link", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const id = Number(req.params.installationId);

  let install = db.find("installations", (i) => i.installationId === id);

  // Fetch install metadata + repo list from GitHub. This works even when the
  // webhook hasn't landed yet, and self-corrects stale rows from a prior install.
  let liveInstall: any = null;
  let liveRepos: Array<any> = [];
  try {
    liveInstall = await gh<any>(id, `/app/installations/${id}`);
  } catch (err) {
    // Couldn't reach GitHub (e.g. app not configured in dev). If we don't
    // have a webhook-created row either, surface 404 like before.
    if (!install) {
      console.warn("[link] couldn't reach GitHub and no webhook row:", err);
      return void res.status(404).json({ error: "install_not_found" });
    }
  }
  try {
    const reposResp = await gh<any>(id, "/installation/repositories?per_page=100");
    liveRepos = reposResp?.repositories || [];
  } catch (err) {
    console.warn("[link] couldn't list repos:", err);
  }

  if (!install) {
    install = {
      id: uuid(),
      userId: user.id,
      accountId: liveInstall?.account?.id ?? 0,
      accountLogin: liveInstall?.account?.login ?? "unknown",
      installationId: id,
      repoIds: liveRepos.map((r) => r.id),
    };
    db.insert("installations", install);
  } else {
    db.update("installations", (i) => i.id === install!.id, {
      userId: user.id,
      accountId: liveInstall?.account?.id ?? install.accountId,
      accountLogin: liveInstall?.account?.login ?? install.accountLogin,
      repoIds: liveRepos.length ? liveRepos.map((r) => r.id) : install.repoIds,
    });
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
});

api.get("/repositories", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const installs = db.filter("installations", (i) => i.userId === user.id);
  const installIds = new Set(installs.map((i) => i.id));
  res.json(db.filter("repositories", (r) => installIds.has(r.installationId)));
});

// Trigger a full repo re-index. Useful when the indexer prompt or allow-list
// changes, or when QA wants to observe the build without waiting for a webhook.
api.post("/repositories/:id/reindex", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  // Owner-scoped: refuse if the repo doesn't belong to this user's installs.
  const installs = db.filter("installations", (i) => i.userId === user.id);
  if (!installs.some((i) => i.id === repo.installationId)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  db.update("repositories", (r) => r.id === repo.id, { indexState: "queued", indexError: null });
  const job = enqueueIndex({ repoId: repo.id, full: true });
  res.json({ ok: true, jobId: job.id });
});

// --- PR Reviews (the agent's queue) ---

api.get("/reviews", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const status = req.query.status as string | undefined;
  const installs = db.filter("installations", (i) => i.userId === user.id);
  const repos = db.filter("repositories", (r) =>
    installs.some((i) => i.id === r.installationId)
  );
  const repoIds = new Set(repos.map((r) => r.id));
  let reviews = db.filter("prReviews", (r) => repoIds.has(r.repoId));
  if (status) reviews = reviews.filter((r) => r.status === status);
  reviews.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(reviews);
});

api.get("/reviews/:id", (req, res) => {
  const review = db.find("prReviews", (r) => r.id === req.params.id);
  if (!review) return void res.status(404).json({ error: "review_not_found" });
  const logs = db.filter("reviewLogs", (l) => l.reviewId === review.id).sort((a, b) => a.at - b.at);
  const task = review.taskId ? db.find("tasks", (t) => t.id === review.taskId) : null;
  res.json({ review, logs, task });
});

// Re-run a review (e.g. after the user attached a Loom and updated the task).
api.post("/reviews/:id/rerun", (req, res) => {
  const review = db.find("prReviews", (r) => r.id === req.params.id);
  if (!review) return void res.status(404).json({ error: "review_not_found" });
  db.update("prReviews", (r) => r.id === review.id, { status: "queued" });
  enqueueReview(review.id);
  res.json({ ok: true });
});

// Pull open PRs from every connected repo and ensure each one has a PRReview
// row in the queue. Newly-discovered PRs are enqueued for review immediately.
// Idempotent: PRs we've already seen are left alone (the user can hit "Re-run"
// on the card if they want a fresh pass).
api.post("/reviews/sync", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });

  const installs = db.filter("installations", (i) => i.userId === user.id);
  const repos = db.filter("repositories", (r) =>
    installs.some((i) => i.id === r.installationId)
  );

  let discovered = 0;
  let enqueued = 0;
  const errors: Array<{ repo: string; message: string }> = [];

  for (const repo of repos) {
    const install = installs.find((i) => i.id === repo.installationId);
    if (!install) continue;
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

api.get("/tasks/:id", (req, res) => {
  const task = db.find("tasks", (t) => t.id === req.params.id);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
  res.json(task);
});

// Adds an attachment (Loom link, Figma URL, image, PDF, plain text) to a task.
// Mirrors the Message-agent screen in the design.
api.post("/tasks/:id/attachments", (req, res) => {
  const task = db.find("tasks", (t) => t.id === req.params.id);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
  const { kind, url, note } = req.body || {};
  if (!kind) return void res.status(400).json({ error: "kind_required" });
  const att = { id: uuid(), kind, url, note, createdAt: Date.now() };
  // Non-text kinds (videos, docs, images, PDFs) genuinely reshape the brief
  // and warrant a fresh criteria synthesis. Plain text messages from the
  // composer go through the lighter maintainer-feedback path below, which
  // decides for itself whether `endGoal` should change.
  const patch: any = { attachments: [...task.attachments, att] };
  if (kind !== "text") patch.endGoal = null;
  db.update("tasks", (t) => t.id === task.id, patch);

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
    const reviews = db
      .filter("prReviews", (r) => r.taskId === task.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const review = reviews[0];
    if (review) {
      const user = getSessionUser(req);
      const comment = {
        body: note.trim(),
        author: user?.githubLogin || "user",
        authorAssociation: "OWNER",
        sourceUrl: "",
        sourceEvent: "in_app_message" as const,
      };
      // Immediate timeline entry so the user sees their message land before
      // the Opus round-trip resolves. Mirrors the webhook path that logs
      // `comment.received` on every maintainer-comment ingest.
      db.insert("reviewLogs", {
        id: uuid(),
        reviewId: review.id,
        kind: "ingest",
        at: Date.now(),
        action: "comment.received",
        target: comment.author,
        detail: comment.body.slice(0, 240),
        meta: { sourceEvent: comment.sourceEvent },
      });
      enqueueMaintainerFeedback(review.id, comment);
    }
  }

  res.json({ ok: true, attachment: att });
});

// Removes an attachment from a task's end-goal. We do more than just splice
// the array: we also invalidate `task.endGoal` and clear `review.criteria`
// on any linked PR review, then re-queue the review. That undoes the context
// (synthesised end goal + per-criterion checks) that this attachment seeded.
api.delete("/tasks/:taskId/attachments/:attachmentId", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const task = db.find("tasks", (t) => t.id === req.params.taskId);
  if (!task) return void res.status(404).json({ error: "task_not_found" });
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
  const linkedReviews = db.filter("prReviews", (r) => r.taskId === task.id);
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
});

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

api.post("/integrations", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const { type, tokens, workspaceMeta } = req.body || {};
  if (!type || !tokens) return void res.status(400).json({ error: "type_and_tokens_required" });
  const row = {
    id: uuid(),
    userId: user.id,
    type,
    tokens,
    workspaceMeta: workspaceMeta || {},
    createdAt: Date.now(),
  };
  db.insert("integrations", row);
  res.json({ ok: true, id: row.id });
});

api.delete("/integrations/:id", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  // Linear webhooks are app-level (not per-connect), so disconnecting just drops
  // the row; the app keeps delivering but the org no longer resolves to a token,
  // and the webhook handler acknowledges + ignores it.
  db.remove("integrations", (i) => i.id === req.params.id && i.userId === user.id);
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

// --- Billing (Stripe) ---

// Enriched subscription view for the Billing settings page: the row plus the
// effective plan (after any lapse-downgrade) and the monthly review allowance
// + usage. `reviewLimit: null` means unlimited (Max).
api.get("/billing/subscription", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  const plan = effectivePlan(sub);
  const limits = PLAN_LIMITS[plan];
  res.json({
    subscription: sub ?? null,
    effectivePlan: plan,
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
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub) return void res.status(404).json({ error: "no_subscription" });
  try {
    const url = await createCheckoutSession(user, sub, plan);
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
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  // Must have an active paid plan to switch; free/lapsed users subscribe via checkout.
  if (!sub?.stripeSubscriptionId || effectivePlan(sub) === "free") {
    return void res.status(404).json({ error: "no_active_subscription", message: "Start a plan first." });
  }
  if (effectivePlan(sub) === plan) {
    return void res.status(400).json({ error: "already_on_plan" });
  }
  try {
    await changePlan(sub, plan, Boolean(req.body?.immediate));
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

// Frontend polls this every ~10s (visibility-aware) to refresh the bell.
api.get("/notifications", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  res.json({
    items: notificationsForUser(user.id, 50),
    unreadCount: unreadCountForUser(user.id),
  });
});

// "Mark all read" button. Returns how many rows were actually flipped — the
// frontend uses that to optimistically zero the badge.
api.post("/notifications/read", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const marked = markAllRead(user.id);
  res.json({ ok: true, marked });
});
