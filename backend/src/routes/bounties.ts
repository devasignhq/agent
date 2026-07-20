// REST API for the bounty feature. Mounted under /api in server.ts. Auth follows
// the house idiom (inline getSessionUser + installation membership); every route
// that touches the chain 503s when Stellar isn't configured. Funding + in-app
// approve return an UNSIGNED transaction the sponsor signs with Freighter; the
// signed envelope comes back to *-submit for broadcast — the backend never holds
// a sponsor key.
import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db.js";
import type { Bounty } from "../types.js";
import { isStellarConfigured } from "../config.js";
import { getSessionUser } from "../github/oauth.js";
import { installationsForUser, userInInstall } from "../github/installations.js";
import { assertValidAddress } from "../stellar/scval.js";
import { validateMemo } from "../stellar/memo.js";
import { hasUsdcTrustline } from "../stellar/escrow.js";
import { networkPassphrase } from "../stellar/client.js";
import { cancelUrl, fundingUrl, verifyBountyLinkToken } from "../bounties/links.js";
import { publicBountyView } from "../bounties/public-view.js";
import { explorerBase } from "./contributor.js";
import { parsePrUrl, sanitizeLinks, validateSubmission } from "../bounties/submission.js";
import { criteriaCounts, findBountyReview, partitionBountyCriteria } from "../bounties/review-lookup.js";
import { publicLimiter } from "../rate-limit.js";
import { gh } from "../github/app.js";
import { ensurePRReview } from "../github/webhooks.js";
import { pushNotification } from "../notifications.js";
import { updateStatusComment } from "../bounties/botcomment.js";
import { postAndRecordConfirmComment } from "../bounties/webhooks.js";
import {
  acceptAndStartClock,
  applyToBounty,
  approveApplication,
  buildFundingTx,
  buildSponsorReleaseTx,
  cancelBounty,
  createBounty,
  deleteBounty,
  getBounty,
  markInReview,
  recordBountyEvent,
  refundBounty,
  rejectApplication,
  submitFunding,
  submitSponsorRelease,
  withdrawApplication,
} from "../bounties/service.js";

export const bounties = Router();

// --- helpers ---

function requireUser(req: Request, res: Response) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  return user;
}

function requireStellar(res: Response): boolean {
  if (!isStellarConfigured()) {
    res.status(503).json({ error: "stellar_unconfigured" });
    return false;
  }
  return true;
}

// The GitHub installation numeric ids a user is a member of.
function userInstallationIds(userId: string): Set<number> {
  return new Set(installationsForUser(userId).map((i) => i.installationId));
}

// A user is the "sponsor" (maintainer) of a bounty if they created it (app/Linear
// path) or are a member of the installation that owns its repo (comment path).
function isSponsor(bounty: Bounty, userId: string): boolean {
  return bounty.sponsorUserId === userId || userInstallationIds(userId).has(bounty.installationId);
}

// Map a service failure reason to an HTTP status.
function failStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason.startsWith("already_") || reason === "in_flight") return 409;
  if (reason === "funding_in_flight") return 409; // retriable: keeper confirms within a tick
  return 400;
}

// A PENDING_FUNDING bounty is only actionable through its signed Fund/Cancel
// links. The GitHub confirm comment is the usual carrier, but posting it can
// fail (e.g. the App lacks Issues:write) — so sponsor-facing reads mint fresh
// links too, making the app's Bounties page a full fallback. A funded (OPEN)
// bounty keeps its Cancel link: cancelling it refunds the escrow. Sponsor-only:
// callers must scope to the sponsor before applying this.
function withSponsorLinks(b: Bounty): Bounty & { fundingUrl?: string; cancelUrl?: string } {
  if (b.status === "PENDING_FUNDING") return { ...b, fundingUrl: fundingUrl(b.id), cancelUrl: cancelUrl(b.id) };
  if (b.status === "OPEN") return { ...b, cancelUrl: cancelUrl(b.id) };
  return b;
}

function summarize(list: Bounty[]) {
  const active = ["OPEN", "DELEGATED", "IN_REVIEW"];
  let inEscrow = 0;
  let paidOut = 0;
  let activeCount = 0;
  for (const b of list) {
    if (active.includes(b.status)) {
      inEscrow += b.amountUsdc;
      activeCount++;
    } else if (b.status === "PAID") {
      paidOut += b.amountUsdc;
    }
  }
  return { total: list.length, active: activeCount, inEscrow, paidOut };
}

