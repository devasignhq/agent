// Linear GraphQL client. Centralizes every call DevAsign makes to Linear so the
// OAuth flow, webhook ingestion, PR-review resolution, and verdict notification
// all share one transport + one place to adjust for Linear API changes.
//
// Auth: OAuth access tokens use `Authorization: Bearer <token>`; a personal API
// key (the `LINEAR_API_KEY` dev fallback) uses the raw key with no scheme. Pass
// `{ bearer: false }` for the latter.

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

// Download a file referenced from an issue (a PDF/image dropped into the
// description, or an attachment URL). Linear-hosted uploads require the auth
// header; external URLs are fetched anonymously. Best-effort — returns null on
// any failure so the review just proceeds without that file.
export async function downloadLinearFile(
  token: string,
  url: string,
  opts: { bearer?: boolean } = {}
): Promise<{ base64: string; mediaType: string; size: number } | null> {
  try {
    const auth = opts.bearer === false ? token : `Bearer ${token}`;
    const isLinearHosted = /\blinear\.app\b/i.test(new URL(url).host);
    const res = await fetch(url, isLinearHosted ? { headers: { Authorization: auth } } : {});
    if (!res.ok) return null;
    const mediaType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString("base64"), mediaType, size: buf.length };
  } catch (err) {
    console.warn("[linear] file download failed:", url, err);
    return null;
  }
}

