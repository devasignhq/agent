// Rate limiting. The server shipped with no throttle anywhere (no
// express-rate-limit, no helmet), so a single client could hammer the
// unauthenticated surface — the OAuth callback, the webhook receivers, and
// especially any route that kicks off an LLM job — and run Anthropic/Gemini
// spend up at will. These buckets put a ceiling on that.
//
// Keying: server.ts pins `trust proxy` to 1 hop, so req.ip resolves to the
// address Render appended (the real client) rather than a client-supplied
// X-Forwarded-For value — the per-IP buckets below can't be sidestepped by
// spoofing that header.
//
// Note: the default MemoryStore is per-process. On a single Render instance
// that's the whole picture; if the API is ever scaled out, each instance keeps
// its own counters and the effective limit multiplies by the instance count.
// Move to a shared store (Redis) before relying on these as a hard ceiling.
import rateLimit, { type Options } from "express-rate-limit";

const shared: Partial<Options> = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
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
  // Skip health/uptime probes and the webhook receivers.
  //   · Health: Render (and any external monitor) hits these far more often than
  //     a human would and must never be locked out.
  //   · Webhooks: GitHub/Stripe/Linear deliver from a small pool of shared egress
  //     IPs, so a per-IP cap would start dropping legitimate events as traffic
  //     grows. They're HMAC-gated, so an unauthenticated flood fails signature
  //     verification before it can enqueue any LLM work — the cost we actually
  //     care about. (The residual exposure is CPU on the HMAC check + the raw
  //     body parse, both bounded by the 5mb body limit set in server.ts.)
  skip: (req) =>
    req.path === "/api/health" ||
    req.path === "/health" ||
    req.path.startsWith("/api/webhooks/"),
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