// --- reads ---

export function listBountiesHandler(req: Request, res: Response) {
  const user = requireUser(req, res);
  if (!user) return;
  const ids = userInstallationIds(user.id);
  // This list is already sponsor-scoped (installation member or creator), so
  // every row may carry the funding links.
  const list = db
    .filter("bounties", (b) => ids.has(b.installationId) || b.sponsorUserId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ bounties: list.map(withSponsorLinks), summary: summarize(list) });
}
bounties.get("/bounties", listBountiesHandler);

bounties.get("/bounties/transactions", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const ids = userInstallationIds(user.id);
  const bountyIds = new Set(
    db.filter("bounties", (b) => ids.has(b.installationId) || b.sponsorUserId === user.id).map((b) => b.id)
  );
  const txns = db
    .filter("escrowTransactions", (t) => !!t.bountyId && bountyIds.has(t.bountyId))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ transactions: txns });
});

// Unauthenticated public read for the contributor app's discovery page — a
// developer landing from a GitHub link sees the bounty before signing in. The
// payload is the strict allowlist in bounties/public-view.ts (no applicants, no
// sponsor/assignee identity or wallets, no links). Registered BEFORE
// /bounties/:id so the extra path segment can't be shadowed. 404s for bounties
// with nothing to advertise (unfunded or cancelled) and for unknown ids alike,
// so the endpoint can't be used to distinguish "exists but hidden" from "gone".
bounties.get("/bounties/:id/public", publicLimiter, (req, res) => {
  const b = getBounty(String(req.params.id));
  if (!b || b.status === "PENDING_FUNDING" || b.status === "CANCELLED") {
    return void res.status(404).json({ error: "not_found" });
  }
  const escrowTxn = db.find("escrowTransactions", (t) => t.idempotencyKey === `escrow:${b.taskId}`);
  res.json({ bounty: publicBountyView(b, escrowTxn), explorerBase: explorerBase() });
});

export function getBountyHandler(req: Request, res: Response) {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(String(req.params.id));
  if (!b) return void res.status(404).json({ error: "not_found" });
  const sponsor = isSponsor(b, user.id);
  // Any signed-in user may read a bounty — it's advertised on a public GitHub
  // issue and the bot comment's Apply CTA points contributors here. Two things
  // stay sponsor-scoped: the fund/cancel links (a token that can cancel the
  // bounty must never leave the sponsor) and the applicant list (non-sponsors
  // see only their OWN applications, which is what the apply page needs to
  // render an "already applied" state).
  if (sponsor) return void res.json({ bounty: withSponsorLinks(b) });
  res.json({
    bounty: {
      ...b,
      applications: b.applications.filter((a) => a.githubId === user.githubId),
    },
  });
}
bounties.get("/bounties/:id", getBountyHandler);

// --- create (app path) ---

bounties.post("/bounties", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  const { repo, issueNumber, issueUrl, title, amountUsdc, deliveryDays, description, acceptance } =
    req.body ?? {};
  if (typeof repo !== "string" || !repo.includes("/")) {
    return void res.status(400).json({ error: "bad_repo" });
  }
  const [owner, name] = repo.split("/");
  const repoRow = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (!repoRow) return void res.status(400).json({ error: "unknown_repo" });
  const install = db.find("installations", (i) => i.id === repoRow.installationId);
  if (!install) return void res.status(400).json({ error: "unknown_installation" });
  if (!userInInstall(install, user.id)) return void res.status(403).json({ error: "forbidden" });
  if (typeof amountUsdc !== "number" || typeof deliveryDays !== "number") {
    return void res.status(400).json({ error: "bad_amount_or_duration" });
  }
  try {
    const bounty = createBounty({
      source: "github",
      installationId: install.installationId,
      repo,
      issueNumber: Number(issueNumber) || 0,
      issueUrl: String(issueUrl || ""),
      title: String(title || `Bounty on ${repo}`),
      description: typeof description === "string" ? description : undefined,
      acceptance: Array.isArray(acceptance) ? acceptance : undefined,
      amountUsdc,
      deliveryDays,
      sponsorUserId: user.id,
      createdByLogin: user.githubLogin || null,
    });
    // Same confirm comment as the comment-command path, so the funding links
    // reach the issue no matter how the bounty was created. Off the request
    // thread; best-effort (failures are diagnosed in the log, and the response
    // below already carries the funding URL).
    if (bounty.issueNumber > 0) void postAndRecordConfirmComment(bounty);
    res.json({ bounty, fundingUrl: fundingUrl(bounty.id) });
  } catch (err) {
    res.status(400).json({ error: "invalid_bounty", message: (err as Error).message });
  }
});

