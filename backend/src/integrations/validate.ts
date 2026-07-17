// Validate the body of POST /integrations before it becomes a stored row.
//
// The endpoint is authenticated and every row is scoped to the caller's own
// userId, so the risk here is data integrity rather than cross-tenant access: a
// row with an off-taxonomy `type` or a malformed `tokens` object is later read
// by the review worker and the broadcast/Linear paths, where a non-string token
// becomes `Bearer [object Object]` and an unbounded workspaceMeta is persisted
// verbatim. Pure + exported so it's unit-testable offline, mirroring the other
// extracted boundary helpers (parseInterval, normalizeWorkflow, db-sanitize).
import type { IntegrationType } from "../types.js";

export const INTEGRATION_TYPES: readonly IntegrationType[] = ["slack", "linear", "discord"];

// The token field(s) that identify a usable credential for each type — at least
// one must be present as a non-empty string. This is exactly what the consumers
// read: broadcast.ts uses tokens.botToken; pipeline.ts / bounties/webhooks.ts
// use tokens.accessToken || tokens.apiKey. Requiring it here also rejects a
// type/token mismatch (e.g. type "slack" carrying only an accessToken).
const REQUIRED_TOKEN_FIELDS: Record<IntegrationType, readonly string[]> = {
  slack: ["botToken"],
  discord: ["botToken"],
  linear: ["accessToken", "apiKey"],
};

// Generous caps — real tokens (OAuth JWTs) can be long — that still stop a row
// from being used as unbounded storage.
const MAX_TOKEN_FIELDS = 8;
const MAX_TOKEN_VALUE_LEN = 8192;
const MAX_META_FIELDS = 16;
const MAX_META_KEY_LEN = 64;
const MAX_META_VALUE_LEN = 1024;

// Assigning these keys onto a plain object literal mutates its prototype. The
// values here end up as jsonb so it isn't independently exploitable, but we
// build the objects safely rather than reason about that every time.
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type ParsedIntegration = {
  type: IntegrationType;
  tokens: Record<string, string>;
  workspaceMeta: Record<string, string>;
};

export type ParseResult =
  | { ok: true; value: ParsedIntegration }
  | { ok: false; error: string };

/**
 * Whitelist the type, validate the tokens object (plain object of non-empty
 * string values carrying the type's credential), and sanitize workspaceMeta
 * (string→string, size-capped). Returns a stable error code on rejection, or the
 * cleaned value ready to persist.
 */
export function parseIntegrationInput(body: unknown): ParseResult {
  const b = isPlainObject(body) ? body : {};

  const type = b.type;
  if (typeof type !== "string" || !INTEGRATION_TYPES.includes(type as IntegrationType)) {
    return { ok: false, error: "unsupported_integration_type" };
  }
  const t = type as IntegrationType;

  // tokens: strict — a malformed credential is rejected, never coerced.
  if (!isPlainObject(b.tokens)) return { ok: false, error: "invalid_tokens" };
  const tokenEntries = Object.entries(b.tokens).filter(([k]) => !UNSAFE_KEYS.has(k));
  if (tokenEntries.length > MAX_TOKEN_FIELDS) return { ok: false, error: "invalid_tokens" };
  const tokens: Record<string, string> = {};
  for (const [k, v] of tokenEntries) {
    if (typeof v !== "string" || v.length > MAX_TOKEN_VALUE_LEN) {
      return { ok: false, error: "invalid_tokens" };
    }
    tokens[k] = v;
  }
  const hasCredential = REQUIRED_TOKEN_FIELDS[t].some((f) => (tokens[f] ?? "").trim().length > 0);
  if (!hasCredential) return { ok: false, error: "missing_credential" };

  // workspaceMeta: lenient — non-object becomes {}, non-string entries are
  // dropped, keys/values capped. It's non-credential metadata (channel, urlKey).
  const workspaceMeta: Record<string, string> = {};
  if (isPlainObject(b.workspaceMeta)) {
    let count = 0;
    for (const [k, v] of Object.entries(b.workspaceMeta)) {
      if (UNSAFE_KEYS.has(k) || k.length > MAX_META_KEY_LEN || typeof v !== "string") continue;
      if (count >= MAX_META_FIELDS) break;
      workspaceMeta[k] = v.slice(0, MAX_META_VALUE_LEN);
      count++;
    }
  }

  return { ok: true, value: { type: t, tokens, workspaceMeta } };
}
