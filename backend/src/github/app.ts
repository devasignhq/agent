// GitHub App helpers — JWT signing + installation tokens.
// See https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
import jwt from "jsonwebtoken";
import { config, isGithubAppConfigured } from "../config.js";

let cachedJwt: { token: string; expiresAt: number } | null = null;

export function appJWT(): string {
  if (!isGithubAppConfigured()) {
    throw new Error("GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)");
  }
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.expiresAt - 60 > now) return cachedJwt.token;
  // GitHub allows up to 10 minutes; use 9 to leave buffer.
  const expiresAt = now + 9 * 60;
  // GitHub requires `iss` to be an integer; the env var is a string.
  // Casting via Number avoids GitHub's "JWT could not be decoded" 401s.
  const token = jwt.sign(
    { iat: now - 30, exp: expiresAt, iss: Number(config.github.appId) },
    config.github.privateKey,
    { algorithm: "RS256" }
  );
  cachedJwt = { token, expiresAt };
  return token;
}

type InstallationToken = { token: string; expires_at: string; permissions?: Record<string, string> };

const installTokens = new Map<
  number,
  { token: string; expiresAt: number; permissions: Record<string, string> }
>();

export async function installationToken(installationId: number): Promise<string> {
  const now = Date.now();
  const cached = installTokens.get(installationId);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJWT()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`installation token failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as InstallationToken;
  const expiresAt = Date.parse(body.expires_at);
  installTokens.set(installationId, {
    token: body.token,
    expiresAt,
    permissions: body.permissions ?? {},
  });
  return body.token;
}

// The permission map GitHub actually granted this installation's token, e.g.
// { issues: "read", pull_requests: "write" }. This is the ground truth for
// "can the App do X here" — the App-level settings can request more than an
// installation has approved. Used to turn silent 403s (e.g. posting a comment
// on a plain issue without Issues:write) into actionable diagnostics.
export async function installationPermissions(
  installationId: number
): Promise<Record<string, string>> {
  await installationToken(installationId);
  return installTokens.get(installationId)?.permissions ?? {};
}

// Uninstall the App from an account by deleting its installation. This revokes
// the App's access to every repository the installation covered in one call —
// there's no per-repo uninstall to do; the installation *is* the App's presence
// on that account. GitHub responds by emitting an `installation.deleted` webhook,
// which our webhook handler uses to clean up the local install/repo rows.
//
// Authenticates with the App JWT (Bearer), NOT an installation token — an
// installation token can't delete its own installation. Success is 204 No
// Content; a 404 means it's already gone, which we treat as success so callers
// (account deletion) stay idempotent and retry-safe.
export async function uninstallApp(installationId: number): Promise<void> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${appJWT()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devasign-app",
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`uninstall failed: ${res.status} ${await res.text()}`);
  }
  // The cached installation token (if any) is now invalid — drop it.
  installTokens.delete(installationId);
}

export async function gh<T>(
  installationId: number,
  pathOrUrl: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await installationToken(installationId);
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devasign-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${url}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Same auth as gh(), but hands back the Link header's rel="next" so a caller can
// paginate. gh() parses and discards the response, which loses it.
export async function ghPaged<T>(
  installationId: number,
  pathOrUrl: string
): Promise<{ body: T; nextUrl: string | null }> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  // Checked BEFORE minting a token: this helper follows Link headers, so it is
  // the one place a URL from a response could steer the installation token
  // off-site. A bad target must not even cause a token to be issued.
  assertGitHubApiUrl(url);
  const token = await installationToken(installationId);
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devasign-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${url}: ${await res.text()}`);
  }
  const body = (await res.json()) as T;
  return { body, nextUrl: parseNextLink(res.headers.get("link")) };
}

