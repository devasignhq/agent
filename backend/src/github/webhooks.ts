// GitHub webhook receiver. Verifies HMAC, then enqueues review jobs.
// Spec: devasign.md §5 — webhook must be thin; reviews run in worker.
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { gh, postPRComment } from "./app.js";
import { enqueueIndex, enqueueMaintainerFeedback, enqueueReview } from "../queue.js";
import { effectiveWorkflow } from "../review/workflow.js";
import { triggerOutcome } from "../review/decisions.js";
import { notifyForReview } from "../notifications.js";
import {
  PLAN_LIMITS,
  chargeForNewPRReview,
  planForUser,
} from "../billing/plans.js";
import {
  isAccountOwner,
  isReviewTriggerComment,
  shouldAutoReviewOpenedPR,
} from "../review/eligibility.js";
import { track } from "../statsig.js";

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.github.webhookSecret) return true; // dev mode: skip verification
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.github.webhookSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// GitHub delivers webhooks at-least-once: a slow response, a redelivery from
// the App's Advanced tab, or a retry after a timeout sends the same event
// again with the same X-GitHub-Delivery GUID. Remember recent GUIDs and drop
// repeats so one PR action can't enqueue two reviews. Bounded FIFO (Sets
// iterate in insertion order) — old entries age out long after GitHub's
// retry window has passed.
const seenDeliveries = new Set<string>();
const SEEN_DELIVERIES_MAX = 1000;

function isDuplicateDelivery(guid: string | undefined): boolean {
  if (!guid) return false;
  if (seenDeliveries.has(guid)) return true;
  seenDeliveries.add(guid);
  if (seenDeliveries.size > SEEN_DELIVERIES_MAX) {
    const oldest = seenDeliveries.values().next().value;
    if (oldest !== undefined) seenDeliveries.delete(oldest);
  }
  return false;
}

export function handleWebhook(req: Request, res: Response) {
  const sig = req.header("X-Hub-Signature-256") || undefined;
  // express.raw() leaves the body on req.body as a Buffer
  const raw = req.body as Buffer;
  if (!verifySignature(raw, sig)) {
    res.status(401).send("invalid signature");
    return;
  }
  // After signature verification, so junk requests can't churn the GUID set.
  const delivery = req.header("X-GitHub-Delivery") || undefined;
  if (isDuplicateDelivery(delivery)) {
    console.log(`[webhook] duplicate delivery ${delivery} dropped`);
    res.json({ ok: true, duplicate: true });
    return;
  }
  let event: any;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).send("invalid json");
    return;
  }
  const type = req.header("X-GitHub-Event") || "";

  // One-line arrival diagnostic. Lets the user verify in stdout whether
  // GitHub is even delivering a given event type — the most common cause
  // of "my comment didn't show up" is the GitHub App not being subscribed
  // to that event on github.com.
  const repoFullName: string = event?.repository?.full_name || "(no repo)";
  const action: string = event?.action || "(no action)";
  console.log(`[webhook] type=${type} action=${action} repo=${repoFullName}`);

  switch (type) {
    case "installation":
      handleInstallation(event);
      break;
    case "installation_repositories":
      handleInstallationRepos(event);
      break;
    case "pull_request":
      handlePullRequest(event);
      break;
    case "issue_comment":
      handleIssueComment(event);
      break;
    case "pull_request_review":
      handlePullRequestReview(event);
      break;
    case "pull_request_review_comment":
      handlePullRequestReviewComment(event);
      break;
    case "ping":
      // GitHub sends this when the webhook is created. Nothing to do.
      break;
    default:
      // Unhandled events are dropped silently; the agent stays narrow.
      break;
  }
  res.json({ ok: true });
}

// Only ingest comments from people with real authority over the repo (owner,
// org member, or explicit collaborator). Skip our own bot to avoid feedback
// loops, and require some actual body text to act on.
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isMaintainerComment(args: {
  body: string;
  author: string;
  authorAssociation: string;
  senderType: string;
}): boolean {
  if (!args.body || !args.body.trim()) return false;
  if (args.senderType === "Bot") return false;
  if (!MAINTAINER_ASSOCIATIONS.has(args.authorAssociation)) return false;
  return true;
}

