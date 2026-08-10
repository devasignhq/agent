// Linear GraphQL client. Centralizes every call DevAsign makes to Linear so the
// OAuth flow, webhook ingestion, PR-review resolution, and verdict notification
// all share one transport + one place to adjust for Linear API changes.
//
// Auth: OAuth access tokens use `Authorization: Bearer <token>`; a personal API
// key (the `LINEAR_API_KEY` dev fallback) uses the raw key with no scheme. Pass
// `{ bearer: false }` for the latter.

import { fetchGuarded, hostMatches } from "../ssrf.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export type LinearComment = { body: string; user?: string };
export type LinearSubIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType: string;
};
export type LinearAttachment = {
  url: string;
  title: string;
  subtitle: string;
};
export type LinearIssueContext = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string;
  stateType: string;
  labels: string[];
  parent: { identifier: string; title: string } | null;
  project: { id: string; name: string } | null;
  comments: LinearComment[];
  children: LinearSubIssue[];
  attachments: LinearAttachment[];
};
export type LinearIssueCandidate = {
  id: string;
  identifier: string;
  title: string;
  description: string;
};
export type LinearWorkspace = {
  organizationId: string;
  workspaceName: string;
  urlKey: string;
};
export type LinearTeam = {
  id: string;
  name: string;
  key: string;
};

// Open = not finished. Linear state types: triage | backlog | unstarted |
// started | completed | canceled. We treat the first four as "open".
const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);
export function isOpenState(stateType: string | undefined | null): boolean {
  return !CLOSED_STATE_TYPES.has(String(stateType || ""));
}

// Low-level transport. Throws on HTTP or GraphQL errors so callers can decide
// whether to degrade (search) or surface (webhook create).
export async function linearGraphQL<T = any>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { bearer?: boolean } = {}
): Promise<T> {
  const auth = opts.bearer === false ? token : `Bearer ${token}`;
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`linear graphql ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`linear graphql errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

// Full ticket context: description + sub-issues + comments + parent + labels.
// `idOrKey` accepts either the UUID (from a webhook payload) or the human
// identifier like "ENG-123" (from a PR reference) — Linear's `issue(id:)`
// resolves both.
export async function fetchLinearIssueContext(
  token: string,
  idOrKey: string,
  opts?: { bearer?: boolean }
): Promise<LinearIssueContext | null> {
  const query = `query Issue($id: String!) {
    issue(id: $id) {
      id identifier title url description
      state { type }
      parent { identifier title }
      project { id name }
      labels { nodes { name } }
      comments(first: 50) { nodes { body user { displayName } } }
      children(first: 50) { nodes { id identifier title description state { type } } }
      attachments(first: 25) { nodes { url title subtitle } }
    }
  }`;
  const data = await linearGraphQL<{ issue: any }>(token, query, { id: idOrKey }, opts);
  const issue = data?.issue;
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title || "",
    url: issue.url || "",
    description: issue.description || "",
    stateType: issue.state?.type || "",
    labels: (issue.labels?.nodes || []).map((l: any) => l.name).filter(Boolean),
    parent: issue.parent
      ? { identifier: issue.parent.identifier, title: issue.parent.title || "" }
      : null,
    project: issue.project ? { id: issue.project.id, name: issue.project.name || "" } : null,
    comments: (issue.comments?.nodes || [])
      .map((c: any) => ({ body: c.body || "", user: c.user?.displayName }))
      .filter((c: LinearComment) => c.body.trim()),
    children: (issue.children?.nodes || []).map((c: any) => ({
      id: c.id,
      identifier: c.identifier,
      title: c.title || "",
      description: c.description || "",
      stateType: c.state?.type || "",
    })),
    attachments: (issue.attachments?.nodes || [])
      .map((a: any) => ({ url: a.url || "", title: a.title || "", subtitle: a.subtitle || "" }))
      .filter((a: LinearAttachment) => a.url),
  };
}

