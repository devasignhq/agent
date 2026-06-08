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

type InstallationToken = { token: string; expires_at: string };

const installTokens = new Map<number, { token: string; expiresAt: number }>();

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
  installTokens.set(installationId, { token: body.token, expiresAt });
  return body.token;
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

// Post a comment on a PR (the issues API — PRs are issues for commenting).
// Centralizes the "issues/{n}/comments" POST so plan/limit notices and review
// comments share one path. Best-effort: logs and swallows on failure so a
// commenting hiccup never breaks webhook handling.
export async function postPRComment(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  body: string
): Promise<void> {
  try {
    await gh(installationId, `/repos/${owner}/${name}/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn(`[github] failed to post PR comment on ${owner}/${name}#${prNumber}:`, err);
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