// `issue_comment` covers top-level PR conversation comments. GitHub emits the
// same event for plain issues, so we check `issue.pull_request` to scope.
function handleIssueComment(event: any) {
  const body: string = event.comment?.body || "";
  const author: string = event.comment?.user?.login || "";
  const authorAssociation: string = event.comment?.author_association || "NONE";
  const senderType: string = event.sender?.type || "User";
  const repoFullName: string = event.repository?.full_name || "";
  const prNumber: number | undefined = event.issue?.number;

  console.log(
    `[webhook] issue_comment author=${author} assoc=${authorAssociation} senderType=${senderType} bodyLen=${body.length}`
  );

  if (event.action !== "created") {
    console.log(`[webhook] issue_comment: ignored, action=${event.action}`);
    return;
  }
  if (!event.issue?.pull_request) {
    console.log("[webhook] issue_comment: ignored, not a PR comment");
    return;
  }
  if (!isMaintainerComment({ body, author, authorAssociation, senderType })) {
    console.log(
      `[webhook] issue_comment: filtered (assoc=${authorAssociation}, senderType=${senderType}, bodyEmpty=${!body.trim()})`
    );
    return;
  }

  // Async tail: GitHub round-trips can take a beat, so respond 200 immediately
  // and do the lookup / materialize / enqueue off the request thread.
  void (async () => {
    const existing = findPRReview(repoFullName, prNumber);
    if (existing) {
      // PR already in scope → any maintainer comment is feedback to fold into
      // the review. Immediate log so the Agent page surfaces the comment within
      // ~3s of arrival, independent of how many jobs sit ahead in the worker.
      // The review's status is irrelevant — even a "passed" PR should reflect
      // that a maintainer commented.
      db.insert("reviewLogs", {
        id: uuid(),
        reviewId: existing.id,
        kind: "ingest",
        at: Date.now(),
        action: "comment.received",
        target: author,
        detail: body.length > 200 ? body.slice(0, 200) + "…" : body,
        meta: {
          author,
          authorAssociation,
          sourceEvent: "issue_comment",
          sourceUrl: event.comment?.html_url || "",
        },
      });
      enqueueMaintainerFeedback(existing.id, {
        body,
        author,
        authorAssociation,
        sourceUrl: event.comment?.html_url || "",
        sourceEvent: "issue_comment",
      });
      console.log(`[webhook] issue_comment: enqueued feedback for review ${existing.id}`);
      return;
    }

    // No review row yet → this comment is the only way an un-reviewed PR enters
    // scope, and only the account owner may do it, by commenting the trigger
    // word "review". Anything else is ignored — we don't even check the PR out.
    if (!isReviewTriggerComment(body)) {
      console.log(
        `[webhook] issue_comment: ${repoFullName}#${prNumber} not under review and comment is not a "review" trigger — ignored`
      );
      return;
    }
    const [owner, name] = repoFullName.split("/");
    const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
    const ownerUserId = repo
      ? db.find("installations", (i) => i.id === repo.installationId)?.userId || ""
      : "";
    if (!isAccountOwner(ownerUserId, author, event.comment?.user?.id)) {
      console.log(
        `[webhook] issue_comment: "review" trigger on ${repoFullName}#${prNumber} ignored — ${author} is not the account owner`
      );
      return;
    }
    const review = await ensurePRReview(repoFullName, prNumber, event.installation?.id);
    if (!review) {
      console.log(
        `[webhook] issue_comment: could not start review for ${repoFullName}#${prNumber}`
      );
      return;
    }
    db.insert("reviewLogs", {
      id: uuid(),
      reviewId: review.id,
      kind: "ingest",
      at: Date.now(),
      action: "review.requested",
      target: author,
      detail: `${author} requested a review`,
      meta: {
        author,
        authorAssociation,
        sourceEvent: "issue_comment",
        sourceUrl: event.comment?.html_url || "",
      },
    });
    console.log(
      `[webhook] issue_comment: review started for ${repoFullName}#${prNumber} by ${author}`
    );
  })();
}