// --- funding (token-scoped; sponsor need not have a session) ---

bounties.get("/bounties/:id/funding-tx", async (req, res) => {
  if (!requireStellar(res)) return;
  const bountyId = verifyBountyLinkToken(String(req.query.token || ""), "fund");
  if (bountyId !== req.params.id) return void res.status(403).json({ error: "invalid_token" });
  const address = String(req.query.address || "");
  try {
    const r = await buildFundingTx(bountyId, address);
    if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
    // Return the network passphrase the XDR was built for so Freighter signs
    // against the same network the backend will submit to (rather than whatever
    // network the user happens to have selected in the extension).
    res.json({ xdr: r.xdr, networkPassphrase: networkPassphrase() });
  } catch (err) {
    res.status(400).json({ error: "build_failed", message: (err as Error).message });
  }
});

bounties.post("/bounties/:id/funding-submit", async (req, res) => {
  if (!requireStellar(res)) return;
  const bountyId = verifyBountyLinkToken(String(req.body?.token || ""), "fund");
  if (bountyId !== req.params.id) return void res.status(403).json({ error: "invalid_token" });
  const signedXdr = String(req.body?.signedXdr || "");
  if (!signedXdr) return void res.status(400).json({ error: "missing_signed_xdr" });
  const r = await submitFunding(bountyId, signedXdr);
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, hash: r.hash, status: r.reason });
});

bounties.post("/bounties/:id/cancel", async (req, res) => {
  const bountyId = verifyBountyLinkToken(String(req.body?.token || ""), "cancel");
  if (bountyId !== req.params.id) return void res.status(403).json({ error: "invalid_token" });
  const b = getBounty(bountyId);
  if (!b) return void res.status(404).json({ error: "not_found" });
  // Refund needs the chain unless it's an unfunded PENDING_FUNDING discard.
  if (b.status !== "PENDING_FUNDING" && !requireStellar(res)) return;
  const r = await cancelBounty(bountyId, "deleted");
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  const bounty = getBounty(bountyId);
  // On "submitted" only a refund tx was broadcast — the comment re-syncs to
  // "cancelled" when the keeper confirms it; don't flash an interim state.
  if (bounty && r.reason !== "submitted") void updateStatusComment(bounty);
  res.json({ ok: true, outcome: r.reason, hash: r.hash, bounty });
});

// --- applications + delegation ---

bounties.post("/bounties/:id/apply", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.githubId == null) return void res.status(400).json({ error: "no_github_identity" });
  const r = applyToBounty(req.params.id, {
    githubId: user.githubId,
    githubLogin: user.githubLogin,
    note: typeof req.body?.note === "string" ? req.body.note : undefined,
  });
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, bounty: r.bounty });
});

bounties.post("/bounties/:id/applications/:githubId/:action", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (!isSponsor(b, user.id)) return void res.status(403).json({ error: "forbidden" });
  const githubId = Number(req.params.githubId);
  const action = req.params.action;
  const r =
    action === "approve"
      ? approveApplication(b.id, githubId, user.githubLogin)
      : action === "reject"
        ? rejectApplication(b.id, githubId, user.githubLogin)
        : { ok: false, reason: "bad_action" };
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  // Tell the applicant either way. Being picked is the contributor app's
  // "awarded" alert; being turned down matters just as much, because otherwise a
  // rejected application sits in their dashboard looking live indefinitely
  // (nothing ever mass-rejects the losing applicants when someone else accepts).
  const applicant = db.find("users", (u) => u.githubId === githubId);
  if (applicant && action === "approve") {
    pushNotification(
      applicant.id,
      "bounty",
      `You were picked for ${b.code}`,
      `${b.repo}#${b.issueNumber} — ${b.title}. Accept to start the clock.`,
      { link: "/dashboard" }
    );
  } else if (applicant && action === "reject") {
    pushNotification(
      applicant.id,
      "bounty",
      `Your application for ${b.code} wasn't accepted`,
      `${b.repo}#${b.issueNumber} — ${b.title}`,
      { link: "/bounties" }
    );
  }
  res.json({ ok: true, bounty: r.bounty });
});