export function assertGitHubApiUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid GitHub API URL: ${url}`);
  }
  if (host !== "api.github.com") {
    throw new Error(`Refusing to send an installation token to ${host}`);
  }
}

export function parseNextLink(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// Look up a user's membership in an org via the installation token. Returns the
// role + state + the member's GitHub id, or null when the user isn't a member
// (404) or we can't see membership (403 — usually the App lacks the "Members"
// org read permission). Never throws; callers fail closed on null. The echoed
// `user.id` lets callers guard against a since-changed login that now maps to a
// different person.
export async function getOrgMembership(
  installationId: number,
  org: string,
  username: string
): Promise<{ state: string; role: string; userId: number } | null> {
  try {
    const m = await gh<any>(
      installationId,
      `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`
    );
    return { state: m?.state, role: m?.role, userId: m?.user?.id };
  } catch (err) {
    if (String(err).includes(" 403 ")) {
      console.warn(`[github] org membership check forbidden for ${org} — App may lack Members:read`, err);
    }
    return null;
  }
}

// Post a comment on a PR (the issues API — PRs are issues for commenting) and
// return the created comment's numeric id, or null on failure. Centralizes the
// "issues/{n}/comments" POST so plan/limit notices, the "review in progress"
// placeholder, and the verdict comment share one path. Best-effort: logs and
// swallows on failure so a commenting hiccup never breaks webhook/review handling.
export async function postPRCommentReturningId(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  body: string
): Promise<number | null> {
  try {
    const res = await gh<{ id: number }>(
      installationId,
      `/repos/${owner}/${name}/issues/${prNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      }
    );
    return typeof res?.id === "number" ? res.id : null;
  } catch (err) {
    console.warn(`[github] failed to post PR comment on ${owner}/${name}#${prNumber}:`, err);
    return null;
  }
}

// Fire-and-forget variant for callers that don't need the comment id (plan/cap
// notices). Delegates to postPRCommentReturningId so the POST lives in one place.
export async function postPRComment(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  body: string
): Promise<void> {
  await postPRCommentReturningId(installationId, owner, name, prNumber, body);
}

// Edit an existing PR/issue comment in place (the "review in progress" → verdict
// update). PATCHes /issues/comments/{id} — note this endpoint is keyed by comment
// id, not PR number. Best-effort: returns whether it succeeded, never throws.
export async function updatePRComment(
  installationId: number,
  owner: string,
  name: string,
  commentId: number,
  body: string
): Promise<boolean> {
  try {
    await gh(installationId, `/repos/${owner}/${name}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
    return true;
  } catch (err) {
    console.warn(`[github] failed to update PR comment ${owner}/${name}#${commentId}:`, err);
    return false;
  }
}

// Dismiss a PR review (our own earlier bodyless APPROVE) — PUT
// /pulls/{n}/reviews/{id}/dismissals. Used when a later commit fails review: we
// never submit REQUEST_CHANGES (its required body would render as an extra
// conversation comment), so withdrawing the stale approval is what keeps branch
// protection honest. Best-effort: returns whether it succeeded, never throws
// (404/422 when the review was already dismissed or deleted).
export async function dismissPRReview(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  reviewId: number,
  message: string
): Promise<boolean> {
  try {
    await gh(installationId, `/repos/${owner}/${name}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
      method: "PUT",
      body: JSON.stringify({ message }),
      headers: { "Content-Type": "application/json" },
    });
    return true;
  } catch (err) {
    console.warn(`[github] failed to dismiss review ${reviewId} on ${owner}/${name}#${prNumber}:`, err);
    return false;
  }
}

// Dispatch a GitHub Actions workflow (workflow_dispatch) — powers the optional
// "Run GitHub Action" node. `workflow` is the file name (e.g. "deploy.yml") or
// numeric id; `ref` is the branch/tag to run on (the PR head branch). The
// endpoint returns 204 with no body, so unlike gh() we don't parse JSON. Throws
// on !ok so the caller can log a non-fatal note (missing actions:write, or the
// workflow has no workflow_dispatch trigger → 422).
export async function dispatchWorkflow(
  installationId: number,
  owner: string,
  name: string,
  workflow: string,
  ref: string,
  inputs?: Record<string, string>
): Promise<void> {
  const token = await installationToken(installationId);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devasign-app",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, ...(inputs ? { inputs } : {}) }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `GitHub workflow_dispatch ${res.status} on ${owner}/${name} (${workflow}): ${await res.text()}`
    );
  }
}