// Best-effort full-text search for fuzzy PR↔issue matching. Returns OPEN issues
// only. Never throws — search is advisory, so a Linear API hiccup or an
// arg-name change just yields zero candidates (no fuzzy match) rather than
// failing the whole review.
export async function searchLinearIssues(
  token: string,
  term: string,
  opts?: { bearer?: boolean }
): Promise<LinearIssueCandidate[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const query = `query Search($term: String!) {
    issueSearch(term: $term, first: 10) {
      nodes { id identifier title description state { type } }
    }
  }`;
  try {
    const data = await linearGraphQL<{ issueSearch: { nodes: any[] } }>(
      token,
      query,
      { term: trimmed.slice(0, 250) },
      opts
    );
    return (data?.issueSearch?.nodes || [])
      .filter((n: any) => isOpenState(n.state?.type))
      .map((n: any) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title || "",
        description: n.description || "",
      }));
  } catch (err) {
    console.warn("[linear] issueSearch failed (degrading to no match):", err);
    return [];
  }
}

// Post a comment on an issue. Used for the short verdict NOTIFICATION (the full
// feedback lands on the GitHub PR).
export async function createLinearComment(
  token: string,
  issueId: string,
  body: string,
  opts?: { bearer?: boolean }
): Promise<boolean> {
  const mutation = `mutation Comment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }`;
  const data = await linearGraphQL<{ commentCreate: { success: boolean } }>(
    token,
    mutation,
    { issueId, body },
    opts
  );
  return Boolean(data?.commentCreate?.success);
}

// Workspace identity, used by the OAuth callback to label the integration and
// to route inbound webhooks back to the right integration row.
export async function fetchLinearWorkspace(
  token: string,
  opts?: { bearer?: boolean }
): Promise<LinearWorkspace | null> {
  const query = `query { viewer { organization { id name urlKey } } }`;
  const data = await linearGraphQL<{ viewer: { organization: any } }>(token, query, {}, opts);
  const org = data?.viewer?.organization;
  if (!org) return null;
  return { organizationId: org.id, workspaceName: org.name || "", urlKey: org.urlKey || "" };
}

// Who this token belongs to — the workspace member who connected DevAsign. Used
// to authorize inbound bounty commands: the connector is the account a Linear
// bounty is charged to, so their own comments are trusted (bounties/webhooks.ts).
// Cached onto the integration by the caller; this is one call per workspace.
export async function fetchLinearViewerId(
  token: string,
  opts?: { bearer?: boolean }
): Promise<string | null> {
  const query = `query { viewer { id } }`;
  const data = await linearGraphQL<{ viewer: { id?: string } }>(token, query, {}, opts);
  return data?.viewer?.id || null;
}

export type LinearUserRole = { admin: boolean; guest: boolean; active: boolean };

// A workspace member's standing, for authority checks. `admin` is the closest
// Linear equivalent of GitHub's OWNER/MEMBER association; `guest` marks a limited
// external collaborator and `active` excludes deactivated accounts — both must be
// consulted, since a guest or a suspended member can still hold a user row.
export async function fetchLinearUserRole(
  token: string,
  userId: string,
  opts?: { bearer?: boolean }
): Promise<LinearUserRole | null> {
  const query = `query User($id: String!) { user(id: $id) { id admin active guest } }`;
  const data = await linearGraphQL<{ user: { admin?: boolean; active?: boolean; guest?: boolean } | null }>(
    token,
    query,
    { id: userId },
    opts
  );
  const user = data?.user;
  if (!user) return null;
  return { admin: !!user.admin, guest: !!user.guest, active: !!user.active };
}

