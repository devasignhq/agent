// Where are we running? Everything the API needs to match this job to a PR.
import { readFileSync } from "node:fs";
import path from "node:path";

export type RunContext = {
  cwd: string;
  onActions: boolean;
  repo: string; // owner/name
  event: string;
  pr: number;
  sha: string; // PR head sha, never the merge-ref sha
  runId: string;
  runAttempt: number;
  runnerOs: string;
  jobUrl?: string;
};

type Env = Record<string, string | undefined>;

export function readEventPayload(env: Env, read: (p: string) => string = (p) => readFileSync(p, "utf8")): any {
  const p = env.GITHUB_EVENT_PATH;
  if (!p) return null;
  try {
    return JSON.parse(read(p));
  } catch {
    return null;
  }
}

export function prAndShaFromEvent(event: string, payload: any): { pr?: number; sha?: string } {
  if (!payload || typeof payload !== "object") return {};
  if (event === "pull_request" || event === "pull_request_target") {
    return { pr: Number(payload.pull_request?.number) || undefined, sha: payload.pull_request?.head?.sha || undefined };
  }
  if (event === "repository_dispatch") {
    const cp = payload.client_payload || {};
    return { pr: Number(cp.pr) || undefined, sha: cp.sha || undefined };
  }
  if (event === "workflow_dispatch") {
    const inputs = payload.inputs || {};
    return { pr: Number(inputs.pr) || undefined, sha: inputs.sha || undefined };
  }
  return {};
}

export function readContext(opts: { env?: Env; cwd?: string; pr?: number; sha?: string; payload?: any } = {}): RunContext {
  const env = opts.env ?? process.env;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const event = env.GITHUB_EVENT_NAME || (opts.pr ? "workflow_dispatch" : "");
  const fromEvent = prAndShaFromEvent(event, opts.payload ?? readEventPayload(env));
  const pr = opts.pr ?? fromEvent.pr;
  const sha = opts.sha ?? fromEvent.sha;
  if (!pr || !sha) {
    throw new Error(
      "cannot determine the pull request: run on a pull_request event (or repository_dispatch with client_payload.pr/sha), or pass --pr and --sha"
    );
  }
  const repo = env.GITHUB_REPOSITORY || "";
  const runId = env.GITHUB_RUN_ID || String(Date.now());
  const server = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  return {
    cwd,
    onActions: env.GITHUB_ACTIONS === "true",
    repo,
    event: event || "workflow_dispatch",
    pr,
    sha,
    runId,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
    runnerOs: env.RUNNER_OS || process.platform,
    jobUrl: repo && env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
  };
}