// Raw (non-JSON) GitHub read — the PR diff, a file at a ref. Same token path as gh().
export async function ghText(installationId: number, path: string, headers: Record<string, string>): Promise<string> {
  const token = await installationToken(installationId);
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers, Authorization: `token ${token}`, "User-Agent": "devasign-app" },
  });
  if (!res.ok) throw new Error(`gh text ${res.status} on ${path}`);
  return res.text();
}

// Fire a repository_dispatch so the customer's verify workflow re-runs for a PR
// (needs the App's contents:write). Throws on a non-2xx so callers can record why.
export async function repositoryDispatch(
  installationId: number,
  owner: string,
  name: string,
  eventType: string,
  clientPayload: Record<string, unknown>
): Promise<void> {
  const token = await installationToken(installationId);
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devasign-app",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (!res.ok) throw new Error(`GitHub repository_dispatch ${res.status} on ${owner}/${name}: ${await res.text()}`);
}

// ── Git data helpers for the onboarding / adopt-test PRs (need contents:write) ──

export async function getBranchSha(installationId: number, owner: string, name: string, branch: string): Promise<string> {
  const b = await gh<{ commit?: { sha?: string } }>(installationId, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`);
  if (!b?.commit?.sha) throw new Error(`branch ${branch} not found on ${owner}/${name}`);
  return b.commit.sha;
}

/** Create `branch` at `sha`, or force it there when it already exists (a stale setup branch is ours to reset). */
export async function ensureBranch(installationId: number, owner: string, name: string, branch: string, sha: string): Promise<void> {
  const ref = `refs/heads/${branch}`;
  try {
    await gh(installationId, `/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, sha }),
    });
  } catch (err) {
    if (!/422/.test(err instanceof Error ? err.message : String(err))) throw err;
    await gh(installationId, `/repos/${owner}/${name}/git/${ref}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha, force: true }),
    });
  }
}

/** Create or update one file on `branch` via the contents API (one commit per file). */
export async function putFile(installationId: number, owner: string, name: string, branch: string, path: string, content: string, message: string): Promise<void> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  let sha: string | undefined;
  try {
    const cur = await gh<{ sha?: string }>(installationId, `/repos/${owner}/${name}/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
    sha = cur?.sha;
  } catch {
    sha = undefined; // new file
  }
  await gh(installationId, `/repos/${owner}/${name}/contents/${encoded}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) }),
  });
}

export async function readFileAtRef(installationId: number, owner: string, name: string, path: string, ref: string): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    return await ghText(installationId, `/repos/${owner}/${name}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { Accept: "application/vnd.github.raw" });
  } catch {
    return null;
  }
}

export async function createPullRequest(
  installationId: number,
  owner: string,
  name: string,
  args: { title: string; body: string; head: string; base: string }
): Promise<{ number: number; html_url: string }> {
  const pr = await gh<{ number: number; html_url: string }>(installationId, `/repos/${owner}/${name}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { number: pr.number, html_url: pr.html_url };
}

/** Names of the repo's Actions secrets, or null when the App cannot read them (needs secrets:read). */
export async function listRepoSecretNames(installationId: number, owner: string, name: string): Promise<string[] | null> {
  try {
    const res = await gh<{ secrets?: Array<{ name: string }> }>(installationId, `/repos/${owner}/${name}/actions/secrets?per_page=100`);
    return (res?.secrets ?? []).map((s) => s.name);
  } catch {
    return null;
  }
}