// `pull_request_review` fires when a reviewer submits a formal review. We
// only care about `submitted` with a non-empty body. The per-line inline
// thread events live on a separate `pull_request_review_comment` channel —
// handled below in `handlePullRequestReviewComment`.
function handlePullRequestReview(event: any) {
  const body: string = event.review?.body || "";
  const author: string = event.review?.user?.login || "";
  const authorAssociation: string = event.review?.author_association || "NONE";
  const senderType: string = event.sender?.type || "User";
  const repoFullName: string = event.repository?.full_name || "";
  const prNumber: number | undefined = event.pull_request?.number;

  console.log(
    `[webhook] pull_request_review author=${author} assoc=${authorAssociation} senderType=${senderType} bodyLen=${body.length}`
  );

  if (event.action !== "submitted") {
    console.log(`[webhook] pull_request_review: ignored, action=${event.action}`);
    return;
  }
  if (!isMaintainerComment({ body, author, authorAssociation, senderType })) {
    console.log(
      `[webhook] pull_request_review: filtered (assoc=${authorAssociation}, senderType=${senderType}, bodyEmpty=${!body.trim()})`
    );
    return;
  }

  void (async () => {
    // Feedback channel only — never starts a review. An un-reviewed PR enters
    // scope solely via auto-review eligibility or the account owner's "review"
    // comment; a formal review submitted on a PR we aren't tracking is dropped
    // so it can't bypass the tier gate.
    const review = findPRReview(repoFullName, prNumber);
    if (!review) {
      console.log(
        `[webhook] pull_request_review: ${repoFullName}#${prNumber} not under review — feedback ignored`
      );
      return;
    }
    // Same immediate-log pattern as issue_comment: surface the review
    // submission on the Agent page before the worker dequeues the analysis
    // job.
    db.insert("reviewLogs", {
      id: uuid(),
      reviewId: review.id,
      kind: "ingest",
      at: Date.now(),
      action: "comment.received",
      target: author,
      detail: body.length > 200 ? body.slice(0, 200) + "…" : body,
      meta: {
        author,
        authorAssociation,
        sourceEvent: "pull_request_review",
        sourceUrl: event.review?.html_url || "",
      },
    });
    enqueueMaintainerFeedback(review.id, {
      body,
      author,
      authorAssociation,
      sourceUrl: event.review?.html_url || "",
      sourceEvent: "pull_request_review",
    });
    console.log(`[webhook] pull_request_review: enqueued for review ${review.id}`);
  })();
}

// `pull_request_review_comment` fires for inline comments on specific code
// lines — the most common reviewer interaction (clicking `+` next to a line
// in the Files-changed tab). Same maintainer filter as the top-level
// handlers; we record path:line so the timeline reads like
// `comment.received · @owner · src/foo.ts:42 — "..."` instead of a context-
// free body preview.
function handlePullRequestReviewComment(event: any) {
  const body: string = event.comment?.body || "";
  const author: string = event.comment?.user?.login || "";
  const authorAssociation: string = event.comment?.author_association || "NONE";
  const senderType: string = event.sender?.type || "User";
  const repoFullName: string = event.repository?.full_name || "";
  const prNumber: number | undefined = event.pull_request?.number;
  const path: string = event.comment?.path || "";
  // GitHub gives us multiple line fields; `line` is the post-image line we
  // want for the user-facing label. Fall back to `original_line` so an
  // outdated diff still produces a readable timestamp string.
  const line: number | null =
    typeof event.comment?.line === "number"
      ? event.comment.line
      : typeof event.comment?.original_line === "number"
      ? event.comment.original_line
      : null;

  console.log(
    `[webhook] pull_request_review_comment author=${author} assoc=${authorAssociation} senderType=${senderType} bodyLen=${body.length} where=${path}:${line ?? "?"}`
  );

  if (event.action !== "created") {
    console.log(`[webhook] pull_request_review_comment: ignored, action=${event.action}`);
    return;
  }
  if (!isMaintainerComment({ body, author, authorAssociation, senderType })) {
    console.log(
      `[webhook] pull_request_review_comment: filtered (assoc=${authorAssociation}, senderType=${senderType}, bodyEmpty=${!body.trim()})`
    );
    return;
  }

  void (async () => {
    // Feedback channel only — never starts a review (see handlePullRequestReview).
    const review = findPRReview(repoFullName, prNumber);
    if (!review) {
      console.log(
        `[webhook] pull_request_review_comment: ${repoFullName}#${prNumber} not under review — feedback ignored`
      );
      return;
    }
    const where = path ? `${path}${line !== null ? `:${line}` : ""}` : "(unknown location)";
    const bodyPreview = body.length > 160 ? body.slice(0, 160) + "…" : body;
    db.insert("reviewLogs", {
      id: uuid(),
      reviewId: review.id,
      kind: "ingest",
      at: Date.now(),
      action: "comment.received",
      target: author,
      detail: `${where} — ${bodyPreview}`,
      meta: {
        author,
        authorAssociation,
        path,
        line,
        sourceEvent: "pull_request_review_comment",
        sourceUrl: event.comment?.html_url || "",
      },
    });
    // Inline comments are most useful when prefixed with their location so
    // the LLM analysis knows the comment is anchored to a specific line.
    enqueueMaintainerFeedback(review.id, {
      body: `On ${where}:\n${body}`,
      author,
      authorAssociation,
      sourceUrl: event.comment?.html_url || "",
      sourceEvent: "pull_request_review_comment",
    });
    console.log(`[webhook] pull_request_review_comment: enqueued for review ${review.id}`);
  })();
}

