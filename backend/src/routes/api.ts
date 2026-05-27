// REST API for the frontend.
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { enqueueIndex, enqueueReview } from "../queue.js";
import { getSessionUser } from "../github/oauth.js";
import { gh } from "../github/app.js";
import { config, isGithubAppConfigured, isLLMLive } from "../config.js";
import { postBugFixCommentForAttachment } from "../review/pipeline.js";
import { detectVideoProvider } from "../llm.js";

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
  await reconcileInstallsForUser(user).catch((err) =>
    console.warn("[installations] reconcile failed:", err)
  );
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
    const { appJWT } = await import("../github/app.js");
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
  for (const inst of apps) {
    // Only auto-claim installs on the user's personal account; org installs
    // require explicit linking via the popup-handshake (to avoid claiming
    // someone else's org).
    if (inst?.account?.id !== user.githubId) continue;
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
    // Materialise repos for this install.
    try {
      const reposResp = await gh<any>(inst.id, "/installation/repositories?per_page=100");
      const repos = reposResp?.repositories || [];
      const ids = repos.map((r: any) => r.id);
      db.update("installations", (i) => i.id === row!.id, { repoIds: ids });
      for (const r of repos) {
        const [owner, name] = String(r.full_name || "").split("/");
        if (!owner || !name) continue;
        const existing = db.find(
          "repositories",
          (x) => x.owner === owner && x.name === name
        );
        if (existing) {
          if (existing.installationId !== row!.id) {
            db.update("repositories", (x) => x.id === existing.id, { installationId: row!.id });
          }
          continue;
        }
        const inserted = db.insert("repositories", {
          id: uuid(),
          installationId: row!.id,
          owner,
          name,
          defaultBranch: r.default_branch || "main",
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
  }
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
      if (existing.installationId !== install!.id || existing.defaultBranch !== (r.default_branch || existing.defaultBranch)) {
        db.update("repositories", (x) => x.id === existing.id, {
          installationId: install!.id,
          defaultBranch: r.default_branch || existing.defaultBranch,
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

api.patch("/repositories/:id", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const repo = db.find("repositories", (r) => r.id === req.params.id);
  if (!repo) return void res.status(404).json({ error: "repo_not_found" });
  const allowed = ["defaultModel", "modelOverrides", "reviewsEnabled"] as const;
  const patch: any = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  res.json(db.update("repositories", (r) => r.id === repo.id, patch));
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
  const att = { kind, url, note };
  db.update("tasks", (t) => t.id === task.id, {
    attachments: [...task.attachments, att],
    endGoal: null, // invalidate so the next review re-synthesises
  });
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
  res.json({ ok: true, attachment: att });
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
  db.remove("integrations", (i) => i.id === req.params.id && i.userId === user.id);
  res.json({ ok: true });
});

// --- Billing (Stripe stub) ---

api.get("/billing/subscription", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  res.json(db.find("subscriptions", (s) => s.userId === user.id));
});

// Simulate a credit top-up. Real Stripe would happen via webhook → grant credits.
api.post("/billing/credits", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return void res.status(401).json({ error: "not_signed_in" });
  const sub = db.find("subscriptions", (s) => s.userId === user.id);
  if (!sub) return void res.status(404).json({ error: "no_subscription" });
  const add = Math.max(0, Math.floor(Number(req.body?.add) || 0));
  db.update("subscriptions", (s) => s.id === sub.id, { credits: sub.credits + add });
  res.json({ ok: true });
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
