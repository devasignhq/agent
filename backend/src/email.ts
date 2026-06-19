// Transactional email via Resend's HTTP API — called with fetch in the same
// style as the GitHub (gh()) and Stripe helpers, so there's no SDK dependency.
// Sends the final "your account was deleted" notice after a hard delete.
//
// When RESEND_API_KEY is unset (local dev / tests) sendEmail logs a one-line
// preview and returns false instead of calling out — the same graceful
// degradation the rest of the app uses for Stripe / the GitHub App, so nothing
// in the delete flow depends on a live mail provider.
//
// sendEmail never throws (a mail failure must not abort delete/restore) but it
// no longer fails *silently*: every non-delivery — missing key, unreachable
// (noreply) recipient, Resend rejection, or network error — is logged via
// console.warn, so a production gap surfaces in the logs instead of vanishing.
import { config, isEmailConfigured } from "./config.js";
import type { User } from "./types.js";

const BRAND = "DevAsign";

// GitHub stores private-email users with a `${login}@users.noreply.github.com`
// address (see oauth.ts). Resend will *accept* a send to it, but GitHub bounces
// inbound mail there, so it never arrives — treat that (and an empty address) as
// unreachable and skip the call. Kept local on purpose: importing the matching
// helper from oauth.ts would create an email→oauth→account→email import cycle.
const NOREPLY_SUFFIX = "@users.noreply.github.com";
const isReachable = (to: string): boolean => !!to && !to.endsWith(NOREPLY_SUFFIX);

// Best-effort low-level send. Never throws into the caller: a mail failure must
// not abort account deletion / restore, so we log it and return false instead.
export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  // No point calling Resend for an address that can't receive mail — it would
  // accept a noreply recipient and silently bounce. Skip and record instead.
  if (!isReachable(to)) {
    console.warn(`[email] unreachable recipient — skipping "${subject}" to ${to || "<empty>"}`);
    return false;
  }
  if (!isEmailConfigured()) {
    console.log(`[email] not configured — would send to ${to}: "${subject}"`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.email.from, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[email] send failed: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[email] send error for ${to}:`, err);
    return false;
  }
}

// ─── Templates ──────────────────────────────────────────────────────────────

// Minimal, client-safe inline-styled shell shared by every transactional mail.
function layout(heading: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">
  <h1 style="font-size:18px;margin:0 0 16px">${heading}</h1>
  ${bodyHtml}
  <p style="font-size:12px;color:#888;margin-top:24px">— The ${BRAND} team</p>
</div>`;
}

// Sent right after the account is permanently wiped. We can't revoke the user's
// OAuth grant ourselves (we never store their token), so the mail tells them to
// remove DevAsign from their authorized apps.
export function sendAccountPurgedEmail(user: User): Promise<boolean> {
  const html = layout("Your account has been deleted", `
    <p>Hi ${user.githubLogin},</p>
    <p>Your ${BRAND} account and all associated data have been permanently deleted, and any active subscription was canceled.</p>
    <p><strong>One last step:</strong> to fully revoke ${BRAND}'s access, open GitHub → <em>Settings → Applications → Authorized GitHub Apps</em> and remove ${BRAND}.</p>
    <p>Thanks for giving us a try — you're always welcome back.</p>
  `);
  return sendEmail(user.email, `Your ${BRAND} account has been deleted`, html);
}