function findPRReview(repoFullName: string | undefined, prNumber: number | undefined) {
  if (!repoFullName || !prNumber) return null;
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (!repo) return null;
  // If we have multiple review rows for the same PR (re-opens, etc) take the
  // most recently updated.
  const candidates = db
    .filter("prReviews", (r) => r.repoId === repo.id && r.prNumber === prNumber)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0] || null;
}

// Ensure we have a PRReview row for `repoFullName#prNumber`. If one exists,
// return it. If not, materialize a fresh row by fetching the PR from GitHub
// using the install token, and enqueue a full review so the criteria pipeline
// catches up. Returns null when we can't resolve the install or the repo —
// e.g. the comment is on a repo this server doesn't track.
async function ensurePRReview(
  repoFullName: string,
  prNumber: number | undefined,
  ghInstallationId: number | undefined
) {
  const existing = findPRReview(repoFullName, prNumber);
  if (existing) return existing;

  if (!prNumber) {
    console.log("[webhook] ensurePRReview: no PR number on event");
    return null;
  }
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) {
    console.log(`[webhook] ensurePRReview: malformed repo name "${repoFullName}"`);
    return null;
  }
  const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (!repo) {
    console.log(
      `[webhook] ensurePRReview: repo ${repoFullName} not tracked (no install row)`
    );
    return null;
  }
  if (!ghInstallationId) {
    // We could still synthesize a row from the comment-side fields, but
    // without an install token we can't fetch title/head.sha and the full
    // review job would fail anyway. Skip with a diagnostic.
    console.log(
      `[webhook] ensurePRReview: no installation id on event for ${repoFullName}#${prNumber}`
    );
    return null;
  }

  let pr: any;
  try {
    pr = await gh<any>(
      ghInstallationId,
      `/repos/${owner}/${name}/pulls/${prNumber}`
    );
  } catch (err) {
    console.warn(
      `[webhook] ensurePRReview: failed to fetch PR ${repoFullName}#${prNumber}:`,
      err
    );
    return null;
  }

  // Re-check after the await: another producer (the `opened` webhook, the
  // dashboard sync, a second comment event) may have inserted a row for this
  // PR while we were fetching it. Reuse theirs instead of forking a duplicate.
  const inserted = findPRReview(repoFullName, prNumber);
  if (inserted) return inserted;

  // Monthly-cap gate for a PR surfaced by a maintainer comment — this path
  // skips the `opened` webhook's cap check. Charge once per unique PR; an
  // over-cap owner's new PR is dropped rather than reviewed past their limit.
  // (The private-repo gate is enforced centrally in runReviewJob.)
  const ownerUserId =
    db.find("installations", (i) => i.id === repo.installationId)?.userId || "";
  const cap = chargeForNewPRReview(ownerUserId, repo, prNumber);
  if (cap && !cap.allowed) {
    console.log(
      `[webhook] ensurePRReview: ${repoFullName}#${prNumber} skipped — monthly review cap reached`
    );
    return null;
  }

  const review = {
    id: uuid(),
    repoId: repo.id,
    prNumber,
    prTitle: pr.title || `PR #${prNumber}`,
    headSha: pr.head?.sha || "",
    baseSha: pr.base?.sha || "",
    status: "queued" as const,
    verdict: null,
    criteria: [],
    taskId: null,
    additions: typeof pr.additions === "number" ? pr.additions : null,
    deletions: typeof pr.deletions === "number" ? pr.deletions : null,
    changedFiles: typeof pr.changed_files === "number" ? pr.changed_files : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.insert("prReviews", review);
  // Kick off a full review so the criteria pipeline catches up; the
  // maintainer-feedback job will be enqueued separately by the caller and
  // attach onto this same review row.
  if (repo.reviewsEnabled) {
    enqueueReview(review.id);
  }
  // App notification: a PR we didn't already know about just became visible
  // via a maintainer comment. The install owner gets a "added to queue" row.
  notifyForReview(
    review.id,
    "review",
    `PR #${prNumber} added to review queue`,
    `${repo.owner}/${repo.name} — ${review.prTitle}`
  );
  console.log(
    `[webhook] ensurePRReview: materialized review ${review.id} for ${repoFullName}#${prNumber}`
  );
  return review;
}