// The approved contributor accepts + provides their payout wallet → starts the clock.
bounties.post("/bounties/:id/accept", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  if (user.githubId == null) return void res.status(400).json({ error: "no_github_identity" });
  const address = String(req.body?.address || "");
  const memoCheck = validateMemo(req.body?.memo);
  if (!memoCheck.ok) return void res.status(400).json({ error: "invalid_memo" });
  const r = await acceptAndStartClock(
    req.params.id,
    { githubId: user.githubId, githubLogin: user.githubLogin, userId: user.id },
    address,
    memoCheck.memo
  );
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  if (r.bounty) void updateStatusComment(r.bounty); // reflect "delegated" on the issue
  res.json({ ok: true, bounty: r.bounty });
});

// --- payout (in-app "Approve payment" — sponsor Freighter-signs) ---

bounties.post("/bounties/:id/approve-tx", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (!isSponsor(b, user.id)) return void res.status(403).json({ error: "forbidden" });
  try {
    const r = await buildSponsorReleaseTx(b.id);
    if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
    res.json({ xdr: r.xdr });
  } catch (err) {
    res.status(400).json({ error: "build_failed", message: (err as Error).message });
  }
});

bounties.post("/bounties/:id/approve-submit", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (!isSponsor(b, user.id)) return void res.status(403).json({ error: "forbidden" });
  const signedXdr = String(req.body?.signedXdr || "");
  if (!signedXdr) return void res.status(400).json({ error: "missing_signed_xdr" });
  const r = await submitSponsorRelease(b.id, signedXdr);
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, hash: r.hash, status: r.reason });
});

// --- delete (sponsor; only while undelegated) ---

bounties.delete("/bounties/:id", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (!isSponsor(b, user.id)) return void res.status(403).json({ error: "forbidden" });
  // Refund needs the chain unless it's an unfunded PENDING_FUNDING discard.
  if (b.status !== "PENDING_FUNDING" && !requireStellar(res)) return;
  const r = await deleteBounty(b.id);
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, bounty: r.bounty });
});

// --- contributor submission surface (explicit submit / links / payout ask) ---

// The contributor's view of a bounty row: their own applications only (mirrors
// getBountyHandler's non-sponsor branch) and no sponsor links.
function contributorFacing(b: Bounty, githubId: number | null) {
  return { ...b, applications: b.applications.filter((a) => a.githubId === githubId) };
}

// The DevAsign user row for a bounty's assignee, for notifications.
function assigneeUser(b: Bounty) {
  if (b.assigneeGithubId == null) return null;
  return db.find("users", (u) => u.githubId === b.assigneeGithubId);
}

// Explicit "submit work": the assignee pastes their PR URL (+ optional
// supporting links). Verifies the PR on GitHub — it must exist in the bounty's
// repo and be authored by the assignee (same identity rule as the webhook path,
// bounties/webhooks.ts) — then marks the bounty IN_REVIEW and makes sure a
// review row exists so the criteria pipeline runs. Coexists with the
// webhook-inferred path: re-submitting the same PR just records links/timestamp.
bounties.post("/bounties/:id/submit", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  const parsed = parsePrUrl(req.body?.prUrl);
  if (!parsed) return void res.status(400).json({ error: "invalid_pr_url" });
  const check = validateSubmission(b, user, parsed);
  if (!check.ok) {
    const status = check.reason === "not_assignee" ? 403 : 400;
    return void res.status(status).json({ error: check.reason });
  }
  let pr: any;
  try {
    pr = await gh<any>(b.installationId, `/repos/${b.repo}/pulls/${parsed.prNumber}`);
  } catch {
    return void res.status(400).json({ error: "pr_not_found" });
  }
  if (!pr || pr.user?.id !== b.assigneeGithubId) {
    return void res.status(403).json({ error: "pr_author_mismatch" });
  }
  const r = markInReview(b.id, parsed.prNumber);
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  const links = sanitizeLinks(req.body?.links);
  db.update("bounties", (x) => x.id === b.id, {
    submittedAt: Date.now(),
    ...(links.length ? { supportingLinks: links } : {}),
    updatedAt: Date.now(),
  });
  recordBountyEvent(b.id, "submitted", {
    actor: user.githubLogin,
    detail: `PR #${parsed.prNumber}${links.length ? ` + ${links.length} supporting link${links.length === 1 ? "" : "s"}` : ""}`,
  });
  const updated = getBounty(b.id);
  // Materialize + enqueue the AI review for this PR (reuses an existing row).
  // Attributed to the install owner: the assignee is an external contributor.
  void ensurePRReview(b.repo, parsed.prNumber, b.installationId, undefined, {
    attributeToOwner: true,
  }).catch((err) => console.warn(`[bounty] ensurePRReview failed for ${b.code}:`, err));
  if (updated) void updateStatusComment(updated);
  res.json({ ok: true, bounty: contributorFacing(updated ?? b, user.githubId) });
});

