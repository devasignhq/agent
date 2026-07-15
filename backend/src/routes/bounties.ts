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
import { verifyBountyLinkToken } from "../bounties/links.js";
import { fundingUrl } from "../bounties/links.js";
import { updateStatusComment } from "../bounties/botcomment.js";
import {
  acceptAndStartClock,
  applyToBounty,
  approveApplication,
  buildFundingTx,
  buildSponsorReleaseTx,
  cancelPending,
  createBounty,
  deleteBounty,
  getBounty,
  rejectApplication,
  submitFunding,
  submitSponsorRelease,
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
  return 400;
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

bounties.get("/bounties", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const ids = userInstallationIds(user.id);
  const list = db
    .filter("bounties", (b) => ids.has(b.installationId) || b.sponsorUserId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ bounties: list, summary: summarize(list) });
});

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

bounties.get("/bounties/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = getBounty(req.params.id);
  if (!b) return void res.status(404).json({ error: "not_found" });
  const isApplicant =
    user.githubId != null &&
    (b.assigneeGithubId === user.githubId ||
      b.applications.some((a) => a.githubId === user.githubId));
  if (!isSponsor(b, user.id) && !isApplicant) {
    return void res.status(403).json({ error: "forbidden" });
  }
  res.json({ bounty: b });
});

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
    });
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
    res.json({ xdr: r.xdr });
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

bounties.post("/bounties/:id/cancel", (req, res) => {
  const bountyId = verifyBountyLinkToken(String(req.body?.token || ""), "cancel");
  if (bountyId !== req.params.id) return void res.status(403).json({ error: "invalid_token" });
  const r = cancelPending(bountyId);
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  if (r.bounty) void updateStatusComment(r.bounty);
  res.json({ ok: true, bounty: r.bounty });
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
      ? approveApplication(b.id, githubId)
      : action === "reject"
        ? rejectApplication(b.id, githubId)
        : { ok: false, reason: "bad_action" };
  if (!r.ok) return void res.status(failStatus(r.reason)).json({ error: r.reason });
  res.json({ ok: true, bounty: r.bounty });
});

// The approved contributor accepts + provides their payout wallet → starts the clock.
bounties.post("/bounties/:id/accept", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!requireStellar(res)) return;
  if (user.githubId == null) return void res.status(400).json({ error: "no_github_identity" });
  const address = String(req.body?.address || "");
  const r = await acceptAndStartClock(
    req.params.id,
    { githubId: user.githubId, githubLogin: user.githubLogin, userId: user.id },
    address
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

// --- contributor payout wallet registration ---

bounties.post("/me/payout-address", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const address = String(req.body?.address || "");
  try {
    assertValidAddress(address);
  } catch {
    return void res.status(400).json({ error: "invalid_address" });
  }
  db.update("users", (u) => u.id === user.id, { stellarPayoutAddress: address });
  res.json({ ok: true, address });
});
