// Statsig server SDK singleton — the backend's analytics sink (successor to
// the removed PostHog client) and feature-gate source. Analytics call sites go
// through track(), which no-ops while the client is unconfigured/uninitialized
// and never throws: analytics is best-effort and must not break a request path.
// Gates go through checkGate(), which deliberately does NOT share that no-op
// rule — see the comment there.
import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import { config, isStatsigConfigured } from "./config.js";
import type { User } from "./types.js";

let client: Statsig | null = null;

export async function initStatsig(): Promise<void> {
  if (!isStatsigConfigured()) return;
  try {
    const c = new Statsig(config.statsig.secretKey, {
      environment: config.statsig.environment,
    });
    await c.initialize();
    client = c;
  } catch (err) {
    console.error("[statsig] init failed — events will be dropped", err);
  }
}

// Statsig has no separate identify() call; user properties ride along on each
// event's user object, so build the fullest one the call site can provide.
// Webhook/sweep paths only have a userId string — that still attributes the
// event, just without the profile fields. Exported for unit tests since track()
// itself no-ops without a live client.
export function toStatsigUser(user: User | string): StatsigUser {
  if (typeof user === "string") return StatsigUser.withUserID(user);
  return new StatsigUser({
    userID: user.id,
    email: user.email,
    custom: { github_login: user.githubLogin, plan: user.plan },
  });
}

// Statsig event metadata is conventionally string-valued, and the native core
// serializes whatever it's handed. Call sites pass numbers (pr_number),
// booleans (is_private), and string|null (workspace_name) for readability, so
// coerce every surviving value with String() and drop null/undefined rather
// than letting empty/"null" noise ride along on the event. Exported for unit
// tests since track() itself no-ops without a live client.
export function normalizeMetadata(
  metadata?: Record<string, string | number | boolean | null | undefined>
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

export function track(
  user: User | string,
  event: string,
  metadata?: Record<string, string | number | boolean | null | undefined>
): void {
  if (!client) return;
  try {
    client.logEvent(toStatsigUser(user), event, null, normalizeMetadata(metadata));
  } catch (err) {
    console.warn(`[statsig] failed to log "${event}":`, err);
  }
}

/**
 * Every feature gate this backend reads, in one place so the set is greppable
 * and the names stay consistent with the Statsig console. snake_case to match
 * everything else Statsig-facing here (pr_number, github_login, est_cost_usd).
 */
export const GATES = {
  /** Draft acceptance criteria when a bounty is created (bounties/criteria-job.ts). */
  bountyCriteriaDrafting: "bounty_criteria_drafting",
} as const;

/**
 * Feature-gate check — the first in this codebase, so it sets the pattern.
 *
 * The obvious implementation is track()'s `if (!client) return` no-op guard,
 * but a gate is not an event sink and copying it would be wrong: `client` is
 * null in local dev AND across the entire test suite (nothing outside
 * server.ts calls initStatsig), so a bare fail-closed gate would silently
 * disable the gated feature everywhere except production. Three states, not
 * two:
 *
 *   unconfigured      -> `fallback`. No provider means "no rollout control
 *                        available", NOT "no features": dev, tests and
 *                        self-hosted installs keep working.
 *   configured        -> the console is the only authority. An unknown or
 *                        disabled gate is false, which is the exposure control.
 *   init failed/throw -> false. Fail CLOSED, so a Statsig outage can never
 *                        silently switch on a half-rolled-out feature in prod.
 *
 * Sync, like track(): the node-core SDK's checkGate returns a boolean, not a
 * promise. Deliberately does NOT lazily initialize — the test script blanks
 * ANTHROPIC_API_KEY/GEMINI_API_KEY but not STATSIG_SECRET_KEY, so a developer
 * with that var exported would start making real network calls during
 * `npm test`. Init stays owned by server.ts.
 */
export function checkGate(user: User | string, gate: string, fallback = false): boolean {
  if (!isStatsigConfigured()) return fallback;
  if (!client) return false;
  try {
    return client.checkGate(toStatsigUser(user), gate);
  } catch (err) {
    console.warn(`[statsig] gate check failed for "${gate}":`, err);
    return false;
  }
}

// Flushes queued events; wired into the SIGINT/SIGTERM handler alongside
// shutdownDb() so a clean exit doesn't drop the tail of the event queue.
export async function shutdownStatsig(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    console.warn("[statsig] shutdown error:", err);
  }
}