// Add/replace the supporting links on an in-flight submission.
bounties.post("/bounties/:id/links", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (user.githubId == null || b.assigneeGithubId !== user.githubId) {
    return void res.status(403).json({ error: "not_assignee" });
  }
  if (b.status !== "DELEGATED" && b.status !== "IN_REVIEW") {
    return void res.status(400).json({ error: `bad_status_${b.status.toLowerCase()}` });
  }
  const links = sanitizeLinks(req.body?.links);
  const updated = db.update("bounties", (x) => x.id === b.id, {
    supportingLinks: links,
    updatedAt: Date.now(),
  });
  res.json({ ok: true, bounty: contributorFacing(updated ?? b, user.githubId) });
});

// The contributor withdraws their own pending application (the design's
// "Withdraw application" CTA on the Bounties page).
bounties.post("/bounties/:id/withdraw-application", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.githubId == null) return void res.status(400).json({ error: "no_github_identity" });
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  const r = withdrawApplication(b.id, { githubId: user.githubId, githubLogin: user.githubLogin });
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, bounty: r.bounty ? contributorFacing(r.bounty, user.githubId) : undefined });
});

// The contributor asks the sponsor to release payment (all criteria green).
// Purely a signal — funds still move only via the sponsor's Freighter release
// or the merge-triggered admin release. Idempotent: re-asking just re-notifies.
bounties.post("/bounties/:id/request-payout", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (user.githubId == null || b.assigneeGithubId !== user.githubId) {
    return void res.status(403).json({ error: "not_assignee" });
  }
  if (b.status !== "IN_REVIEW") {
    return void res.status(400).json({ error: `bad_status_${b.status.toLowerCase()}` });
  }
  db.update("bounties", (x) => x.id === b.id, {
    payoutRequestedAt: Date.now(),
    updatedAt: Date.now(),
  });
  recordBountyEvent(b.id, "payout_requested", { actor: user.githubLogin });
  const updated = getBounty(b.id);
  if (b.sponsorUserId) {
    pushNotification(
      b.sponsorUserId,
      "bounty",
      `@${user.githubLogin} requested payout on ${b.code}`,
      `${b.repo}#${b.issueNumber} — ${b.title}`,
      { link: "/bounties" }
    );
  }
  res.json({ ok: true, bounty: contributorFacing(updated ?? b, user.githubId) });
});

// The sponsor rejects the submitted work, with a required reason. The bounty
// STAYS IN_REVIEW — rejection is a flag on the review stage, so the contributor
// can rework and resubmit, accept the verdict (refund), or dispute (future).
bounties.post("/bounties/:id/reject-submission", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (!isSponsor(b, user.id)) return void res.status(403).json({ error: "forbidden" });
  if (b.status !== "IN_REVIEW") {
    return void res.status(400).json({ error: `bad_status_${b.status.toLowerCase()}` });
  }
  const reason = String(req.body?.reason || "").trim().slice(0, 2000);
  if (!reason) return void res.status(400).json({ error: "missing_reason" });
  db.update("bounties", (x) => x.id === b.id, {
    rejection: { reason, byLogin: user.githubLogin, at: Date.now() },
    updatedAt: Date.now(),
  });
  recordBountyEvent(b.id, "submission_rejected", {
    actor: user.githubLogin,
    detail: reason.slice(0, 140),
  });
  const updated = getBounty(b.id);
  const dev = assigneeUser(b);
  if (dev) {
    pushNotification(
      dev.id,
      "bounty",
      `Your submission on ${b.code} was rejected`,
      `${b.repo}#${b.issueNumber} — ${reason.slice(0, 140)}`,
      { link: "/dashboard" }
    );
  }
  res.json({ ok: true, bounty: updated ?? b });
});

