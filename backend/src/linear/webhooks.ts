// Linear webhook receiver. Mirrors github/webhooks.ts: a thin handler that
// verifies the signature, then enqueues ticket ingestion (or stores project
// context). Registered with express.raw() BEFORE express.json() so the raw
// bytes are available for HMAC verification.
//
// Replay protection is a fail-closed timestamp window PLUS a dedupe of already
// accepted deliveries — see MAX_SKEW_MS and isReplay below. Either alone leaves
// a hole: the signature covers only the body, so a captured delivery is replayable
// verbatim, and a timestamp check that skips absent timestamps is no check at all.
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

// Replay guard, part one: a delivery must carry a timestamp within a minute of
// now. Missing / zero / non-numeric is a rejection, not a bypass — the HMAC
// covers only the body, so a captured delivery stays validly signed forever and
// the skew window is the only thing bounding how long it can be resent.
const MAX_SKEW_MS = 60 * 1000;

// Replay guard, part two: within that window the signature is still valid, so
// remember the deliveries we've already accepted and drop repeats. Keyed on the
// signature hex — an HMAC over the raw body, so identical bytes give an
// identical key. A header (Linear-Delivery and friends) would NOT do: it sits
// outside the HMAC, and a replayer can mint a fresh one at will. Entries only
// need to outlive the skew window; anything older is already rejected above.
const seenDeliveries = new Map<string, number>();
const SEEN_DELIVERIES_MAX = 5000; // memory backstop, far above one minute of real traffic

function isReplay(signature: string): boolean {
  const now = Date.now();
  for (const [k, expiresAt] of seenDeliveries) if (expiresAt <= now) seenDeliveries.delete(k);
  if (seenDeliveries.has(signature)) return true;
  seenDeliveries.set(signature, now + MAX_SKEW_MS);
  // Maps iterate in insertion order, so the first key is the oldest.
  if (seenDeliveries.size > SEEN_DELIVERIES_MAX) {
    const oldest = seenDeliveries.keys().next().value;
    if (oldest !== undefined) seenDeliveries.delete(oldest);
  }
  return false;
}

// The map lives for the process lifetime and `node --test 'src/**/*.test.ts'` loads
// many test files into one process, so let tests clear it — otherwise two identical
// signed bodies in unrelated files would read as a replay.
export function __resetSeenDeliveriesForTests(): void {
  seenDeliveries.clear();
}

// A Linear webhook signature: lowercase hex HMAC-SHA256 of the raw body.
// Validating the shape up front means timingSafeEqual always compares
// equal-length buffers (it throws otherwise) and malformed headers are
// rejected before any comparison.
const LINEAR_SIG_RE = /^[0-9a-f]{64}$/;

// Narrows `signature` on success so callers can use it (as the replay-dedupe
// key) without re-checking for undefined.
function verifySignature(rawBody: Buffer, signature: string | undefined): signature is string {
  const secret = config.linear.webhookSigningSecret;
  if (!secret || !signature || !LINEAR_SIG_RE.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
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

  const ts = Number(event?.webhookTimestamp);
  if (!Number.isFinite(ts) || ts <= 0 || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    console.warn(
      `[linear-webhook] rejected: bad/stale webhookTimestamp (${event?.webhookTimestamp})`
    );
    return void res.status(401).send("stale webhook");
  }

  // Only reached by a signed, in-window delivery, so junk can't churn the map.
  // A duplicate is acknowledged rather than errored: Linear delivers
  // at-least-once, and a non-2xx would only make it retry harder.
  if (isReplay(sig)) {
    console.log("[linear-webhook] duplicate delivery dropped");
    return void res.json({ ok: true, duplicate: true });
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