function handleInstallation(event: any) {
  if (event.action === "created" || event.action === "added") {
    // Auto-link to the user who clicked Install on GitHub. The webhook
    // includes a `sender` field with their GitHub id; if that matches a row
    // in `users` (they signed in via OAuth before clicking Install), claim
    // the installation for them right here. This avoids depending on the
    // popup handshake making it back to our origin for the install to
    // become visible to the frontend.
    const senderId: number | undefined = event.sender?.id;
    const owner = senderId
      ? db.find("users", (u) => u.githubId === senderId)
      : null;
    const install = {
      id: uuid(),
      userId: owner?.id || "",
      accountId: event.installation.account.id,
      accountLogin: event.installation.account.login,
      installationId: event.installation.id,
      repoIds: (event.repositories || []).map((r: any) => r.id),
    };
    db.insert("installations", install);
    // Materialise a Repository row for each repo the user granted access to,
    // so the frontend has something to show in the onboarding repo browser
    // (and Settings → Models) immediately — without waiting for a PR webhook.
    for (const r of event.repositories || []) {
      upsertRepoFromInstallEvent(install.id, r);
    }
    db.insert("authAudit", {
      id: uuid(),
      userId: install.userId,
      at: Date.now(),
      event: "install",
      meta: { account: event.installation.account.login, senderId },
    });
    if (install.userId) {
      track(install.userId, "github app installed", {
        account_login: install.accountLogin,
        repo_count: (event.repositories || []).length,
      });
    }
  } else if (event.action === "deleted" || event.action === "removed") {
    const install = db.find(
      "installations",
      (i) => i.installationId === event.installation.id
    );
    if (install) {
      if (install.userId) {
        track(install.userId, "github app uninstalled", {
          account_login: install.accountLogin,
        });
      }
      db.remove("repositories", (r) => r.installationId === install.id);
    }
    db.remove(
      "installations",
      (i) => i.installationId === event.installation.id
    );
  }
}

function handleInstallationRepos(event: any) {
  const install = db.find(
    "installations",
    (i) => i.installationId === event.installation.id
  );
  if (!install) return;
  const added = (event.repositories_added || []).map((r: any) => r.id);
  const removedIds = new Set((event.repositories_removed || []).map((r: any) => r.id));
  // If the install row is still unlinked (e.g. created before sender-match
  // shipped, or sender didn't match a user at install time), try to claim it
  // for whoever triggered this repos-changed event.
  const senderId: number | undefined = event.sender?.id;
  const claimedUserId = !install.userId && senderId
    ? db.find("users", (u) => u.githubId === senderId)?.id
    : null;
  db.update(
    "installations",
    (i) => i.id === install.id,
    {
      repoIds: [...install.repoIds.filter((id) => !removedIds.has(id)), ...added],
      ...(claimedUserId ? { userId: claimedUserId } : {}),
    }
  );
  // Same as on initial install: materialise Repository rows for the newly
  // granted repos so the UI can show them right away.
  for (const r of event.repositories_added || []) {
    upsertRepoFromInstallEvent(install.id, r);
  }
  // Drop rows for repos the user revoked.
  for (const r of event.repositories_removed || []) {
    const [owner, name] = String(r.full_name || "").split("/");
    if (owner && name) {
      db.remove("repositories", (x) => x.owner === owner && x.name === name);
    }
  }
}

// Insert a Repository row for `repo` if we don't already have one. Pulls the
// fields off the GitHub webhook's compact repo shape (id, name, full_name,
// private). `default_branch` isn't present on install events — defaults to
// "main" and gets corrected when the first PR webhook lands.
function upsertRepoFromInstallEvent(
  installDbId: string,
  repo: { id?: number; name?: string; full_name?: string; private?: boolean }
) {
  const fullName: string = repo.full_name || "";
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return;
  const existing = db.find(
    "repositories",
    (r) => r.owner === owner && r.name === name
  );
  if (existing) {
    const visChanged = typeof repo.private === "boolean" && existing.private !== repo.private;
    if (existing.installationId !== installDbId || visChanged) {
      db.update("repositories", (r) => r.id === existing.id, {
        installationId: installDbId,
        ...(typeof repo.private === "boolean" ? { private: repo.private } : {}),
      });
    }
    return;
  }
  const newRepo = db.insert("repositories", {
    id: uuid(),
    installationId: installDbId,
    owner,
    name,
    defaultBranch: "main",
    private: Boolean(repo.private),
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
    indexState: "queued",
  });
  enqueueIndex({ repoId: newRepo.id, full: true });
}

