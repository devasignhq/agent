// GitHub Actions OIDC verification for the runner → API calls. No shared secret:
// the runner presents the job's id-token and we check GitHub's JWKS signature,
// issuer, and our audience. Claim names per GitHub's OIDC docs.
import { createPublicKey, type JsonWebKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type ActionsClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  repository: string; // "owner/name"
  repository_id: string;
  repository_owner?: string;
  sha: string; // the workflow's GITHUB_SHA (merge-ref sha on pull_request events)
  ref: string; // "refs/pull/N/merge" on pull_request events
  event_name: string;
  run_id: string;
  run_attempt?: string;
  actor?: string;
  workflow?: string;
  job_workflow_ref?: string;
};

export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export type OidcFailure =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "wrong_audience"
  | "wrong_issuer"
  | "missing_claims";

export type OidcResult = { ok: true; claims: ActionsClaims } | { ok: false; reason: OidcFailure };

export type OidcDeps = {
  jwks?: () => Promise<Jwk[]>;
  now?: () => number; // ms
};

const REQUIRED = ["repository", "repository_id", "sha", "ref", "event_name", "run_id"] as const;
const JWKS_TTL_MS = 10 * 60_000;

let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(config.verify.oidcJwksUrl, {
    headers: { "User-Agent": "devasign-app", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`jwks fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(data.keys) ? data.keys : [];
}

// Refetch once on an unknown kid: GitHub rotates keys and a fresh key can be
// signing tokens before our 10-minute cache expires.
async function keyFor(kid: string, deps: OidcDeps): Promise<Jwk | null> {
  const now = deps.now ? deps.now() : Date.now();
  if (deps.jwks) {
    const keys = await deps.jwks();
    return keys.find((k) => k.kid === kid) ?? null;
  }
  if (!cache || now - cache.fetchedAt > JWKS_TTL_MS) cache = { keys: await fetchJwks(), fetchedAt: now };
  let key = cache.keys.find((k) => k.kid === kid);
  if (!key) {
    cache = { keys: await fetchJwks(), fetchedAt: now };
    key = cache.keys.find((k) => k.kid === kid);
  }
  return key ?? null;
}

export async function verifyActionsToken(token: string, deps: OidcDeps = {}): Promise<OidcResult> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string") return { ok: false, reason: "malformed" };
  const { kid, alg } = decoded.header;
  if (!kid || alg !== "RS256") return { ok: false, reason: "malformed" };

  let jwk: Jwk | null;
  try {
    jwk = await keyFor(kid, deps);
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  if (!jwk) return { ok: false, reason: "unknown_key" };

  let pem: string;
  try {
    pem = createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" }) as string;
  } catch {
    return { ok: false, reason: "unknown_key" };
  }

  try {
    const claims = jwt.verify(token, pem, {
      algorithms: ["RS256"],
      issuer: config.verify.oidcIssuer,
      audience: config.verify.oidcAudience,
      ...(deps.now ? { clockTimestamp: Math.floor(deps.now() / 1000) } : {}),
    }) as Record<string, unknown>;
    for (const f of REQUIRED) {
      if (typeof claims[f] !== "string" || !claims[f]) return { ok: false, reason: "missing_claims" };
    }
    return { ok: true, claims: claims as unknown as ActionsClaims };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: "expired" };
    const msg = err instanceof Error ? err.message : String(err);
    if (/audience/i.test(msg)) return { ok: false, reason: "wrong_audience" };
    if (/issuer/i.test(msg)) return { ok: false, reason: "wrong_issuer" };
    return { ok: false, reason: "bad_signature" };
  }
}

/** PR number from a pull_request event's ref ("refs/pull/N/merge"), else null. */
export function prNumberFromRef(ref: string): number | null {
  const m = /^refs\/pull\/(\d+)\/(merge|head)$/.exec(ref || "");
  return m ? Number(m[1]) : null;
}

export function resetOidcCacheForTests(): void {
  cache = null;
}