// The contributor accepts the sponsor's rejection verdict: the escrow refunds
// to the sponsor and the bounty closes. Terminal — requires a standing rejection.
bounties.post("/bounties/:id/accept-rejection", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  if (user.githubId == null || b.assigneeGithubId !== user.githubId) {
    return void res.status(403).json({ error: "not_assignee" });
  }
  if (!b.rejection) return void res.status(400).json({ error: "no_rejection" });
  recordBountyEvent(b.id, "rejection_accepted", { actor: user.githubLogin });
  const r = await refundBounty(b.id, "rejected");
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  const after = getBounty(b.id);
  if (after) void updateStatusComment(after);
  if (b.sponsorUserId) {
    pushNotification(
      b.sponsorUserId,
      "bounty",
      `@${user.githubLogin} accepted the rejection on ${b.code}`,
      `${b.repo}#${b.issueNumber} — escrow refund submitted`,
      { link: "/bounties" }
    );
  }
  res.json({ ok: true, bounty: after ? contributorFacing(after, user.githubId) : undefined });
});

// The AI review verdicts for a bounty's delivering PR, shaped for the
// contributor app's criteria view. Assignee or sponsor only — this is a
// deliberate subset of the maintainer review surface (no logs, no task
// internals), and unlike routes/api.ts getReviewHandler it does NOT require
// installation membership (contributors have none).
bounties.get("/bounties/:id/review", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  const isAssignee = user.githubId != null && b.assigneeGithubId === user.githubId;
  if (!isAssignee && !isSponsor(b, user.id)) {
    return void res.status(403).json({ error: "forbidden" });
  }
  const review = findBountyReview(b);
  if (!review) return void res.status(404).json({ error: "no_review" });

  // bounty-N criteria in acceptance order; anything else (criteria appended by
  // later pushes / maintainer comments) surfaces as "additional findings".
  const toView = (c: (typeof review.criteria)[number], n: number) => ({
    n,
    text: c.text,
    status: c.met === true ? "met" : c.met === false ? "unmet" : "pending",
    finding: c.evidence ?? null,
  });
  const { main, rest } = partitionBountyCriteria(review);
  res.json({
    review: {
      status: review.status,
      prTitle: review.prTitle,
      // The pipeline's natural-language verdict — the design's "review line".
      summary: review.verdict ?? null,
      headSha: review.headSha,
      prNumber: review.prNumber,
      additions: review.additions,
      deletions: review.deletions,
      changedFiles: review.changedFiles,
      updatedAt: review.updatedAt,
      counts: criteriaCounts(main),
      criteria: main.map((c, i) => toView(c, i + 1)),
      extraCriteria: rest.map((c, i) => toView(c, i + 1)),
    },
  });
});

// --- contributor payout wallet registration ---

bounties.post("/me/payout-address", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const address = String(req.body?.address || "");
  try {
    assertValidAddress(address);
  } catch {
    return void res.status(400).json({ error: "invalid_address" });
  }
  const memoCheck = validateMemo(req.body?.memo);
  if (!memoCheck.ok) return void res.status(400).json({ error: "invalid_memo" });
  // Best-effort trustline probe: cache the answer for a warning badge in the
  // contributor app, but NEVER block registration on it — Horizon flakiness
  // returns true (see hasUsdcTrustline), and the hard check stays at accept.
  const trustline = await hasUsdcTrustline(address);
  db.update("users", (u) => u.id === user.id, {
    stellarPayoutAddress: address,
    stellarPayoutMemo: memoCheck.memo,
    stellarPayoutTrustline: trustline,
  });
  res.json({ ok: true, address, memo: memoCheck.memo, trustline });
});

// Remove the registered wallet entirely (payouts pause until a new one is added;
// past payouts keep their own dest snapshots on the transaction rows).
bounties.delete("/me/payout-address", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  db.update("users", (u) => u.id === user.id, {
    stellarPayoutAddress: undefined,
    stellarPayoutMemo: undefined,
    stellarPayoutTrustline: undefined,
  });
  res.json({ ok: true });
});
