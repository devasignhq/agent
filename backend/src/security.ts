import helmet from "helmet";

// Security headers on every response (HSTS, nosniff, frameguard, referrer
// policy, …). Three deviations from helmet's defaults, all because this is a
// JSON API + OAuth redirector consumed cross-origin by the SPA at WEB_ORIGIN
// (e.g. www.devasign.ai) — it never serves the SPA's own documents:
//   · contentSecurityPolicy off — a CSP belongs on the HTML host, not a JSON
//     API; helmet's default policy is meaningless here and only invites
//     confusion.
//   · crossOriginResourcePolicy: cross-origin — the default `same-origin` is the
//     wrong signal for a separate-origin client; relax it so the SPA is never
//     blocked from reading a response.
//   · crossOriginOpenerPolicy off — helmet's default `same-origin` lands on our
//     OAuth 302s (/api/auth/github, …/callback, /api/install/redirect, the
//     Linear pair). The auth/install/Linear popups are opened from WEB_ORIGIN
//     (COOP unsafe-none) and navigate cross-origin to here; browsers evaluate
//     COOP across the redirect chain, so a `same-origin` response forces a
//     browsing-context-group switch that severs the popup's window.opener. With
//     no opener the popup can't postMessage back and the opener can't close it,
//     so the full SPA mounts inside the popup instead (see frontend main.tsx).
//     COOP protects top-level *documents* an attacker might open; it's
//     meaningless on a redirect-only API, so drop it.
//
// Lives in its own module (not inline in server.ts) so the COOP-off invariant —
// which only misbehaves in the cross-origin prod topology, never in local dev —
// can be regression-tested without booting the server. See security.test.ts.
export const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false,
});
