// Rate limiting. The server shipped with no throttle anywhere (no
// express-rate-limit, no helmet), so a single client could hammer the
// unauthenticated surface — the OAuth callback, the webhook receivers, and
// especially any route that kicks off an LLM job — and run Anthropic/Gemini
// spend up at will. These buckets put a ceiling on that.
//
// Accuracy caveat: server.ts sets `trust proxy: true` (required so Render's
// TLS-terminating proxy is believed about https — see the comment there). That
// also means req.ip is read from the client-supplied X-Forwarded-For and can be
// spoofed to dodge a per-IP limit. So these limiters stop naive floods, not a
// determined attacker rotating XFF; the durable fix is pinning the proxy hop
// count, which we avoid here so as not to disturb secure-cookie detection. We
// disable express-rate-limit's own permissive-trust-proxy warning, having
// acknowledged the trade-off, to keep the logs clean.
//
// Note: the default MemoryStore is per-process. On a single Render instance
// that's the whole picture; if the API is ever scaled out, each instance keeps
// its own counters and the effective limit multiplies by the instance count.
// Move to a shared store (Redis) before relying on these as a hard ceiling.
import rateLimit, { type Options } from "express-rate-limit";

const shared: Partial<Options> = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // We knowingly run behind a permissive `trust proxy` (see above); silence the
  // library's warning rather than have it fire on every boot.
  validate: { trustProxy: false },
  message: { error: "rate_limited" },
};

// Broad flood shield on every request. Deliberately generous: an active
// dashboard polls several resources every couple of seconds across tabs, and
// office NAT lumps many users behind one IP, so this has to clear normal use by
// a wide margin. Its only job is to cap a gross flood — the real LLM-cost
// ceiling is `expensiveLimiter` below.
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 600,
  // Never throttle health/uptime probes: Render (and any external monitor) hits
  // these far more often than a human would and must not get locked out.
  skip: (req) => req.path === "/api/health" || req.path === "/health",
});

// Auth handshakes: OAuth start + callback and sign-out. Unauthenticated entry
// points, and each callback does a token exchange, so they warrant a tighter cap
// than general traffic — but a human signs in rarely (and a shared office IP a
// handful of times an hour), so 50 / 15 min leaves ample headroom.
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: 50,
});

// The expensive bucket: routes that can enqueue an LLM job — criteria synthesis
// on a new attachment, a review re-run, a repo re-index, a reviews sync. This is
// the actual DoS-cost ceiling. A real user clicking around won't approach
// 30/min; an attacker is capped well before the spend adds up.
export const expensiveLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 30,
});