// Confirm whether an OAuth access token still works. Used to detect when a user
// has revoked DevAsign from their Linear workspace — Linear sends no webhook for
// that, so we probe on demand (after the user visits "Manage Access"). Returns
// "revoked" ONLY on a definitive auth failure; a transient hiccup yields
// "unknown" so we never disconnect a still-valid integration.
export async function validateLinearToken(
  token: string,
  opts: { bearer?: boolean } = {}
): Promise<"valid" | "revoked" | "unknown"> {
  const auth = opts.bearer === false ? token : `Bearer ${token}`;
  try {
    const res = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id } }" }),
    });
    if (res.status === 401 || res.status === 403) return "revoked";
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as
        | { data?: { viewer?: { id?: string } }; errors?: Array<{ message?: string }> }
        | null;
      if (json?.data?.viewer?.id) return "valid";
      if (json?.errors?.some((e) => /authentic/i.test(e?.message || ""))) return "revoked";
      return "unknown";
    }
    // Linear returns 400 with an authentication error for an invalid/expired token.
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      return /authenticat|invalid.*token|token.*invalid/i.test(body) ? "revoked" : "unknown";
    }
    return "unknown"; // 5xx and other ambiguous responses
  } catch {
    return "unknown"; // network error — don't disconnect on a blip
  }
}

// The teams the connected token can see — i.e. the teams in the workspace the user
// granted DevAsign access to. Rendered in Settings → Repository. Best-effort: a Linear
// hiccup or schema change yields an empty list rather than failing the settings page.
export async function fetchLinearTeams(
  token: string,
  opts?: { bearer?: boolean }
): Promise<LinearTeam[]> {
  const query = `query { teams(first: 250) { nodes { id name key } } }`;
  try {
    const data = await linearGraphQL<{ teams: { nodes: any[] } }>(token, query, {}, opts);
    return (data?.teams?.nodes || [])
      .map((t: any) => ({ id: t.id, name: t.name || "", key: t.key || "" }))
      .filter((t: LinearTeam) => t.id);
  } catch (err) {
    console.warn("[linear] teams lookup failed (returning none):", err);
    return [];
  }
}

/**
 * Exactly linear.app or a *.linear.app subdomain. Must be asked of a parsed
 * URL's `hostname`. This used to be a `/\blinear\.app\b/` test, which matched
 * `linear.app.evil.com` — so a ticket linking there was handed the workspace's
 * OAuth token. Never match a host by substring; see hostMatches in ssrf.ts.
 */
export function isLinearHost(hostname: string): boolean {
  return hostMatches(hostname, "linear.app");
}

// Files referenced from a ticket are attacker-reachable: anyone who can file an
// issue or comment in the workspace chooses this URL. Cap the bytes and the wall
// clock — the review worker drains serially, so one stalled fetch stalls reviews.
const MAX_LINEAR_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (pipeline skips past this anyway)
const LINEAR_FILE_TIMEOUT_MS = 15_000;

// Download a file referenced from an issue (a PDF/image dropped into the
// description, or an attachment URL). Linear-hosted uploads require the auth
// header; external URLs are fetched anonymously. Best-effort — returns null on
// any failure so the review just proceeds without that file.
//
// The URL comes from ticket text, so it goes through the shared SSRF guard
// (ssrf.ts): every hop is re-validated against private/loopback/metadata ranges
// and the socket is pinned to the addresses we checked.
export async function downloadLinearFile(
  token: string,
  url: string,
  opts: { bearer?: boolean } = {}
): Promise<{ base64: string; mediaType: string; size: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINEAR_FILE_TIMEOUT_MS);
  try {
    const auth = opts.bearer === false ? token : `Bearer ${token}`;
    const { buf, contentType } = await fetchGuarded(url, {
      signal: controller.signal,
      maxBytes: MAX_LINEAR_FILE_BYTES,
      // Recomputed per redirect hop against the URL actually being requested.
      // Both directions matter: a Linear upload 302s to a presigned S3 URL that
      // must NOT see the token (S3 rejects the extra Authorization header), and
      // a hop to any non-Linear host must never be handed our credentials.
      headersFor: (u): Record<string, string> =>
        isLinearHost(u.hostname) ? { Authorization: auth } : {},
    });
    return {
      base64: buf.toString("base64"),
      mediaType: contentType.split(";")[0].trim(),
      size: buf.length,
    };
  } catch (err) {
    console.warn("[linear] file download failed:", url, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

