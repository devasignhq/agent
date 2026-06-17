// CSRF mitigation for state-changing requests.
//
// In prod the session cookie is SameSite=None; Secure (see github/oauth.ts) —
// required so it rides the cross-origin XHR between the dashboard
// (www.devasign.ai) and the API (api.devasign.ai), which are different hosts
// under the same site. The price of SameSite=None is that the browser also
// attaches the cookie to *cross-site* requests, so a page on evil.com can drive
// an authenticated request against our API with the victim's session.
//
// JSON-body endpoints are already shielded by the CORS preflight: a cross-site
// fetch sending `Content-Type: application/json` is a "non-simple" request, so
// the browser fires a preflight first and our cors() allowlist rejects it. But a
// body-less POST — POST /reviews/sync, /reviews/:id/rerun, /notifications/read —
// is a CORS "simple request": no preflight, so CORS never gets a vote and the
// request reaches the handler with the victim's cookie attached.
//
// Defense: on every unsafe (state-changing) method, require that the request's
// Origin — or, when Origin is absent, the origin parsed from Referer — equals our
// own web origin. A cross-site attacker cannot forge or strip the Origin header
// on a browser-issued request, so a mismatched Origin is rejected before the
// handler runs. A request carrying *neither* header is allowed through: browsers
// always attach Origin to cross-site unsafe requests, so a header-less caller is
// a non-browser client (curl, a script, the ephemeral-dev test harness) and not a
// CSRF vector.
//
// Only enforced when secureCookies is set (an https WEB_ORIGIN → SameSite=None →
// prod). In local dev the cookie is SameSite=Lax, so the browser won't send it on
// a cross-site request in the first place and CSRF is structurally impossible —
// skipping the check there also keeps the Vite dev proxy and the cookie-minting
// test scripts working without pinning WEB_ORIGIN to an exact value.
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

// Methods that can't change state (GET/HEAD) or are the CORS preflight (OPTIONS,
// handled by cors() and answered before this runs). Everything else is gated.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The request's origin, preferring the Origin header and falling back to the
// origin component of the Referer URL. null when neither is present or parseable.
function requestOrigin(req: Request): string | null {
  const origin = req.get("origin");
  if (origin) return origin;
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function enforceSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!config.secureCookies || SAFE_METHODS.has(req.method)) return next();
  const origin = requestOrigin(req);
  // Present-but-foreign Origin/Referer ⇒ cross-site request ⇒ reject. Absent ⇒
  // non-browser client (see header note above) ⇒ allow.
  if (origin !== null && origin !== config.webOrigin) {
    res.status(403).json({ error: "bad_origin" });
    return;
  }
  next();
}