// Author-facing notices posted when a PR can't be reviewed under the owner's
// plan. Kept short; the upgrade link lands on the dashboard's billing page.
function privateRepoNotice(): string {
  return [
    "### DevAsign — private repositories need a paid plan",
    "",
    "Your current plan reviews **public repositories only**. Upgrade to **Pro** or **Max** to get automated reviews on private repos.",
    "",
    `[Upgrade your plan →](${config.webOrigin}/?billing=upgrade)`,
  ].join("\n");
}

function capReachedNotice(limit: number): string {
  return [
    "### DevAsign — monthly review limit reached",
    "",
    `You've used all **${limit} PR reviews** included in your plan this month, so this PR wasn't reviewed.`,
    "",
    "Your allowance resets next billing period. Need more headroom? Upgrade for a higher limit:",
    "",
    `[Upgrade your plan →](${config.webOrigin}/?billing=upgrade)`,
  ].join("\n");
}

// A PR authored by a bot — Dependabot, Renovate, github-actions, or any GitHub
// App "[bot]" account. Drives the per-repo workflow `skipBots` trigger.
function isBotActor(actor: any): boolean {
  if (!actor) return false;
  if (actor.type === "Bot") return true;
  const login = String(actor.login || "").toLowerCase();
  return /\[bot\]$/.test(login) || /^(dependabot|renovate|github-actions)\b/.test(login);
}

