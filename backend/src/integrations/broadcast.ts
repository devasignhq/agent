// Fan-out a verdict to whichever chat integrations the user has connected.
// Primary path: per-user integrations stored in the DB (the Settings →
// Integrations flow). Fallback path: workspace-wide env vars — used only when
// no per-user integration of that type exists, so dev/single-team setups can
// just paste a token in .env and have verdicts land somewhere.
import { config, isSlackEnvConfigured, isDiscordEnvConfigured } from "../config.js";
import { db } from "../db.js";
import { createLinearComment } from "../linear/client.js";
import type { PRReview, PRReviewStatus } from "../types.js";

export async function broadcastVerdict(
  review: PRReview,
  repo: { owner: string; name: string },
  status: PRReviewStatus,
  summary: string,
  // Linear write-back is scoped to a specific linked issue + token (resolved by
  // the pipeline), unlike the chat fan-out which posts to every connected
  // workspace. Absent these, the Linear step is a no-op.
  opts: {
    linkedLinearIssue?: { id: string; identifier: string; url: string } | null;
    linearToken?: string;
    linearBearer?: boolean;
  } = {}
) {
  const integrations = db.table("integrations");

  // Track whether any per-user integration of each type exists, so the env
  // fallback only fires when nobody has wired one up themselves.
  let hasUserSlack = false;
  let hasUserDiscord = false;

  for (const i of integrations) {
    try {
      if (i.type === "slack" && i.tokens.botToken) {
        hasUserSlack = true;
        await postSlack(i.tokens.botToken, i.workspaceMeta.channel || "general", review, repo, status, summary);
      } else if (i.type === "discord" && i.tokens.botToken) {
        hasUserDiscord = true;
        await postDiscord(i.tokens.botToken, i.workspaceMeta.channelId || "", review, repo, status, summary);
      }
    } catch (err) {
      console.warn(`[broadcast] ${i.type} failed:`, err);
    }
  }

  // Env-var fallbacks. Skipped if a per-user integration of the same type
  // exists, so we never double-post.
  if (!hasUserSlack && isSlackEnvConfigured()) {
    try {
      await postSlack(
        config.integrations.slackBotToken,
        config.integrations.slackBotChannel,
        review,
        repo,
        status,
        summary
      );
    } catch (err) {
      console.warn("[broadcast] slack (env fallback) failed:", err);
    }
  }
  if (!hasUserDiscord && isDiscordEnvConfigured()) {
    try {
      await postDiscord(
        config.integrations.discordBotToken,
        config.integrations.discordBotChannelId,
        review,
        repo,
        status,
        summary
      );
    } catch (err) {
      console.warn("[broadcast] discord (env fallback) failed:", err);
    }
  }

  // Linear: a SHORT notification on the linked issue — the full verdict is on
  // the PR. Scoped to the issue + the repo owner's token, both resolved by the
  // pipeline; we deliberately don't fan out to every Linear integration the way
  // the chat broadcasts above do.
  if (opts.linkedLinearIssue && opts.linearToken) {
    try {
      const prUrl = `https://github.com/${repo.owner}/${repo.name}/pull/${review.prNumber}`;
      const outcome =
        status === "passed"
          ? "reviewed it and all acceptance criteria passed"
          : status === "changes_requested"
          ? "reviewed it and requested changes"
          : "reviewed it";
      const body =
        `🔎 **DevAsign** ${outcome} on [${repo.owner}/${repo.name}#${review.prNumber}](${prUrl}), ` +
        `which targets this issue. The full feedback is on the pull request.`;
      await createLinearComment(opts.linearToken, opts.linkedLinearIssue.id, body, {
        bearer: opts.linearBearer,
      });
    } catch (err) {
      console.warn("[broadcast] linear notify failed:", err);
    }
  }
}

function statusEmoji(status: PRReviewStatus) {
  return status === "passed" ? "✅" : status === "changes_requested" ? "⚠️" : "❌";
}

async function postSlack(
  token: string,
  channel: string,
  review: PRReview,
  repo: { owner: string; name: string },
  status: PRReviewStatus,
  summary: string
) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: `${statusEmoji(status)} *DevAsign* · ${repo.owner}/${repo.name}#${review.prNumber} — ${status}\n${summary}`,
    }),
  });
}

async function postDiscord(
  token: string,
  channelId: string,
  review: PRReview,
  repo: { owner: string; name: string },
  status: PRReviewStatus,
  summary: string
) {
  if (!channelId) return;
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `${statusEmoji(status)} **DevAsign** · ${repo.owner}/${repo.name}#${review.prNumber} — ${status}\n${summary}`,
    }),
  });
}

