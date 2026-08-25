// GitHub code search, treated as a capability to probe rather than an API to rely on.
// Installation-token support is undocumented, the limit is 10 req/min, and only the
// default branch is indexed — so every entry point degrades to [] instead of throwing.
import { installationToken } from "../../github/app.js";
import type { CodeSearchStatus } from "../../types.js";

export const MAX_QUERIES_PER_REVIEW = 4;
const WINDOW_MS = 60_000;
const WINDOW_BUDGET = 8; // of GitHub's 10/min, leaving headroom for concurrent reviews

export type CodeSearchHit = {
  fullName: string;
  path: string;
  sha: string;
  url?: string;
};

// Process-wide, because concurrent reviews share one installation's search quota.
const recentCalls: number[] = [];
let circuitOpenUntil = 0;

function withinBudget(now: number): boolean {
  while (recentCalls.length && now - recentCalls[0] > WINDOW_MS) recentCalls.shift();
  return recentCalls.length < WINDOW_BUDGET;
}

export function __resetCodeSearchLimiterForTests(): void {
  recentCalls.length = 0;
  circuitOpenUntil = 0;
}

async function rawSearch(
  installationId: number,
  q: string,
  perPage: number
): Promise<{ status: number; body: any; retryAfterMs: number }> {
  const token = await installationToken(installationId);
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devasign-app",
    },
  });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
  const reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
  const retryAfterMs = remaining <= 0 && reset > Date.now() ? reset - Date.now() : 0;
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, retryAfterMs };
}

export function buildSearchQuery(args: {
  needle: string;
  owner: string;
  isOrg: boolean;
  repo?: string;
  excludeRepo?: string;
}): string {
  const needle = args.needle.includes("/") ? `"${args.needle}"` : args.needle;
  if (args.repo) return `${needle} repo:${args.repo}`;
  const scope = args.isOrg ? `org:${args.owner}` : `user:${args.owner}`;
  const exclude = args.excludeRepo ? ` -repo:${args.excludeRepo}` : "";
  return `${needle} ${scope}${exclude}`;
}

// Through buildSearchQuery so the probe uses the same org:/user: scoping the real
// queries do — an org probed as `user:` is not the query we ship.
export function probeQuery(owner: string, isOrg: boolean): string {
  return owner ? buildSearchQuery({ needle: "devasign", owner, isOrg }) : "devasign";
}

// One canary query per topology build. The result is persisted on the topology row
// so the PR stage never pays to rediscover a 403.
export async function probeCodeSearch(
  installationId: number,
  owner: string,
  isOrg = false
): Promise<{ status: CodeSearchStatus; probedAt: number; note?: string }> {
  const probedAt = Date.now();
  try {
    const { status, body } = await rawSearch(installationId, probeQuery(owner, isOrg), 1);
    recentCalls.push(Date.now());
    if (status === 200) return { status: "ok", probedAt };
    if (status === 401 || status === 403) {
      const msg = typeof body?.message === "string" ? body.message : `HTTP ${status}`;
      return { status: "forbidden", probedAt, note: msg };
    }
    if (status === 422) return { status: "ok", probedAt, note: "probe query rejected; endpoint reachable" };
    return { status: "unavailable", probedAt, note: `HTTP ${status}` };
  } catch (err) {
    return { status: "unavailable", probedAt, note: String(err).slice(0, 200) };
  }
}

// Never throws and never blocks: a rate-limited or forbidden search yields [] and the
// caller falls back to the indexed-sibling lane.
export async function searchCode(
  installationId: number,
  q: string,
  opts: { perPage?: number } = {}
): Promise<CodeSearchHit[]> {
  const now = Date.now();
  if (now < circuitOpenUntil) return [];
  if (!withinBudget(now)) return [];
  recentCalls.push(now);
  try {
    const { status, body, retryAfterMs } = await rawSearch(installationId, q, opts.perPage ?? 10);
    if (status === 403 || status === 429) {
      circuitOpenUntil = Date.now() + Math.max(retryAfterMs, WINDOW_MS);
      return [];
    }
    if (status !== 200) return [];
    return (body?.items || [])
      .map((it: any) => ({
        fullName: it?.repository?.full_name || "",
        path: it?.path || "",
        sha: it?.sha || "",
        url: it?.html_url,
      }))
      .filter((h: CodeSearchHit) => h.fullName && h.path && h.sha);
  } catch {
    return [];
  }
}
