// GitHub webhook receiver. Verifies HMAC, then enqueues review jobs.
// Spec: devasign.md §5 — webhook must be thin; reviews run in worker.
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueueMaintainerFeedback, enqueueReview } from "../queue.js";

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

export function handleWebhook(req: Request, res: Response) {
  const sig = req.header("X-Hub-Signature-256") || undefined;
  // express.raw() leaves the body on req.body as a Buffer
  const raw = req.body as Buffer;
  if (!verifySignature(raw, sig)) {
    res.status(401).send("invalid signature");
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
  if (event.action !== "created") return;
  if (!event.issue?.pull_request) return; // not a PR — skip
  const body: string = event.comment?.body || "";
  const author: string = event.comment?.user?.login || "";
  const authorAssociation: string = event.comment?.author_association || "NONE";
  const senderType: string = event.sender?.type || "User";
  if (!isMaintainerComment({ body, author, authorAssociation, senderType })) return;

  const review = findPRReview(event.repository?.full_name, event.issue.number);
  if (!review) return;

  enqueueMaintainerFeedback(review.id, {
    body,
    author,
    authorAssociation,
    sourceUrl: event.comment?.html_url || "",
    sourceEvent: "issue_comment",
  });
}

// `pull_request_review` fires when a reviewer submits a formal review.
// We only care about `submitted` with a non-empty body; the per-line inline
// thread events live on a separate `pull_request_review_comment` channel that
// we intentionally don't listen to (too noisy).
function handlePullRequestReview(event: any) {
  if (event.action !== "submitted") return;
  const body: string = event.review?.body || "";
  const author: string = event.review?.user?.login || "";
  const authorAssociation: string = event.review?.author_association || "NONE";
  const senderType: string = event.sender?.type || "User";
  if (!isMaintainerComment({ body, author, authorAssociation, senderType })) return;

  const review = findPRReview(event.repository?.full_name, event.pull_request?.number);
  if (!review) return;

  enqueueMaintainerFeedback(review.id, {
    body,
    author,
    authorAssociation,
    sourceUrl: event.review?.html_url || "",
    sourceEvent: "pull_request_review",
  });
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
  } else if (event.action === "deleted" || event.action === "removed") {
    const install = db.find(
      "installations",
      (i) => i.installationId === event.installation.id
    );
    if (install) {
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
    if (existing.installationId !== installDbId) {
      db.update("repositories", (r) => r.id === existing.id, { installationId: installDbId });
    }
    return;
  }
  db.insert("repositories", {
    id: uuid(),
    installationId: installDbId,
    owner,
    name,
    defaultBranch: "main",
    defaultModel: "claude-opus-4-7",
    modelOverrides: {},
    reviewsEnabled: true,
  });
}

function handlePullRequest(event: any) {
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(event.action)) return;
  const repoFullName: string = event.repository.full_name;
  const [owner, name] = repoFullName.split("/");
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
      defaultModel: "claude-opus-4-7",
      modelOverrides: {},
      reviewsEnabled: true,
    };
    db.insert("repositories", repo);
  }
  if (!repo.reviewsEnabled) return;

  const review = {
    id: uuid(),
    repoId: repo.id,
    prNumber: event.pull_request.number,
    prTitle: event.pull_request.title,
    headSha: event.pull_request.head.sha,
    baseSha: event.pull_request.base.sha,
    status: "queued" as const,
    verdict: null,
    criteria: [],
    taskId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.insert("prReviews", review);
  enqueueReview(review.id);
}