function handlePullRequest(event: any) {
  if (!["opened", "reopened", "synchronize", "ready_for_review", "closed"].includes(event.action)) return;
  const repoFullName: string = event.repository.full_name;
  const [owner, name] = repoFullName.split("/");

  // Merge-to-prod: when a PR merges into the repo's default branch, refresh
  // the index incrementally so the post-merge state is what the next review
  // reasons against. Non-merge closes are ignored.
  if (event.action === "closed") {
    const pullReq = event.pull_request;
    if (!pullReq?.merged) return;
    const repo = db.find("repositories", (r) => r.owner === owner && r.name === name);
    if (!repo) return;
    if (pullReq.base?.ref !== repo.defaultBranch) return;
    const installId = event.installation?.id;
    if (!installId) return;
    void (async () => {
      try {
        const files = await gh<Array<{
          filename: string;
          previous_filename?: string;
          status: string;
        }>>(installId, `/repos/${owner}/${name}/pulls/${pullReq.number}/files?per_page=300`);
        const added: string[] = [];
        const modified: string[] = [];
        const removed: string[] = [];
        const renamed: Array<{ from: string; to: string }> = [];
        for (const f of files) {
          switch (f.status) {
            case "added":
              added.push(f.filename);
              break;
            case "modified":
            case "changed":
              modified.push(f.filename);
              break;
            case "removed":
              removed.push(f.filename);
              break;
            case "renamed":
              if (f.previous_filename) renamed.push({ from: f.previous_filename, to: f.filename });
              modified.push(f.filename); // re-summarise the new path
              break;
            case "copied":
              added.push(f.filename);
              break;
          }
        }
        db.update("repositories", (r) => r.id === repo.id, { indexState: "stale" });
        enqueueIndex({ repoId: repo.id, full: false, changedPaths: { added, modified, removed, renamed } });
        console.log(
          `[webhook] merge to ${repo.defaultBranch}: ${owner}/${name}#${pullReq.number} → ` +
          `${added.length}A ${modified.length}M ${removed.length}D ${renamed.length}R`
        );
      } catch (err) {
        console.warn(`[webhook] merge re-index for ${owner}/${name}#${pullReq.number} failed:`, err);
      }
    })();
    return;
  }

  // Make sure we have a repo row; the user may not have customised settings yet.
  let repo = db.find(
    "repositories",
    (r) => r.owner === owner && r.name === name
  );
  if (!repo) {
    const install = db.find(
      "installations",
      (i) => i.installationId === event.installation?.id
    );
    repo = {
      id: uuid(),
      installationId: install?.id || "",
      owner,
      name,
      defaultBranch: event.repository.default_branch || "main",
      private: Boolean(event.repository.private),
      defaultModel: "claude-opus-4-7",
      modelOverrides: {},
      reviewsEnabled: true,
      indexState: "queued",
    };
    db.insert("repositories", repo);
    enqueueIndex({ repoId: repo.id, full: true });
  }
  if (!repo.reviewsEnabled) return;

  const pullReq = event.pull_request;
  const newSha: string = pullReq.head.sha;
  const installationId: number | undefined = event.installation?.id;

  // Keep stored visibility fresh from the event payload — self-heals rows the
  // migration backfilled to private:false and any later visibility change.
  if (typeof event.repository.private === "boolean" && event.repository.private !== repo.private) {
    db.update("repositories", (r) => r.id === repo!.id, { private: event.repository.private });
    repo.private = event.repository.private;
  }

  // ── Plan gates ────────────────────────────────────────────────────────────
  // Resolve the owning user's effective plan. An unlinked install (webhook
  // landed before onboarding linked it) has no userId — skip gating there
  // rather than risk false-blocking a paying user; gates apply once linked.
  const ownerUserId =
    db.find("installations", (i) => i.id === repo!.installationId)?.userId || "";
  const plan = ownerUserId ? planForUser(ownerUserId) : null;
  // Only nudge the author on a fresh open/reopen, so re-pushes never re-comment.
  const notifiable = event.action === "opened" || event.action === "reopened";

  // Private-repo gate — applies to every review path (including re-pushes), so a
  // free or lapsed user's private repos stop being reviewed.
  if (plan && repo.private && !PLAN_LIMITS[plan].privateRepos) {
    if (notifiable && installationId) {
      void postPRComment(installationId, owner, name, pullReq.number, privateRepoNotice());
    }
    return;
  }

  // ── Workflow trigger policy (per repo; advanced tier) ─────────────────────
  // Defaults reproduce prior behavior, so uncustomised repos are unaffected.
  // skipDrafts drops draft PRs entirely (a draft marked "ready for review"
  // arrives as a non-draft, so that path still reviews); skipBots drops
  // bot-authored PRs (Dependabot/Renovate/etc). onSynchronize is handled inside
  // the synchronize branch below.
  const wf = effectiveWorkflow(repo);
  const trig = triggerOutcome(wf, { isDraft: !!pullReq.draft, isBot: isBotActor(pullReq.user) });
  if (trig.skip === "draft") {
    console.log(`[webhook] pull_request: ${repoFullName}#${pullReq.number} skipped — draft (workflow skipDrafts)`);
    return;
  }
  if (trig.skip === "bot") {
    console.log(`[webhook] pull_request: ${repoFullName}#${pullReq.number} skipped — bot author (workflow skipBots)`);
    return;
  }

  // `synchronize` fires when a contributor pushes new commits to an open PR.
  // The semantics are "same PR, new state" — we keep ONE prReview row per
  // PR and update its headSha in place, instead of inserting a duplicate that
  // would fork the queue card the user is watching. A "commit.push" entry
  // lands in reviewLogs immediately so the Agent page surfaces the push the
  // moment GitHub tells us about it, even before the pipeline re-runs and
  // posts a fresh PR review.
  if (event.action === "synchronize") {
    const existing = db.find(
      "prReviews",
      (r) => r.repoId === repo!.id && r.prNumber === pullReq.number
    );
    if (existing) {
      const pusher: string = event.sender?.login || "someone";
      const branch: string = pullReq.head?.ref || "branch";
      const before: string = event.before || existing.headSha;
      const count: number | undefined = Array.isArray(event.commits) ? event.commits.length : undefined;
      const detail =
        typeof count === "number" && count > 0
          ? `${pusher} pushed ${count} commit${count === 1 ? "" : "s"} to ${branch}`
          : `${pusher} pushed new commits to ${branch}`;
      // Re-review on push disabled by workflow: keep headSha fresh and record the
      // push for the timeline, but don't re-run the review.
      if (!trig.reReviewOnSync) {
        db.update("prReviews", (r) => r.id === existing.id, { headSha: newSha, updatedAt: Date.now() });
        db.insert("reviewLogs", {
          id: uuid(),
          reviewId: existing.id,
          kind: "ingest",
          at: Date.now(),
          action: "commit.push",
          target: newSha.slice(0, 7),
          detail: `${detail} — auto re-review off`,
          meta: { before, after: newSha, pusher, branch, prevHeadSha: existing.headSha, source: "webhook", reReview: false },
        });
        console.log(`[webhook] pull_request: ${repoFullName}#${pullReq.number} push not re-reviewed (workflow onSynchronize off)`);
        return;
      }
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
        detail,
        meta: {
          before,
          after: newSha,
          pusher,
          branch,
          prevHeadSha: existing.headSha,
          source: "webhook",
        },
      });
      enqueueReview(existing.id);
      return;
    }
    // No row yet (race: synchronize arrived before opened, or the user only
    // installed the app after the PR was already open). Fall through to the
    // insert path so we still pick up the work.
  }

  // One prReview row per PR. `opened` can race the dashboard's /reviews/sync
  // poll (which inserts first and leaves this handler holding a duplicate),
  // and `reopened` / `ready_for_review` fire for PRs whose row from `opened`
  // is still around. Reuse the row: a duplicate insert forks the queue card
  // AND the GitHub comment thread, since each row posts its own verdict.
  const existing = db.find(
    "prReviews",
    (r) => r.repoId === repo!.id && r.prNumber === pullReq.number
  );
  if (existing) {
    const inFlight = existing.status === "queued" || existing.status === "reviewing";
    if (inFlight && existing.headSha === newSha) {
      // Same commit already queued or running — redelivery or sync race.
      // The in-flight run covers it; just keep the title fresh.
      db.update("prReviews", (r) => r.id === existing.id, {
        prTitle: pullReq.title,
        updatedAt: Date.now(),
      });
      console.log(
        `[webhook] pull_request: ${repoFullName}#${pullReq.number} ${event.action} — already in flight, not duplicated`
      );
      return;
    }
    const reason =
      event.action === "reopened"
        ? "PR reopened"
        : event.action === "ready_for_review"
        ? "PR marked ready for review"
        : "PR opened";
    db.update("prReviews", (r) => r.id === existing.id, {
      prTitle: pullReq.title,
      headSha: newSha,
      baseSha: pullReq.base.sha,
      status: "queued",
      additions: typeof pullReq.additions === "number" ? pullReq.additions : null,
      deletions: typeof pullReq.deletions === "number" ? pullReq.deletions : null,
      changedFiles: typeof pullReq.changed_files === "number" ? pullReq.changed_files : null,
      updatedAt: Date.now(),
    });
    db.insert("reviewLogs", {
      id: uuid(),
      reviewId: existing.id,
      kind: "ingest",
      at: Date.now(),
      action: "review.requeue",
      target: newSha.slice(0, 7),
      detail: `${reason} — review re-queued`,
      meta: { trigger: event.action, after: newSha, prevHeadSha: existing.headSha, source: "webhook" },
    });
    enqueueReview(existing.id);
    return;
  }

  // ── Auto-review eligibility ───────────────────────────────────────────────
  // Who opened the PR decides whether we review it unprompted. Free/Pro auto-
  // review only the account owner's own PRs; Max also auto-reviews any team
  // member's PR (org standing via author_association). Anything else is left
  // untouched — no row, no checkout — until the account owner comments "review"
  // (handled in handleIssueComment). Reached only on the new-row path: the
  // reopen/ready/synchronize branches above reuse an existing row, so a PR
  // already in scope keeps re-reviewing.
  if (
    !shouldAutoReviewOpenedPR({
      ownerUserId,
      prAuthorLogin: pullReq.user?.login || "",
      prAuthorId: pullReq.user?.id,
      authorAssociation: pullReq.author_association,
    })
  ) {
    console.log(
      `[webhook] pull_request: ${repoFullName}#${pullReq.number} not auto-reviewed — author ${pullReq.user?.login} not eligible for owner's plan (awaiting "review" comment)`
    );
    return;
  }

  // Monthly-cap gate — charged once per unique PR (chargeForNewPRReview returns
  // null for re-reviews: re-pushes take the synchronize path above and re-opens
  // reuse the prior row, so neither re-charges). Max's unlimited allowance always
  // passes.
  const cap = chargeForNewPRReview(ownerUserId, repo, pullReq.number);
  if (cap && !cap.allowed) {
    if (notifiable && installationId) {
      void postPRComment(installationId, owner, name, pullReq.number, capReachedNotice(cap.limit));
    }
    return;
  }

  const review = {
    id: uuid(),
    repoId: repo.id,
    prNumber: pullReq.number,
    prTitle: pullReq.title,
    headSha: newSha,
    baseSha: pullReq.base.sha,
    status: "queued" as const,
    verdict: null,
    criteria: [],
    taskId: null,
    additions: typeof pullReq.additions === "number" ? pullReq.additions : null,
    deletions: typeof pullReq.deletions === "number" ? pullReq.deletions : null,
    changedFiles: typeof pullReq.changed_files === "number" ? pullReq.changed_files : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.insert("prReviews", review);
  enqueueReview(review.id);
  if (ownerUserId) {
    track(ownerUserId, "pr review queued", {
      repo: `${repo.owner}/${repo.name}`,
      pr_number: pullReq.number,
      is_private: repo.private,
      trigger: event.action,
    });
  }
  // App notification: a PR was opened (or re-opened) on a tracked repo and
  // we've queued it for review.
  notifyForReview(
    review.id,
    "review",
    `PR #${pullReq.number} added to review queue`,
    `${repo.owner}/${repo.name} — ${pullReq.title}`
  );
}
