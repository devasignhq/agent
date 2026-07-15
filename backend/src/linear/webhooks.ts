// Linear webhook receiver. Mirrors github/webhooks.ts: a thin handler that
// verifies the signature, then enqueues ticket ingestion (or stores project
// context). Registered with express.raw() BEFORE express.json() so the raw
// bytes are available for HMAC verification.
//
// Public OAuth apps use a single APP-LEVEL webhook: Linear delivers every
// install's events to one URL, all signed with one secret (configured in the
// Linear app settings → LINEAR_WEBHOOK_SIGNING_SECRET). So we verify against
// that one secret, then look the workspace up by organizationId to get the
// token we ingest with.
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueueLinearIngest } from "../queue.js";
import { maybeHandleBountyLinearComment } from "../bounties/webhooks.js";

// Reject deliveries whose timestamp is more than a minute from now (replay guard).
const MAX_SKEW_MS = 60 * 1000;

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = config.linear.webhookSigningSecret;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function handleLinearWebhook(req: Request, res: Response) {
  // express.raw() leaves the body on req.body as a Buffer.
  const raw = req.body as Buffer;

  // Verify first — against the single app-level secret — before trusting anything.
  const sig = req.header("Linear-Signature") || undefined;
  if (!verifySignature(raw, sig)) {
    return void res.status(401).send("invalid signature");
  }

  let event: any;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return void res.status(400).send("invalid json");
  }

  const ts = Number(event?.webhookTimestamp || 0);
  if (ts && Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return void res.status(401).send("stale webhook");
  }

  const type: string = event?.type || "";
  const action: string = event?.action || "";
  const organizationId: string = event?.organizationId || "";
  console.log(`[linear-webhook] type=${type} action=${action} org=${organizationId}`);

  // Route to the connected workspace by organizationId so ingestion uses the
  // right user's token. A valid-but-untracked workspace is acknowledged (200)
  // with no action rather than rejected, so Linear doesn't retry pointlessly.
  const integration = db.find(
    "integrations",
    (i) => i.type === "linear" && i.workspaceMeta?.organizationId === organizationId
  );
  if (!integration) {
    return void res.json({ ok: true, ignored: "unknown_workspace" });
  }

  // ProjectUpdate → store as background context for the project's issues. No
  // LLM/ingest needed; the criteria step pulls recent updates in directly.
  if (type === "ProjectUpdate" && (action === "create" || action === "update")) {
    storeProjectUpdate(event, integration.userId);
    return void res.json({ ok: true });
  }

  // Issue opened/updated → (re)synthesize criteria. Comment / attachment added →
  // re-ingest the parent issue so new discussion or a linked resource refreshes
  // the cached criteria. Everything else is dropped silently.
  let issueId = "";
  if (type === "Issue" && (action === "create" || action === "update")) {
    issueId = event?.data?.id || "";
  } else if (type === "Comment" && action === "create") {
    // A `bounty $X $Nd` comment creates a bounty (and posts the Fund/Cancel
    // confirm back to Linear) instead of re-ingesting criteria.
    if (maybeHandleBountyLinearComment(event, integration)) {
      return void res.json({ ok: true, bounty: true });
    }
    issueId = event?.data?.issueId || event?.data?.issue?.id || "";
  } else if (type === "IssueAttachment" && (action === "create" || action === "update")) {
    issueId = event?.data?.issueId || event?.data?.issue?.id || "";
  }

  if (issueId) {
    enqueueLinearIngest(integration.id, issueId);
    console.log(`[linear-webhook] enqueued ingest for issue ${issueId}`);
  }

  res.json({ ok: true });
}

function storeProjectUpdate(event: any, userId: string | undefined) {
  const data = event?.data || {};
  const id: string = data.id || "";
  const projectId: string = data.project?.id || data.projectId || "";
  if (!id || !projectId) return;
  const now = Date.now();
  const row = {
    id,
    projectId,
    projectName: data.project?.name || "",
    body: data.body || "",
    health: data.health || undefined,
    userId,
    createdAt: now,
    updatedAt: now,
  };
  const existing = db.find("linearProjectUpdates", (u) => u.id === id);
  if (existing) {
    db.update("linearProjectUpdates", (u) => u.id === id, {
      body: row.body,
      health: row.health,
      projectName: row.projectName,
      updatedAt: now,
    });
  } else {
    db.insert("linearProjectUpdates", row);
  }
  console.log(`[linear-webhook] stored project update for project ${projectId}`);
}
