// Fan-out a verdict to whichever chat integrations the user has connected.
// Primary path: per-user integrations stored in the DB (the Settings →
// Integrations flow). Fallback path: workspace-wide env vars — used only when
// no per-user integration of that type exists, so dev/single-team setups can
// just paste a token in .env and have verdicts land somewhere.
import { config, isSlackEnvConfigured, isDiscordEnvConfigured } from "../config.js";
import { db } from "../db.js";
import type { PRReview, PRReviewStatus } from "../types.js";

export async function broadcastVerdict(
  review: PRReview,
  repo: { owner: string; name: string },
  status: PRReviewStatus,
  summary: string
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
      } else if (i.type === "linear" && i.tokens.apiKey) {
        // Linear: comment back on the linked issue, if we can derive one.
        // Skipped here — the engine would parse `pr.body` for "fixes ENG-123".
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

// Pulls Linear issue context — used by review pipeline ingestion.
export async function fetchLinearIssue(apiKey: string, issueKey: string): Promise<string | null> {
  const query = `query($id: String!) { issue(id: $id) { title description comments { nodes { body } } } }`;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: issueKey } }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as any;
  const issue = body?.data?.issue;
  if (!issue) return null;
  const comments = (issue.comments?.nodes || []).map((c: any) => c.body).join("\n---\n");
  return `${issue.title}\n\n${issue.description || ""}\n\n${comments}`;
}

